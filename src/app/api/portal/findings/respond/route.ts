import { NextRequest, NextResponse } from "next/server";
import { getCurrentPhysician } from "@/lib/physician-auth";
import { sql } from "@/lib/db";
import {
  fetchDoctorReactions,
  toPortalSignal,
  type DoctorAuditSignal,
  type PortalReaction,
} from "@/lib/doctor-audits";
import { callResponse, mapRespondOutcome, parseRespondBody } from "@/lib/findings-actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/portal/findings/respond — WM2 v1: send the workflow response a finding asked for.
 *
 * ⚠️ THIS ONE LEAVES THE BUILDING. Unlike ../react, a response goes to the care manager, moves the
 * signal's status, and cannot be revised from the portal afterwards. The card says that in words
 * before the doctor presses anything, and `already_responded` says it again if they try twice.
 *
 * ⚠️ THE CLIENT NEVER NAMES A DOCTOR. `cdmss_doctor_uid` is looked up from the session's physician
 * id, and only four fields are read from the body — signal_id, type, verdict, comment. Nothing
 * else in a request can influence whose finding is answered.
 *
 * ⚠️ THE RETURNED SIGNAL GOES THROUGH THE SAME STRIP AS THE GET. CDMSS answers with a full signal,
 * which carries `doctor_uid`, `overdue` and `sla_due_at`. Handing that straight back would leak
 * through the write path the three things the read path spends a whitelist removing — so it is run
 * through `toPortalSignal` like everything else. `my_reaction` is re-read here so the card that
 * swaps this signal in does not lose a reaction the doctor already recorded.
 *
 * ⚠️ ALWAYS HTTP 200 (except 401). See ../react for why.
 *
 * ⚠️ INFERRED SQL: this sandbox has no live database. Both queries below are listed verbatim in the
 * ship report. The lookup mirrors ../route.ts; the audit insert mirrors ../../auth/login/route.ts.
 */

export async function POST(request: NextRequest) {
  const p = await getCurrentPhysician();
  if (!p) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  let uid: string | null = null;
  try {
    const rows = (await sql`
      SELECT cdmss_doctor_uid FROM physicians WHERE id=${p.physicianId}::uuid`) as unknown as Array<{
      cdmss_doctor_uid: string | null;
    }>;
    uid = rows[0]?.cdmss_doctor_uid ?? null;
  } catch {
    uid = null;
  }
  if (!uid) return NextResponse.json({ ok: false, error: "unmapped" });

  const parsed = parseRespondBody(await request.json().catch(() => null));
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: "invalid", message: parsed.message });
  }
  const { signalId, type, verdict, comment } = parsed;

  const result = mapRespondOutcome(
    await callResponse({ signalId, doctorUid: uid, type, verdict, comment }),
  );

  if (!result.ok) return NextResponse.json(result);

  // The response is recorded upstream; this row is the portal's record of it. Best-effort, same as
  // the login route. The COMMENT IS DELIBERATELY ABSENT: a doctor's explanation is clinical prose
  // that belongs in the governance thread it was written for, not copied into an audit log.
  try {
    await sql`INSERT INTO audit_log_v2 (action, entity_type, entity_id, after_json)
              VALUES ('portal_response', 'physician', ${p.physicianId},
              ${JSON.stringify({ signal_id: signalId, type, verdict })}::jsonb)`;
  } catch {
    // Intentionally ignored: see above.
  }

  // The doctor's own reaction is not part of the response contract, so it is re-read rather than
  // assumed. Best-effort: a reaction we could not confirm is rendered as none, never as stale.
  let myReaction: PortalReaction | null = null;
  try {
    const reactions = await fetchDoctorReactions(uid, p.physicianId);
    myReaction = reactions[signalId] ?? null;
  } catch {
    myReaction = null;
  }

  const s = result.signal;
  if (!s || typeof s !== "object") {
    // Upstream said yes but sent nothing renderable. Answer ok so the card does not report a
    // failure that did not happen; it refetches rather than swapping in a signal we do not have.
    return NextResponse.json({ ok: true, signal: null });
  }
  return NextResponse.json({ ok: true, signal: toPortalSignal(s as DoctorAuditSignal, myReaction) });
}
