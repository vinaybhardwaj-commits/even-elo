// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { authorizeStudioRequest, type LiveStaff, type ZoneRequest } from "../authorize";
import { legacyAcceptActive, staffJwtConfigured, verifyStaffSession } from "../staff-jwt";

const STAFF_SECRET = "staff-secret-not-real-aaaaaaaaaaaa";
const OLD_SECRET = "legacy-secret-not-real-bbbbbbbbbbbb";
const enc = (s: string) => new TextEncoder().encode(s);
const ID = "44444444-4444-4444-8444-444444444444";
const NOW = Date.parse("2026-10-20T00:00:00Z");
const FUTURE = "2026-10-27T00:00:00Z";
const PAST = "2026-10-10T00:00:00Z";

async function mint(opts: { secret?: string; alg?: string; aud?: string | string[] | null; claims?: Record<string, unknown>; exp?: string | null } = {}) {
  const j = new SignJWT({ profileId: ID, ...(opts.claims ?? {}) }).setProtectedHeader({ alg: (opts.alg ?? "HS256") as "HS256" }).setIssuedAt();
  if (opts.aud !== null) j.setAudience(opts.aud ?? "staff");
  if (opts.exp !== null) j.setExpirationTime(opts.exp ?? "1h");
  return j.sign(enc(opts.secret ?? STAFF_SECRET));
}
const base = { STAFF_JWT_SECRET: STAFF_SECRET };
const withWindow = (until?: string) => ({ ...base, JWT_SECRET: OLD_SECRET, ...(until === undefined ? {} : { JWT_LEGACY_ACCEPT_UNTIL: until }) });

describe("G2 staff session (aud staff, STAFF_JWT_SECRET)", () => {
  it("accepts a staff-audience token", async () => {
    expect((await verifyStaffSession(await mint(), base, NOW))?.profileId).toBe(ID);
  });

  it("rejects portal, mcp, other, array, empty and missing aud", async () => {
    for (const aud of ["portal", "mcp", "studio-agent", "STAFF", "", ["staff", "portal"], null] as const) {
      expect(await verifyStaffSession(await mint({ aud: aud as never }), base, NOW), JSON.stringify(aud)).toBeNull();
    }
  });

  it("rejects alg none, HS384, HS512, a wrong secret, expired and no-exp tokens", async () => {
    expect(await verifyStaffSession(await mint({ alg: "HS384" }), base, NOW)).toBeNull();
    expect(await verifyStaffSession(await mint({ alg: "HS512" }), base, NOW)).toBeNull();
    expect(await verifyStaffSession(await mint({ secret: "someone-elses-secret-0000000000" }), base, NOW)).toBeNull();
    expect(await verifyStaffSession(await mint({ exp: "-10s" }), base, NOW)).toBeNull();
    expect(await verifyStaffSession(await mint({ exp: null }), base, NOW)).toBeNull();
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const none = `${b64({ alg: "none", typ: "JWT" })}.${b64({ profileId: ID, aud: "staff", exp: Math.floor(NOW / 1000) + 3600 })}.`;
    expect(await verifyStaffSession(none, base, NOW)).toBeNull();
    expect(await verifyStaffSession("garbage", base, NOW)).toBeNull();
  });

  it("fails closed when STAFF_JWT_SECRET is missing or empty (and no legacy window)", async () => {
    const t = await mint();
    for (const env of [{}, { STAFF_JWT_SECRET: "" }, { JWT_SECRET: OLD_SECRET }, { STAFF_JWT_SECRET: undefined }]) {
      expect(await verifyStaffSession(t, env, NOW)).toBeNull();
      expect(staffJwtConfigured(env, NOW)).toBe(false);
    }
  });
});

describe("legacy rollback window (JWT_LEGACY_ACCEPT_UNTIL), both sides", () => {
  const oldToken = () => mint({ secret: OLD_SECRET, aud: null });

  it("accepts an old-shape token (JWT_SECRET, no aud) only while the deadline is in the future", async () => {
    expect((await verifyStaffSession(await oldToken(), withWindow(FUTURE), NOW))?.profileId).toBe(ID);
    for (const until of [PAST, undefined, "", "not-a-date", "NaN", "Infinity"]) {
      expect(await verifyStaffSession(await oldToken(), withWindow(until), NOW), String(until)).toBeNull();
    }
  });

  it("the deadline is compared at call time (before and after it)", async () => {
    const t = await oldToken();
    const env = withWindow("2026-10-20T12:00:00Z");
    expect(await verifyStaffSession(t, env, Date.parse("2026-10-20T11:59:59Z"))).not.toBeNull();
    expect(await verifyStaffSession(t, env, Date.parse("2026-10-20T12:00:00Z"))).toBeNull();
    expect(legacyAcceptActive(env, NOW)).toBe(true);
  });

  it("even inside the window rejects: JWT_SECRET with any aud, wrong shape, HS512, expired, no JWT_SECRET", async () => {
    const env = withWindow(FUTURE);
    for (const aud of ["staff", "portal", "mcp", "", ["staff"]]) {
      expect(await verifyStaffSession(await mint({ secret: OLD_SECRET, aud: aud as never }), env, NOW), JSON.stringify(aud)).toBeNull();
    }
    expect(await verifyStaffSession(await mint({ secret: OLD_SECRET, aud: null, claims: { kind: "physician" } }), env, NOW)).toBeNull();
    expect(await verifyStaffSession(await mint({ secret: OLD_SECRET, aud: null, claims: { typ: "mcp_access" } }), env, NOW)).toBeNull();
    expect(await verifyStaffSession(await mint({ secret: OLD_SECRET, aud: null, alg: "HS512" }), env, NOW)).toBeNull();
    expect(await verifyStaffSession(await mint({ secret: OLD_SECRET, aud: null, exp: "-10s" }), env, NOW)).toBeNull();
    expect(await verifyStaffSession(await oldToken(), { STAFF_JWT_SECRET: STAFF_SECRET, JWT_LEGACY_ACCEPT_UNTIL: FUTURE }, NOW)).toBeNull();
  });

  it("a new-style token still works inside the window, and works with only the legacy secret configured", async () => {
    expect(await verifyStaffSession(await mint(), withWindow(FUTURE), NOW)).not.toBeNull();
    const onlyOld = { JWT_SECRET: OLD_SECRET, JWT_LEGACY_ACCEPT_UNTIL: FUTURE };
    expect(staffJwtConfigured(onlyOld, NOW)).toBe(true);
    expect(await verifyStaffSession(await oldToken(), onlyOld, NOW)).not.toBeNull();
    expect(staffJwtConfigured({ JWT_SECRET: OLD_SECRET, JWT_LEGACY_ACCEPT_UNTIL: PAST }, NOW)).toBe(false);
  });
});

describe("through the zone: authorizeStudioRequest uses the G2 verifier", () => {
  const SUPER: LiveStaff = { status: "active", is_super_admin: true, must_change_pin: false };
  const live = () => ({ loadLiveStaff: vi.fn(async () => SUPER) });
  const request = (token: string): ZoneRequest => ({ method: "GET", host: "governance.evenos.app", forwardedHost: null, origin: null, cookies: { epi_session: token } });

  it("staff aud is admitted; portal / mcp / no-aud are 401", async () => {
    expect(await authorizeStudioRequest(request(await mint()), { ...base, NODE_ENV: "production" }, live())).toMatchObject({ ok: true });
    for (const aud of ["portal", "mcp", null] as const) {
      expect(await authorizeStudioRequest(request(await mint({ aud: aud as never })), { ...base, NODE_ENV: "production" }, live())).toMatchObject({ ok: false, status: 401, reason: "bad-session" });
    }
  });

  it("a pre-G2 token is admitted only inside the window (real clock: far-future vs past deadline)", async () => {
    const old = await mint({ secret: OLD_SECRET, aud: null });
    const open = { ...withWindow("2999-01-01T00:00:00Z"), NODE_ENV: "production" };
    const closed = { ...withWindow(PAST), NODE_ENV: "production" };
    expect(await authorizeStudioRequest(request(old), open, live())).toMatchObject({ ok: true });
    expect(await authorizeStudioRequest(request(old), closed, live())).toMatchObject({ ok: false, status: 401 });
  });

  it("no usable secret = 401 not-configured, DB never consulted", async () => {
    const l = live();
    expect(await authorizeStudioRequest(request(await mint()), { NODE_ENV: "production" }, l)).toMatchObject({ ok: false, status: 401, reason: "not-configured" });
    expect(l.loadLiveStaff).not.toHaveBeenCalled();
  });
});
