// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { authorizeStudioRequest, type LiveStaff, type ZoneRequest } from "../authorize";

const SECRET = "test-secret-not-real";
const key = new TextEncoder().encode(SECRET);
const ENV = { JWT_SECRET: SECRET, NODE_ENV: "production" };
const STAFF = "11111111-1111-4111-8111-111111111111";

async function session(claims: Record<string, unknown> = {}, opts: { alg?: "HS256" | "HS384"; secret?: Uint8Array; exp?: string | null } = {}) {
  const jwt = new SignJWT({ profileId: STAFF, status: "active", is_super_admin: true, ...claims })
    .setProtectedHeader({ alg: opts.alg ?? "HS256" })
    .setIssuedAt();
  if (opts.exp !== null) jwt.setExpirationTime(opts.exp ?? "1h");
  return jwt.sign(opts.secret ?? key);
}

async function req(over: Partial<ZoneRequest> & { token?: string | null } = {}): Promise<ZoneRequest> {
  const token = over.token === undefined ? await session() : over.token;
  const { token: _t, ...rest } = over;
  return {
    method: "GET",
    host: "governance.evenos.app",
    forwardedHost: null,
    origin: null,
    cookies: token ? { epi_session: token } : {},
    ...rest,
  };
}

const live = (v: LiveStaff | null) => ({ loadLiveStaff: vi.fn(async () => v) });
const SUPER: LiveStaff = { status: "active", is_super_admin: true, must_change_pin: false };

describe("studio auth zone", () => {
  it("admits an active super_admin and returns the staff id from the token", async () => {
    const d = await authorizeStudioRequest(await req(), ENV, live(SUPER));
    expect(d).toEqual({ ok: true, staffId: STAFF, role: "super_admin" });
  });

  it("401 without a session cookie", async () => {
    const d = await authorizeStudioRequest(await req({ token: null }), ENV, live(SUPER));
    expect(d).toMatchObject({ ok: false, status: 401 });
  });

  it("401 without JWT_SECRET (fail closed)", async () => {
    const d = await authorizeStudioRequest(await req(), { NODE_ENV: "production" }, live(SUPER));
    expect(d).toMatchObject({ ok: false, status: 401 });
  });

  it("401 for a token signed with another secret, another alg, or expired", async () => {
    const other = new TextEncoder().encode("another-secret");
    for (const token of [
      await session({}, { secret: other }),
      await session({}, { alg: "HS384" }),
      await session({}, { exp: "-10s" }),
      "not-a-jwt",
    ]) {
      const d = await authorizeStudioRequest(await req({ token }), ENV, live(SUPER));
      expect(d).toMatchObject({ ok: false, status: 401 });
    }
  });

  it("401 for a staff token with no exp claim (requiredClaims)", async () => {
    const d = await authorizeStudioRequest(await req({ token: await session({}, { exp: null }) }), ENV, live(SUPER));
    expect(d).toMatchObject({ ok: false, status: 401, reason: "bad-session" });
  });

  it("403 while the DB says the PIN must be changed (like the root middleware), whatever the token claims", async () => {
    const d = await authorizeStudioRequest(await req({ token: await session({ must_change_pin: false }) }), ENV, live({ ...SUPER, must_change_pin: true }));
    expect(d).toMatchObject({ ok: false, status: 403, reason: "must-change-pin" });
    // A stale token claim alone does not block when the DB says it is done.
    const ok = await authorizeStudioRequest(await req({ token: await session({ must_change_pin: true }) }), ENV, live(SUPER));
    expect(ok).toMatchObject({ ok: true });
  });

  it("401 for kind=physician tokens", async () => {
    const d = await authorizeStudioRequest(await req({ token: await session({ kind: "physician" }) }), ENV, live(SUPER));
    expect(d).toMatchObject({ ok: false, status: 401, reason: "physician-token" });
  });

  it("401 when ANY physician cookie is present, even beside a valid staff cookie", async () => {
    const r = await req();
    r.cookies.epi_physician_session = "anything";
    const l = live(SUPER);
    const d = await authorizeStudioRequest(r, ENV, l);
    expect(d).toMatchObject({ ok: false, status: 401, reason: "physician-cookie" });
    expect(l.loadLiveStaff).not.toHaveBeenCalled();
  });

  it("401 when the token has no profileId", async () => {
    const d = await authorizeStudioRequest(await req({ token: await session({ profileId: undefined }) }), ENV, live(SUPER));
    expect(d).toMatchObject({ ok: false, status: 401 });
  });

  it("re-reads the role from the DB on EVERY request, reads included, ignoring token claims", async () => {
    const l = live(SUPER);
    await authorizeStudioRequest(await req(), ENV, l);
    await authorizeStudioRequest(await req({ method: "GET" }), ENV, l);
    expect(l.loadLiveStaff).toHaveBeenCalledTimes(2);
    expect(l.loadLiveStaff).toHaveBeenCalledWith(STAFF);
    // Token says super admin; DB says revoked.
    const revoked = await authorizeStudioRequest(await req(), ENV, live({ status: "active", is_super_admin: false, must_change_pin: false }));
    expect(revoked).toMatchObject({ ok: false, status: 403 });
  });

  it("403 for a deactivated account and for non-super_admin staff", async () => {
    expect(await authorizeStudioRequest(await req(), ENV, live({ status: "suspended", is_super_admin: true, must_change_pin: false }))).toMatchObject({ ok: false, status: 403 });
    expect(await authorizeStudioRequest(await req(), ENV, live({ status: "active", is_super_admin: false, must_change_pin: false }))).toMatchObject({ ok: false, status: 403 });
  });

  it("401 when the DB cannot confirm the profile (fail closed)", async () => {
    expect(await authorizeStudioRequest(await req(), ENV, live(null))).toMatchObject({ ok: false, status: 401 });
  });

  describe("origin/host on non-GET", () => {
    const post = (o: Partial<ZoneRequest>) => req({ method: "POST", origin: "https://governance.evenos.app", ...o });

    it("allows a POST from governance.evenos.app", async () => {
      expect(await authorizeStudioRequest(await post({}), ENV, live(SUPER))).toMatchObject({ ok: true });
    });
    it("403 on missing Origin", async () => {
      expect(await authorizeStudioRequest(await post({ origin: null }), ENV, live(SUPER))).toMatchObject({ ok: false, status: 403 });
    });
    it("403 on a foreign Origin", async () => {
      expect(await authorizeStudioRequest(await post({ origin: "https://evil.example" }), ENV, live(SUPER))).toMatchObject({ ok: false, status: 403 });
      expect(await authorizeStudioRequest(await post({ origin: "https://governance.evenos.app.evil.example" }), ENV, live(SUPER))).toMatchObject({ ok: false, status: 403 });
      expect(await authorizeStudioRequest(await post({ origin: "not a url" }), ENV, live(SUPER))).toMatchObject({ ok: false, status: 403 });
    });
    it("403 on a foreign Host, and the forwarded host wins over Host", async () => {
      expect(await authorizeStudioRequest(await post({ host: "doctors.evenos.app" }), ENV, live(SUPER))).toMatchObject({ ok: false, status: 403 });
      expect(await authorizeStudioRequest(await post({ host: "studio-origin.internal", forwardedHost: "governance.evenos.app" }), ENV, live(SUPER))).toMatchObject({ ok: true });
      expect(await authorizeStudioRequest(await post({ forwardedHost: "evil.example" }), ENV, live(SUPER))).toMatchObject({ ok: false, status: 403 });
    });
    it("applies to PUT, PATCH and DELETE too", async () => {
      for (const method of ["PUT", "PATCH", "DELETE"]) {
        expect(await authorizeStudioRequest(await post({ method, origin: "https://evil.example" }), ENV, live(SUPER))).toMatchObject({ ok: false, status: 403 });
      }
    });
    it("localhost only outside production", async () => {
      const local = { host: "localhost:3000", origin: "http://localhost:3000" };
      expect(await authorizeStudioRequest(await post(local), { ...ENV, NODE_ENV: "development" }, live(SUPER))).toMatchObject({ ok: true });
      expect(await authorizeStudioRequest(await post(local), ENV, live(SUPER))).toMatchObject({ ok: false, status: 403 });
    });
    it("a physician cookie is still refused before the origin passes", async () => {
      const r = await post({});
      r.cookies.epi_physician_session = "x";
      expect(await authorizeStudioRequest(r, ENV, live(SUPER))).toMatchObject({ ok: false, status: 401 });
    });
  });
});
