import { NextRequest, NextResponse } from "next/server";
import { getCurrentPhysician } from "@/lib/physician-auth";
import { recordDoctorFindingResponse } from "@/lib/document-audits-db";
import { disabledWrite, respondEnabled } from "@/lib/portal-flags";
import { friendlyError } from "@/lib/finding-labels";
import { normalizeComment } from "@/lib/findings-actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VERBS = new Set(["agree", "disagree", "needs_clarification"]);

/**
 * POST /api/portal/document-audits/respond — a physician responds to one of their findings.
 *
 * Body: `{ finding_id, verb, comment? }`. A disagreement or a request for clarification needs a
 * comment (the same rule as the live Findings response). A finding can be answered once. Every
 * failure is a plain sentence in `message`; the code in `error` is for the client's logic only.
 */
export async function POST(request: NextRequest) {
  const p = await getCurrentPhysician();
  if (!p) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!respondEnabled()) return disabledWrite();

  let body: { finding_id?: unknown; verb?: unknown; comment?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json", message: friendlyError("invalid_json") });
  }

  const findingId = typeof body.finding_id === "string" ? body.finding_id : "";
  const verb = typeof body.verb === "string" ? body.verb : "";
  const comment = normalizeComment(body.comment);
  const needsComment = verb === "disagree" || verb === "needs_clarification";
  if (!findingId || !VERBS.has(verb) || (needsComment && !comment)) {
    return NextResponse.json({ ok: false, error: "invalid_body", message: friendlyError("invalid_body") });
  }

  const result = await recordDoctorFindingResponse({
    findingId,
    physicianId: p.physicianId,
    verb: verb as "agree" | "disagree" | "needs_clarification",
    comment,
  });

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error, message: friendlyError(result.error) });
  }
  return NextResponse.json({ ok: true });
}
