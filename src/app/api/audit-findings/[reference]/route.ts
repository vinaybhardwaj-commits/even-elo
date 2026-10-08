import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff-guard";
import { loadThread } from "@/lib/audit-findings-server";
import { isAuditReference } from "@/lib/cdmss-governance";
import { ACTION_CHOICE, allowedActions } from "@/lib/audit-findings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * GET /api/audit-findings/[reference] — one thread for governance: the finding content, every
 * instance, the doctor's response and the full event timeline in plain words with actor and time.
 * Staff only (see ../route.ts). `actions` lists only the rulings the thread's status allows.
 */
export async function GET(_req: NextRequest, { params }: { params: { reference: string } }) {
  const gate = await requireStaff("view");
  if (!gate.ok) return gate.response;

  const reference = decodeURIComponent(params.reference || "");
  if (!isAuditReference(reference)) {
    return NextResponse.json({ ok: false, error: "invalid", message: "That is not a thread reference." }, { status: 400 });
  }
  const loaded = await loadThread(reference);
  if (!loaded.ok) {
    if (loaded.notFound) return NextResponse.json({ ok: false, error: "not_found", message: "CDMSS does not know this thread." }, { status: 404 });
    return NextResponse.json(
      { ok: false, error: "cdmss_unavailable", message: "CDMSS did not answer. The thread cannot be shown right now." },
      { status: 502 },
    );
  }
  const d = loaded.detail;
  const canRule = gate.user.is_super_admin === true || gate.user.is_site_medical_head === true;
  return NextResponse.json({
    ok: true,
    thread: d.row,
    instances: d.instances,
    timeline: d.timeline,
    can_rule: canRule,
    actions: canRule ? allowedActions(d.row.status).map((a) => ({ action: a, ...ACTION_CHOICE[a] })) : [],
  });
}
