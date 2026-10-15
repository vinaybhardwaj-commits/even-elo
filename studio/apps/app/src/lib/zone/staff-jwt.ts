// Staff session verification for the Studio zone, mirroring even-elo's G2 staff JWT (src/lib/jwt.ts on
// gov/g2-jwt-split 65cd77d). SEMANTICS are copied, not code: the apps share no imports.
//
//   epi_session is signed with STAFF_JWT_SECRET, alg HS256 only, aud "staff" (portal / mcp / missing aud
//   are rejected), exp required.
//   Rollback window: only while JWT_LEGACY_ACCEPT_UNTIL (ISO time) is in the future, a pre-G2 token is
//   also accepted: signed with JWT_SECRET, HS256, NO aud, old staff shape (no `kind`, no `typ`).
//   Unset / unparsable / past = legacy rejected. Missing secrets fail closed. The deadline is re-read on
//   every call.
import { jwtVerify, type JWTPayload } from "jose";

export interface StaffJwtEnv {
  STAFF_JWT_SECRET?: string;
  JWT_SECRET?: string;
  JWT_LEGACY_ACCEPT_UNTIL?: string;
}

const key = (s?: string) => (s ? new TextEncoder().encode(s) : null);

/** True only while JWT_LEGACY_ACCEPT_UNTIL parses to a time in the future. */
export function legacyAcceptActive(env: StaffJwtEnv, now: number = Date.now()): boolean {
  const raw = env.JWT_LEGACY_ACCEPT_UNTIL;
  if (!raw) return false;
  const until = Date.parse(raw);
  return Number.isFinite(until) && now < until;
}

/** Is any secret usable at all? (A fail-closed "not configured" distinction, not an auth decision.) */
export function staffJwtConfigured(env: StaffJwtEnv, now: number = Date.now()): boolean {
  return !!env.STAFF_JWT_SECRET || (legacyAcceptActive(env, now) && !!env.JWT_SECRET);
}

const isOldStaff = (p: JWTPayload) => (p as Record<string, unknown>).kind === undefined && (p as Record<string, unknown>).typ === undefined;

/** The verified payload, or null on any failure. */
export async function verifyStaffSession(token: string, env: StaffJwtEnv, now: number = Date.now()): Promise<JWTPayload | null> {
  const k = key(env.STAFF_JWT_SECRET);
  if (k) {
    try {
      const { payload } = await jwtVerify(token, k, { algorithms: ["HS256"], audience: "staff", requiredClaims: ["exp"] });
      // Stricter than jose's "aud contains staff": the claim must be exactly "staff" (even-elo signs a string).
      if (payload.aud !== "staff") return null;
      return payload;
    } catch {
      /* fall through to the legacy window */
    }
  }
  if (!legacyAcceptActive(env, now)) return null;
  const old = key(env.JWT_SECRET);
  if (!old) return null;
  try {
    const { payload } = await jwtVerify(token, old, { algorithms: ["HS256"], requiredClaims: ["exp"] });
    if (payload.aud !== undefined) return null; // a new-style token must not ride the old secret
    return isOldStaff(payload) ? payload : null;
  } catch {
    return null;
  }
}
