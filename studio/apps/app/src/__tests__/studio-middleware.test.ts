// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";

const live = vi.fn();
vi.mock("@/lib/zone/live-staff", () => ({ loadLiveStaff: (id: string) => live(id) }));

const SECRET = "mw-secret-not-real";
const STAFF = "22222222-2222-4222-8222-222222222222";

async function token() {
  return new SignJWT({ profileId: STAFF }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(SECRET));
}

describe("studio middleware", () => {
  beforeEach(() => {
    live.mockReset();
    process.env.JWT_SECRET = SECRET;
  });

  it("matches every path", async () => {
    const { config } = await import("../middleware");
    expect(config.matcher).toBe("/:path*");
  });

  it("denies with a JSON status and never reaches the DB without a session", async () => {
    const { middleware } = await import("../middleware");
    const res = await middleware(new NextRequest("https://governance.evenos.app/studio/api/copilotkit"));
    expect(res.status).toBe(401);
    expect(live).not.toHaveBeenCalled();
  });

  it("admits a super_admin and overwrites client-supplied actor headers", async () => {
    live.mockResolvedValue({ status: "active", is_super_admin: true });
    const { middleware } = await import("../middleware");
    const res = await middleware(
      new NextRequest("https://governance.evenos.app/studio", {
        headers: { cookie: `epi_session=${await token()}`, "x-studio-staff-id": "forged", "x-studio-staff-role": "forged" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-x-studio-staff-id")).toBe(STAFF);
    expect(res.headers.get("x-middleware-request-x-studio-staff-role")).toBe("super_admin");
    expect(live).toHaveBeenCalledWith(STAFF);
  });

  it("403 for a non-super_admin and for a cross-origin POST", async () => {
    live.mockResolvedValue({ status: "active", is_super_admin: false });
    const { middleware } = await import("../middleware");
    const cookie = `epi_session=${await token()}`;
    expect((await middleware(new NextRequest("https://governance.evenos.app/studio", { headers: { cookie } }))).status).toBe(403);
    live.mockResolvedValue({ status: "active", is_super_admin: true });
    const post = await middleware(
      new NextRequest("https://governance.evenos.app/studio/api/copilotkit", { method: "POST", headers: { cookie, origin: "https://evil.example" } }),
    );
    expect(post.status).toBe(403);
  });
});
