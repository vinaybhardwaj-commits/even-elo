// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { ACTOR_AUDIENCE, agentHeaders, mintActorToken } from "../actor-token";

const SECRET = "actor-secret-not-real";

describe("actor token", () => {
  it("is HS256 with sub, role, aud, iat, exp<=60s and a unique jti", async () => {
    const a = await mintActorToken("staff-1", "super_admin", SECRET, 1_000_000);
    const b = await mintActorToken("staff-1", "super_admin", SECRET, 1_000_000);
    expect(decodeProtectedHeader(a).alg).toBe("HS256");
    const p = decodeJwt(a);
    expect(p).toMatchObject({ sub: "staff-1", role: "super_admin", aud: ACTOR_AUDIENCE, iat: 1_000_000 });
    expect(p.exp! - p.iat!).toBeLessThanOrEqual(60);
    expect(p.jti).toBeTruthy();
    expect(p.jti).not.toBe(decodeJwt(b).jti);
    await expect(jwtVerify(a, new TextEncoder().encode(SECRET), { audience: ACTOR_AUDIENCE, currentDate: new Date(1_000_010_000) })).resolves.toBeTruthy();
  });

  it("refuses to mint without a secret", async () => {
    await expect(mintActorToken("s", "super_admin", "")).rejects.toThrow();
  });

  it("agent headers carry the service token and actor JWT and never a cookie", async () => {
    const h = await agentHeaders("staff-1", "super_admin", { STUDIO_SERVICE_TOKEN: "svc", STUDIO_ACTOR_SECRET: SECRET });
    expect(Object.keys(h).sort()).toEqual(["X-Studio-Actor", "X-Studio-Service-Token"]);
    expect(h["X-Studio-Service-Token"]).toBe("svc");
    await expect(agentHeaders("s", "r", { STUDIO_ACTOR_SECRET: SECRET })).rejects.toThrow();
  });
});
