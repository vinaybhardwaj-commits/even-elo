// ============================================================================
// G2 — the only module that touches jose. Staff and portal (doctor) sessions
// are signed with separate secrets and carry separate `aud` claims, so a token
// minted for one surface can never verify on the other.
//
//   staff   STAFF_JWT_SECRET   aud "staff"   epi_session
//   portal  PORTAL_JWT_SECRET  aud "portal"  epi_physician_session
//   mcp     STAFF_JWT_SECRET   aud "mcp"     governance MCP OAuth tokens
//
// Rollback window: while JWT_LEGACY_ACCEPT_UNTIL (ISO time) is in the future,
// the verifiers ALSO accept pre-G2 tokens (signed with JWT_SECRET, no aud).
// Unset, unparsable or past = legacy rejected. Edge-safe (used by middleware).
// ============================================================================
import { SignJWT, jwtVerify, type JWTPayload as JosePayload } from "jose";

export type JwtAudience = "staff" | "portal" | "mcp";

const ALG = "HS256";
const SECRET_ENV: Record<JwtAudience, string> = {
  staff: "STAFF_JWT_SECRET",
  portal: "PORTAL_JWT_SECRET",
  mcp: "STAFF_JWT_SECRET",
};

function key(name: string): Uint8Array | null {
  const s = process.env[name];
  return s ? new TextEncoder().encode(s) : null;
}

/** True only while JWT_LEGACY_ACCEPT_UNTIL parses to a time in the future. */
export function legacyAcceptActive(now: number = Date.now()): boolean {
  const raw = process.env.JWT_LEGACY_ACCEPT_UNTIL;
  if (!raw) return false;
  const until = Date.parse(raw);
  return Number.isFinite(until) && now < until;
}

const MIN_SECRET_BYTES = 32;

/**
 * Signing guard: this surface's secret must be >= 32 bytes, and STAFF_JWT_SECRET
 * must differ from PORTAL_JWT_SECRET. Errors name the env vars only, never values.
 */
function assertSigningSecrets(name: string, k: Uint8Array): void {
  if (k.length < MIN_SECRET_BYTES) {
    throw new Error(`${name} must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  const staff = process.env.STAFF_JWT_SECRET;
  const portal = process.env.PORTAL_JWT_SECRET;
  if (staff && portal && staff === portal) {
    throw new Error("STAFF_JWT_SECRET and PORTAL_JWT_SECRET must be different");
  }
}

export async function signJwt(
  aud: JwtAudience,
  payload: Record<string, unknown>,
  expiresIn: string,
): Promise<string> {
  const name = SECRET_ENV[aud];
  const k = key(name);
  if (!k) throw new Error(`${name} environment variable is required`);
  assertSigningSecrets(name, k);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: ALG })
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(k);
}

/**
 * Verify a token for one audience. Returns null on any failure (missing secret,
 * bad signature, wrong alg, expired, wrong or missing aud).
 * `legacyOk` decides whether a pre-G2 payload (no aud, JWT_SECRET) is acceptable
 * for this surface; it is consulted only inside the legacy window.
 */
export async function verifyJwt(
  aud: JwtAudience,
  token: string,
  legacyOk: (p: JosePayload) => boolean,
): Promise<JosePayload | null> {
  const k = key(SECRET_ENV[aud]);
  if (k) {
    try {
      const { payload } = await jwtVerify(token, k, { algorithms: [ALG], audience: aud });
      return payload;
    } catch {
      /* fall through to the legacy window */
    }
  }
  if (!legacyAcceptActive()) return null;
  const old = key("JWT_SECRET");
  if (!old) return null;
  try {
    const { payload } = await jwtVerify(token, old, { algorithms: [ALG] });
    if (payload.aud !== undefined) return null;
    return legacyOk(payload) ? payload : null;
  } catch {
    return null;
  }
}

// Old shapes: a staff token never had `kind`; a portal token had kind:"physician";
// MCP tokens carried a `typ` claim.
const isOldStaff = (p: JosePayload) => p.kind === undefined && p.typ === undefined;
const isOldPortal = (p: JosePayload) => p.kind === "physician";
const isOldMcp = (p: JosePayload) => typeof p.typ === "string";

export const signStaffJwt = (payload: Record<string, unknown>, expiresIn: string) =>
  signJwt("staff", payload, expiresIn);
export const verifyStaffJwt = (token: string) => verifyJwt("staff", token, isOldStaff);

export const signPortalJwt = (payload: Record<string, unknown>, expiresIn: string) =>
  signJwt("portal", payload, expiresIn);
export const verifyPortalJwt = (token: string) => verifyJwt("portal", token, isOldPortal);

export const signMcpJwt = (payload: Record<string, unknown>, expiresIn: string) =>
  signJwt("mcp", payload, expiresIn);
export const verifyMcpJwt = (token: string) => verifyJwt("mcp", token, isOldMcp);
