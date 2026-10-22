// Studio auth zone (G1). PURE decision function: no I/O except the injected `loadLiveStaff`.
// The Next middleware (src/middleware.ts) is a thin wrapper around `authorizeStudioRequest`.
import { canAccessScreen, encodeRoles, screenForPath } from "./access";
import { staffJwtConfigured, verifyStaffSession, type StaffJwtEnv } from "./staff-jwt";

export const SESSION_COOKIE = "epi_session";
export const PHYSICIAN_COOKIE = "epi_physician_session";
export const ALLOWED_HOST = "governance.evenos.app";
// Internal headers the proxy sets for route handlers. Deliberately NOT x-* (CopilotKit forwards every
// x-* browser header to the agent); always overwritten, and any client copy is removed first.
export const ACTOR_ID_HEADER = "studio-internal-staff-id";
export const ACTOR_ROLE_HEADER = "studio-internal-staff-role";
// Client headers that must never reach the agent through CopilotKit's header forwarding.
export function isForbiddenClientHeader(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith("x-studio-") || n.startsWith("studio-internal-") || n === "authorization";
}

export interface LiveStaff {
  status: string;
  is_super_admin: boolean;
  is_sgc_member?: boolean;
  is_site_medical_head?: boolean;
  is_hr?: boolean;
  /** even-elo forces a PIN change on first login; the root middleware enforces it, so must we. */
  must_change_pin: boolean;
}

export interface ZoneRequest {
  method: string;
  /** Raw Host header. */
  host: string | null;
  /** First value of X-Forwarded-Host, set by the even-elo Vercel rewrite. */
  forwardedHost: string | null;
  origin: string | null;
  /** Path with the /studio basePath stripped. When present, the per-screen predicate for that path is enforced. */
  pathname?: string;
  /** Cookie name -> value (only the names matter here). */
  cookies: Record<string, string | undefined>;
}

export interface ZoneEnv extends StaffJwtEnv {
  NODE_ENV?: string;
}

export interface ZoneDeps {
  /** Reads the CURRENT role from the governance DB (read-only connection). null = not found / read failed. */
  loadLiveStaff: (profileId: string) => Promise<LiveStaff | null>;
}

export type ZoneDecision =
  | { ok: true; staffId: string; role: string }
  | { ok: false; status: 401 | 403; reason: string };

const deny = (status: 401 | 403, reason: string): ZoneDecision => ({ ok: false, status, reason });

const hostName = (h: string) => h.trim().toLowerCase().replace(/:\d+$/, "");

function isLocal(name: string): boolean {
  return name === "localhost" || name === "127.0.0.1";
}

/** Host allowed? governance.evenos.app always; localhost only when NODE_ENV is not production. */
export function isAllowedHostname(name: string, env: ZoneEnv): boolean {
  if (name === ALLOWED_HOST) return true;
  return env.NODE_ENV !== "production" && isLocal(name);
}

/** CSRF / host confusion guard for every non-GET: Host AND Origin must be an allowed host. */
export function checkOrigin(req: ZoneRequest, env: ZoneEnv): boolean {
  const effective = req.forwardedHost ?? req.host;
  if (!effective || !isAllowedHostname(hostName(effective), env)) return false;
  if (!req.origin) return false;
  let origin: URL;
  try {
    origin = new URL(req.origin);
  } catch {
    return false;
  }
  return isAllowedHostname(origin.hostname.toLowerCase(), env);
}

export async function authorizeStudioRequest(req: ZoneRequest, env: ZoneEnv, deps: ZoneDeps): Promise<ZoneDecision> {
  // 1. Origin/Host on every non-GET (HEAD is read-only like GET).
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && !checkOrigin(req, env)) return deny(403, "origin");

  // 2. A physician session cookie anywhere on the request is refused outright, even with a staff cookie.
  if (req.cookies[PHYSICIAN_COOKIE] !== undefined) return deny(401, "physician-cookie");

  // 3. Staff session JWT (G2): STAFF_JWT_SECRET, HS256, aud "staff", exp required; pre-G2 tokens only
  // inside the JWT_LEGACY_ACCEPT_UNTIL window (see staff-jwt.ts). Secrets from env only.
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return deny(401, "no-session");
  if (!staffJwtConfigured(env)) return deny(401, "not-configured");
  const verified = await verifyStaffSession(token, env);
  if (!verified) return deny(401, "bad-session");
  const payload = verified as Record<string, unknown>;
  if (payload.kind === "physician") return deny(401, "physician-token");
  const staffId = typeof payload.profileId === "string" ? payload.profileId : "";
  if (!staffId) return deny(401, "no-profile");

  // 4. Re-read the role from the DB on EVERY request. Token claims are never trusted.
  const live = await deps.loadLiveStaff(staffId);
  if (!live) return deny(401, "profile-unconfirmed");
  if (live.status !== "active") return deny(403, "inactive");
  if (live.must_change_pin) return deny(403, "must-change-pin");

  // Any active, non-pending staff member is admitted; WHICH screens and tools they get is decided per screen
  // (access.ts), server-side, from the role string built here out of the live row.
  const role = encodeRoles({
    super_admin: live.is_super_admin,
    sgc_member: live.is_sgc_member,
    site_medical_head: live.is_site_medical_head,
    hr: live.is_hr,
  });
  const screen = req.pathname ? screenForPath(req.pathname) : null;
  if (screen && !canAccessScreen(role, screen)) return deny(403, "role");
  return { ok: true, staffId, role };
}
