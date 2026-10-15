// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";

const live = vi.fn();
vi.mock("@/lib/zone/live-staff", () => ({ loadLiveStaff: (id: string) => live(id) }));

const SECRET = "mw-secret-not-real";
const STAFF = "22222222-2222-4222-8222-222222222222";

async function token() {
  return new SignJWT({ profileId: STAFF }).setProtectedHeader({ alg: "HS256" }).setAudience("staff").setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(SECRET));
}

describe("studio middleware", () => {
  beforeEach(() => {
    live.mockReset();
    process.env.STAFF_JWT_SECRET = SECRET;
  });

  it("matches every path", async () => {
    const { config } = await import("../proxy");
    expect(config.matcher).toBe("/:path*");
  });

  it("denies with a JSON status and never reaches the DB without a session", async () => {
    const { proxy } = await import("../proxy");
    const res = await proxy(new NextRequest("https://governance.evenos.app/studio/api/copilotkit"));
    expect(res.status).toBe(401);
    expect(live).not.toHaveBeenCalled();
  });

  it("admits a super_admin and overwrites client-supplied actor headers", async () => {
    live.mockResolvedValue({ status: "active", is_super_admin: true, must_change_pin: false });
    const { proxy } = await import("../proxy");
    const res = await proxy(
      new NextRequest("https://governance.evenos.app/studio", {
        headers: { cookie: `epi_session=${await token()}`, "x-studio-staff-id": "forged", "x-studio-staff-role": "forged" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-studio-internal-staff-id")).toBe(STAFF);
    expect(res.headers.get("x-middleware-request-studio-internal-staff-role")).toBe("super_admin");
    expect(live).toHaveBeenCalledWith(STAFF);
  });

  it("strips every client x-studio-*, studio-internal-* and authorization header before CopilotKit can forward them", async () => {
    live.mockResolvedValue({ status: "active", is_super_admin: true, must_change_pin: false });
    const { proxy } = await import("../proxy");
    const res = await proxy(
      new NextRequest("https://governance.evenos.app/studio/api/copilotkit", {
        headers: {
          cookie: `epi_session=${await token()}`,
          authorization: "Bearer attacker",
          "x-studio-actor": "forged",
          "X-Studio-Service-Token": "forged",
          "x-studio-anything": "1",
          "studio-internal-staff-id": "forged",
          "x-keep": "ok",
        },
      }),
    );
    const kept = (res.headers.get("x-middleware-override-headers") ?? "").split(",");
    for (const gone of ["authorization", "x-studio-actor", "x-studio-service-token", "x-studio-anything"]) expect(kept).not.toContain(gone);
    expect(kept).toContain("x-keep");
    expect(res.headers.get("x-middleware-request-studio-internal-staff-id")).toBe(STAFF);
    expect(res.headers.get("x-middleware-request-authorization")).toBeNull();
    // The internal headers are not x-*, so CopilotKit's x-* forwarding cannot carry them to the agent.
    expect("studio-internal-staff-id".startsWith("x-")).toBe(false);
  });

  it("403 for a non-super_admin and for a cross-origin POST", async () => {
    live.mockResolvedValue({ status: "active", is_super_admin: false, must_change_pin: false });
    const { proxy } = await import("../proxy");
    const cookie = `epi_session=${await token()}`;
    expect((await proxy(new NextRequest("https://governance.evenos.app/studio", { headers: { cookie } }))).status).toBe(403);
    live.mockResolvedValue({ status: "active", is_super_admin: true, must_change_pin: false });
    const post = await proxy(
      new NextRequest("https://governance.evenos.app/studio/api/copilotkit", { method: "POST", headers: { cookie, origin: "https://evil.example" } }),
    );
    expect(post.status).toBe(403);
  });
});
