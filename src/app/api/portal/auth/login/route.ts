import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { createPhysicianToken, setPhysicianCookie, verifyPortalPin } from "@/lib/physician-auth";
import {
  RATE_LIMIT_MESSAGE,
  checkLoginAllowed,
  clearAccountFailures,
  clientIp,
  recordLoginFailure,
  type SqlTag,
} from "@/lib/portal-login-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

export async function POST(request: NextRequest) {
  const { email, pin } = (await request.json().catch(() => ({}))) as { email?: string; pin?: string };
  if (!email || !pin) return NextResponse.json({ ok: false, error: "Email and PIN are required" }, { status: 400, headers: NO_STORE });

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const limiter = sql as unknown as SqlTag;

  // A3: throttle BEFORE touching the PIN. 5 failures per account and 20 per IP in 15 minutes, kept
  // in Postgres so every serverless instance sees the same count.
  const account = String(email).toLowerCase().trim();
  const ip = clientIp(request.headers);
  const gate = await checkLoginAllowed(limiter, account, ip);
  if (!gate.allowed) {
    return NextResponse.json(
      { ok: false, error: RATE_LIMIT_MESSAGE },
      { status: 429, headers: { ...NO_STORE, "Retry-After": "900" } },
    );
  }
  const fail = async (body: { ok: false; error: string }, status: number) => {
    await recordLoginFailure(limiter, account, ip);
    return NextResponse.json(body, { status, headers: NO_STORE });
  };

  const rows = (await sql`
    SELECT id::text AS id, full_name, email, portal_pin_hash, portal_access, portal_must_change_pin, current_status
    FROM physicians WHERE lower(email) = ${account} LIMIT 1
  `) as Array<Record<string, unknown>>;
  if (rows.length === 0) return fail({ ok: false, error: "No portal account found with this email." }, 401);
  const p = rows[0];

  if (!p.portal_access) return fail({ ok: false, error: "No PIN set for this account yet. Use ‘Email me a PIN’ below to get one." }, 403);
  if (p.current_status !== "active") return fail({ ok: false, error: "This account is not active." }, 403);
  if (!p.portal_pin_hash) return fail({ ok: false, error: "No PIN set for this account yet. Use ‘Email me a PIN’ below to get one." }, 403);

  const ok = await verifyPortalPin(String(pin), p.portal_pin_hash as string);
  if (!ok) return fail({ ok: false, error: "Incorrect PIN." }, 401);

  await clearAccountFailures(limiter, account);

  const token = await createPhysicianToken({
    kind: "physician", physicianId: p.id as string, email: p.email as string,
    full_name: p.full_name as string, portal_must_change_pin: Boolean(p.portal_must_change_pin),
  });
  await setPhysicianCookie(token);

  // The sign-in is already done — the cookie is set and the doctor is in. This row is the record of
  // it, not a step in it, so a failing audit write must cost them nothing. Swallow and continue:
  // losing one audit row is a gap in the log, while throwing here would lock out a physician who
  // typed the right PIN. Mirrors the audit_log_v2 insert in ../request-pin/route.ts.
  try {
    await sql`INSERT INTO audit_log_v2 (action, entity_type, entity_id, after_json)
              VALUES ('portal_login', 'physician', ${p.id as string},
              ${JSON.stringify({ email: p.email as string, via: "portal" })}::jsonb)`;
  } catch {
    // Intentionally ignored: see above.
  }

  return NextResponse.json({ ok: true, must_change_pin: Boolean(p.portal_must_change_pin) }, { headers: NO_STORE });
}
