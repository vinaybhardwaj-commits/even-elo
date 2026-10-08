/**
 * Authentication for /api/admin/migrate (Round 2 / F3).
 *
 * Before: the route (and its GET) sat on the middleware's "URL is the gate" list with no check, so
 * anyone who knew the URL could run or read migrations. Now exactly two credentials open it:
 *
 *   1. a signed-in, active super_admin session, or
 *   2. `Authorization: Bearer ${ADMIN_MIGRATE_TOKEN}` (for deploy scripts; no session needed).
 *
 * Neither present = refused (401). An unset ADMIN_MIGRATE_TOKEN disables the bearer path, it never
 * makes it open: an empty or missing token can match nothing. The route stays on the middleware's
 * bootstrap list only so the bearer path can reach it without a cookie; the handler is the gate.
 */

import { NextResponse } from "next/server";

export type MigrateAuth =
  | { ok: true; via: "session" | "token" }
  | { ok: false; status: 401; error: "Unauthorized" };

/** Constant-time compare (same shape as cron-auth). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** PURE. Decide a migrate request from the header, the configured token and the staff session. */
export function checkMigrateAuth(
  authorization: string | null | undefined,
  token: string | undefined,
  user: { status?: unknown; is_super_admin?: unknown; kind?: unknown } | null | undefined,
): MigrateAuth {
  if (user && user.kind !== "physician" && user.status === "active" && user.is_super_admin === true) {
    return { ok: true, via: "session" };
  }
  if (token && token.length >= 16 && authorization && safeEqual(authorization, `Bearer ${token}`)) {
    return { ok: true, via: "token" };
  }
  return { ok: false, status: 401, error: "Unauthorized" };
}

/** Route guard: a response to send when refused, null when the request may proceed. */
export function migrateDenied(auth: MigrateAuth): NextResponse | null {
  if (auth.ok) return null;
  if (!process.env.ADMIN_MIGRATE_TOKEN) {
    console.error("[migrate-auth] ADMIN_MIGRATE_TOKEN is not set; only a super_admin session can run migrations");
  }
  return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
}
