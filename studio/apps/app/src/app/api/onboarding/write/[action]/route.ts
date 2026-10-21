import { NextRequest, NextResponse } from "next/server";
import { isOnboardingWrite } from "@/lib/onboarding/schema";
import { runOnboardingWrite } from "@/lib/onboarding/run";
import { onboardingActor } from "@/lib/onboarding/actor";

// Confirmed VC onboarding writes (confirm cards only; the chat agent has no route here). Each action maps to
// ONE existing even-elo route, called with the staff session forwarded. Needs the G3 second factor, which does not
// exist yet: until it does every call answers 403 needs_second_factor and sends nothing upstream.
// src/proxy.ts has already checked Host and Origin on this non-GET request.
export const maxDuration = 60;

const MAX_BODY_BYTES = 16_384;
const NO_STORE = { "Cache-Control": "no-store" };
const fail = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status, headers: NO_STORE });

export const POST = async (req: NextRequest, ctx: { params: Promise<{ action: string }> }) => {
  const actor = onboardingActor(req);
  if (!actor) return fail(401, "unauthorized");
  const { action } = await ctx.params;
  if (!isOnboardingWrite(action)) return fail(404, "unknown_action");

  let params: unknown;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return fail(422, "bad_params");
    params = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return fail(422, "bad_params");
  }
  const result = await runOnboardingWrite(action, params, actor);
  const extra = "headers" in result ? result.headers : undefined;
  return NextResponse.json(result.body, { status: result.status, headers: { ...NO_STORE, ...extra } });
};
