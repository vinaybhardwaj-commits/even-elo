import { NextRequest, NextResponse } from "next/server";
import { ACTOR_ID_HEADER, ACTOR_ROLE_HEADER, SESSION_COOKIE } from "@/lib/zone/authorize";
import { forwardRuling } from "@/lib/rulings/forward";

// Record a governance ruling on an audit thread (M2). Not an agent tool: only the typed confirm card on the thread
// screen calls this, with the user's own click. It forwards to even-elo's existing ruling route with the user's staff
// session. No autosave, no SQL here. Refused (403 second_factor_required) until the G3 second factor exists.

export const maxDuration = 30;
const MAX_BODY_BYTES = 4096;
const NO_STORE = { "Cache-Control": "no-store" };

export const POST = async (req: NextRequest, ctx: { params: Promise<{ reference: string }> }) => {
  // src/proxy.ts has already authenticated the staff member (super_admin) and overwritten these headers.
  if (!req.headers.get(ACTOR_ID_HEADER) || !req.headers.get(ACTOR_ROLE_HEADER)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  const { reference } = await ctx.params;
  let rawBody: unknown = null;
  try {
    const raw = await req.text();
    if (raw.length <= MAX_BODY_BYTES) rawBody = JSON.parse(raw);
  } catch {
    rawBody = null;
  }
  const out = await forwardRuling({ reference, rawBody, sessionCookie: req.cookies.get(SESSION_COOKIE)?.value ?? null });
  return NextResponse.json(out.body, { status: out.status, headers: NO_STORE });
};
