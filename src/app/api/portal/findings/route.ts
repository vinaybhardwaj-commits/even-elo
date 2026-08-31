import { NextResponse } from "next/server";
import { getCurrentPhysician } from "@/lib/physician-auth";
import { sql } from "@/lib/db";
import { fetchDoctorAudits, toPortalPayload } from "@/lib/doctor-audits";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/portal/findings — WM2 v0: the governance findings routed to the signed-in physician.
 *
 * READ-ONLY. There is no POST, no PATCH, and no response path of any kind. A doctor who wants to
 * answer a finding does so through their care manager until in-portal responses ship.
 *
 * ⚠️ THREE FAILURES, THREE DIFFERENT ANSWERS — and none of them is an empty list ────────────────
 *
 *   · not signed in        → 401. The only status code this route ever refuses with.
 *   · no cdmss_doctor_uid  → { ok:true, mapped:false } — we know who you are, governance has not
 *                            linked your record yet. A real, explainable state.
 *   · upstream unreachable → { ok:false, mapped:true, error:'upstream_unavailable' } at HTTP 200.
 *
 * The last one is the point of this route's design. A 500 would surface as a broken panel, and an
 * empty `signals: []` would read as "you have no findings" — which is a claim we cannot make when
 * we could not reach the system that knows. So the failure is named in the body, the transport
 * stays 200, and the panel says so in words.
 *
 * The identity lookup is fail-safe for the same reason in the other direction: if the physicians
 * table read throws, we fall back to the UNMAPPED state rather than to a 500. Unmapped is the
 * honest answer to "we could not establish your CDMSS identity", whatever the cause.
 *
 * ⚠️ INFERRED SQL: this sandbox has no live database. The one query below is listed verbatim in the
 * ship report. It mirrors the existing lookup in api/physicians/[id]/opd-signals, tagged-template
 * form, and reads exactly one column.
 */
export async function GET() {
  const p = await getCurrentPhysician();
  if (!p) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  // The JWT does not carry the CDMSS identifier — it is looked up per request, never cached into
  // the token, so a governance re-link takes effect on the next page load rather than the next login.
  let uid: string | null = null;
  try {
    const rows = (await sql`
      SELECT cdmss_doctor_uid FROM physicians WHERE id=${p.physicianId}::uuid`) as unknown as Array<{
      cdmss_doctor_uid: string | null;
    }>;
    uid = rows[0]?.cdmss_doctor_uid ?? null;
  } catch {
    uid = null; // fail-safe → the unmapped state, never a 500
  }
  if (!uid) return NextResponse.json({ ok: true, mapped: false, signals: [] });

  try {
    const upstream = await fetchDoctorAudits(uid, { window: 90, status: "all" });
    // toPortalPayload is where `metrics`, per-signal `overdue`/`sla_due_at`, and the doctor's uid
    // are dropped — by whitelist, so nothing upstream adds later can leak through this route.
    return NextResponse.json(toPortalPayload(upstream));
  } catch {
    return NextResponse.json({ ok: false, mapped: true, error: "upstream_unavailable" });
  }
}
