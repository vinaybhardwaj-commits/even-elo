import { NextRequest, NextResponse } from "next/server";
import { ACTOR_ID_HEADER, ACTOR_ROLE_HEADER, SESSION_COOKIE } from "@/lib/zone/authorize";
import { isRmoOp } from "@/lib/screens/rmo-schema";
import { runRmo } from "@/lib/http-tools/rmo";

// RMO inbox (M2): read the inbox and, behind a confirm card plus the G3 second factor, author-stamp or release a
// finding. Calls even-elo's existing /api/rmo-inbox routes with the caller's session forwarded; fixed error codes only.
export const maxDuration = 60;

const MAX_BODY_BYTES = 2048;
const NO_STORE = { "Cache-Control": "no-store" };

const fail = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status, headers: NO_STORE });

export const POST = async (req: NextRequest, ctx: { params: Promise<{ op: string }> }) => {
  // src/proxy.ts has already authenticated the staff member and overwritten these headers.
  const staffId = req.headers.get(ACTOR_ID_HEADER);
  const role = req.headers.get(ACTOR_ROLE_HEADER);
  if (!staffId || !role) return fail(401, "unauthorized");

  const { op } = await ctx.params;
  if (!isRmoOp(op)) return fail(404, "unknown_op");

  let params: unknown;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return fail(422, "bad_params");
    params = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return fail(422, "bad_params");
  }

  const result = await runRmo(op, params, { staffId, role, sessionCookie: req.cookies.get(SESSION_COOKIE)?.value ?? null });
  return NextResponse.json(result.body, { status: result.status, headers: { ...NO_STORE, ...result.headers } });
};
