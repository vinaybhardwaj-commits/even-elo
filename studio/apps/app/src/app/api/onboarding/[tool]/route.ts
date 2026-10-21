import { NextRequest, NextResponse } from "next/server";
import { isOnboardingRead } from "@/lib/onboarding/schema";
import { runOnboardingRead } from "@/lib/onboarding/run";
import { onboardingActor } from "@/lib/onboarding/actor";

// VC onboarding screen reads. Same door as /api/screen/<tool> (typed params, role gate, studio_audit row,
// SourceTablePayload with its source line), but the data comes from the existing even-elo API routes with the
// staff session forwarded. See lib/onboarding/run.ts. Error bodies carry fixed codes only.
export const maxDuration = 60;

const MAX_BODY_BYTES = 4096;
const NO_STORE = { "Cache-Control": "no-store" };
const fail = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status, headers: NO_STORE });

export const POST = async (req: NextRequest, ctx: { params: Promise<{ tool: string }> }) => {
  const actor = onboardingActor(req);
  if (!actor) return fail(401, "unauthorized");
  const { tool } = await ctx.params;
  if (!isOnboardingRead(tool)) return fail(404, "unknown_tool");

  let params: unknown;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return fail(422, "bad_params");
    params = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return fail(422, "bad_params");
  }
  const result = await runOnboardingRead(tool, params, actor);
  const extra = "headers" in result ? result.headers : undefined;
  return NextResponse.json(result.body, { status: result.status, headers: { ...NO_STORE, ...extra } });
};
