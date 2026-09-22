import { NextRequest, NextResponse } from "next/server";
import { getCurrentPhysician } from "@/lib/physician-auth";
import { recordDoctorFindingResponse } from "@/lib/document-audits-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VERBS = new Set(["agree", "disagree", "needs_clarification"]);

/**
 * POST /api/portal/document-audits/respond — physician remediates a routed finding.
 */
export async function POST(request: NextRequest) {
  const p = await getCurrentPhysician();
  if (!p) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  let body: { finding_id?: unknown; verb?: unknown; comment?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" });
  }

  const findingId = typeof body.finding_id === "string" ? body.finding_id : "";
  const verb = typeof body.verb === "string" ? body.verb : "";
  const comment = typeof body.comment === "string" ? body.comment.trim() : null;
  if (!findingId || !VERBS.has(verb)) {
    return NextResponse.json({ ok: false, error: "invalid_body" });
  }

  const result = await recordDoctorFindingResponse({
    findingId,
    physicianId: p.physicianId,
    verb: verb as "agree" | "disagree" | "needs_clarification",
    comment: comment || null,
  });

  if (!result.ok) return NextResponse.json({ ok: false, error: result.error });
  return NextResponse.json({ ok: true });
}
