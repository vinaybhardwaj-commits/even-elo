// Studio auth zone (G1). PURE decision function: no I/O except the injected `loadLiveStaff`.
// The Next middleware (src/middleware.ts) is a thin wrapper around `authorizeStudioRequest`.
import { jwtVerify } from "jose";

export const SESSION_COOKIE = "epi_session";
export const PHYSICIAN_COOKIE = "epi_physician_session";
export const ALLOWED_HOST = "governance.evenos.app";
// Headers the middleware sets for route handlers. Always stripped from inbound requests first.
export const ACTOR_ID_HEADER = "x-studio-staff-id";
export const ACTOR_ROLE_HEADER = "x-studio-staff-role";

export interface LiveStaff {
  status: string;
  is_super_admin: boolean;
}

export interface ZoneRequest {
  method: string;
  /** Raw Host header. */
  host: string | null;
  /** First value of X-Forwarded-Host, set by the even-elo Vercel rewrite. */
  forwardedHost: string | null;
  origin: string | null;
  /** Cookie name -> value (only the names matter here). */
  cookies: Record<string, string | undefined>;
}

export interface ZoneEnv {
  JWT_SECRET?: string;
  NODE_ENV?: string;
}

export interface ZoneDeps {
  /** Reads the CURRENT role from the governance DB (read-only connection). null = not found / read failed. */
  loadLiveStaff: (profileId: string) => Promise<LiveStaff | null>;
}

export type ZoneDecision =
  | { ok: true; staffId: string; role: "super_admin" }
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

  // 3. Staff session JWT: HS256 only, secret from env only.
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return deny(401, "no-session");
  if (!env.JWT_SECRET) return deny(401, "not-configured");
  let payload: Record<string, unknown>;
  try {
    const res = await jwtVerify(token, new TextEncoder().encode(env.JWT_SECRET), { algorithms: ["HS256"] });
    payload = res.payload as Record<string, unknown>;
  } catch {
    return deny(401, "bad-session");
  }
  if (payload.kind === "physician") return deny(401, "physician-token");
  const staffId = typeof payload.profileId === "string" ? payload.profileId : "";
  if (!staffId) return deny(401, "no-profile");

  // 4. Re-read the role from the DB on EVERY request. Token claims are never trusted.
  const live = await deps.loadLiveStaff(staffId);
  if (!live) return deny(401, "profile-unconfirmed");
  if (live.status !== "active") return deny(403, "inactive");
  if (!live.is_super_admin) return deny(403, "role"); // M0-S2: super_admin only

  return { ok: true, staffId, role: "super_admin" };
}
