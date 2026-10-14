import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SignJWT } from "jose";
import { signStaffJwt, verifyStaffJwt, signPortalJwt, verifyPortalJwt, signMcpJwt, verifyMcpJwt, legacyAcceptActive } from "@/lib/jwt";

const enc = (s: string) => new TextEncoder().encode(s);
const STAFF = "staff-secret-aaaaaaaaaaaaaaaaaaaaaaaa";
const PORTAL = "portal-secret-bbbbbbbbbbbbbbbbbbbbbbb";
const OLD = "old-shared-secret-cccccccccccccccccc";

const saved = { ...process.env };
beforeEach(() => {
  process.env.STAFF_JWT_SECRET = STAFF;
  process.env.PORTAL_JWT_SECRET = PORTAL;
  process.env.JWT_SECRET = OLD;
  delete process.env.JWT_LEGACY_ACCEPT_UNTIL;
});
afterEach(() => {
  process.env = { ...saved };
});

const raw = (secret: string, payload: Record<string, unknown>, o: { aud?: string; alg?: "HS256" | "HS384"; exp?: string | number } = {}) => {
  let j = new SignJWT(payload).setProtectedHeader({ alg: o.alg ?? "HS256" }).setIssuedAt().setExpirationTime(o.exp ?? "1h");
  if (o.aud) j = j.setAudience(o.aud);
  return j.sign(enc(secret));
};

describe("audience split", () => {
  it("round-trips each surface", async () => {
    expect((await verifyStaffJwt(await signStaffJwt({ profileId: "p1" }, "1h")))?.profileId).toBe("p1");
    expect((await verifyPortalJwt(await signPortalJwt({ kind: "physician" }, "1h")))?.kind).toBe("physician");
    expect((await verifyMcpJwt(await signMcpJwt({ typ: "mcp_access" }, "1h")))?.typ).toBe("mcp_access");
  });

  it("staff verifier rejects a portal token", async () => {
    expect(await verifyStaffJwt(await signPortalJwt({ kind: "physician" }, "1h"))).toBeNull();
  });

  it("portal verifier rejects a staff token", async () => {
    expect(await verifyPortalJwt(await signStaffJwt({ profileId: "p1" }, "1h"))).toBeNull();
  });

  it("rejects a portal-aud token even if signed with the staff secret (and vice versa)", async () => {
    expect(await verifyStaffJwt(await raw(STAFF, {}, { aud: "portal" }))).toBeNull();
    expect(await verifyPortalJwt(await raw(PORTAL, {}, { aud: "staff" }))).toBeNull();
  });

  it("rejects mcp tokens on the staff verifier and staff tokens on the mcp verifier (shared secret)", async () => {
    expect(await verifyStaffJwt(await signMcpJwt({ typ: "mcp_access" }, "1h"))).toBeNull();
    expect(await verifyMcpJwt(await signStaffJwt({}, "1h"))).toBeNull();
  });

  it("rejects tokens without aud", async () => {
    expect(await verifyStaffJwt(await raw(STAFF, { profileId: "p1" }))).toBeNull();
    expect(await verifyPortalJwt(await raw(PORTAL, { kind: "physician" }))).toBeNull();
  });

  it("rejects expired tokens", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect(await verifyStaffJwt(await raw(STAFF, {}, { aud: "staff", exp: past }))).toBeNull();
    expect(await verifyPortalJwt(await raw(PORTAL, {}, { aud: "portal", exp: past }))).toBeNull();
  });

  it("rejects the wrong algorithm", async () => {
    expect(await verifyStaffJwt(await raw(STAFF, {}, { aud: "staff", alg: "HS384" }))).toBeNull();
    expect(await verifyPortalJwt(await raw(PORTAL, {}, { aud: "portal", alg: "HS384" }))).toBeNull();
  });

  it("rejects garbage and a wrong signature", async () => {
    expect(await verifyStaffJwt("not.a.jwt")).toBeNull();
    expect(await verifyStaffJwt(await raw("some-other-secret-dddddddddddddddd", {}, { aud: "staff" }))).toBeNull();
  });

  it("fails closed when a secret is unset; sign throws", async () => {
    const t = await signStaffJwt({}, "1h");
    delete process.env.STAFF_JWT_SECRET;
    expect(await verifyStaffJwt(t)).toBeNull();
    await expect(signStaffJwt({}, "1h")).rejects.toThrow(/STAFF_JWT_SECRET/);
  });
});

describe("legacy window (JWT_LEGACY_ACCEPT_UNTIL)", () => {
  const future = () => new Date(Date.now() + 3600_000).toISOString();
  const past = () => new Date(Date.now() - 3600_000).toISOString();
  const oldStaff = () => raw(OLD, { profileId: "p1", status: "active" });
  const oldPortal = () => raw(OLD, { kind: "physician", physicianId: "d1" });

  it("default unset: legacy tokens are rejected", async () => {
    expect(legacyAcceptActive()).toBe(false);
    expect(await verifyStaffJwt(await oldStaff())).toBeNull();
    expect(await verifyPortalJwt(await oldPortal())).toBeNull();
  });

  it("before the deadline: old JWT_SECRET tokens are accepted", async () => {
    process.env.JWT_LEGACY_ACCEPT_UNTIL = future();
    expect((await verifyStaffJwt(await oldStaff()))?.profileId).toBe("p1");
    expect((await verifyPortalJwt(await oldPortal()))?.physicianId).toBe("d1");
  });

  it("after the deadline: legacy rejected again", async () => {
    process.env.JWT_LEGACY_ACCEPT_UNTIL = past();
    expect(await verifyStaffJwt(await oldStaff())).toBeNull();
    expect(await verifyPortalJwt(await oldPortal())).toBeNull();
  });

  it("an unparsable deadline means legacy rejected", async () => {
    process.env.JWT_LEGACY_ACCEPT_UNTIL = "soon";
    expect(await verifyStaffJwt(await oldStaff())).toBeNull();
  });

  it("legacy window does not cross the surfaces", async () => {
    process.env.JWT_LEGACY_ACCEPT_UNTIL = future();
    expect(await verifyStaffJwt(await oldPortal())).toBeNull();
    expect(await verifyPortalJwt(await oldStaff())).toBeNull();
  });

  it("legacy window never admits an old-secret token that carries an aud", async () => {
    process.env.JWT_LEGACY_ACCEPT_UNTIL = future();
    expect(await verifyStaffJwt(await raw(OLD, { profileId: "p1" }, { aud: "portal" }))).toBeNull();
  });

  it("new tokens still verify inside the window", async () => {
    process.env.JWT_LEGACY_ACCEPT_UNTIL = future();
    expect(await verifyStaffJwt(await signStaffJwt({ profileId: "p2" }, "1h"))).not.toBeNull();
  });
});
