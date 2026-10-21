// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

const call = (op: string, headers: Record<string, string> = {}, body = "{}") =>
  POST(new NextRequest(`https://studio.invalid/studio/api/admin/${op}`, { method: "POST", headers, body }), { params: Promise.resolve({ op }) });

describe("admin route", () => {
  it("401 without the proxy's actor headers", async () => {
    expect((await call("users")).status).toBe(401);
  });
  it("404 for ops routes and anything outside the closed op set", async () => {
    const h = { "studio-internal-staff-id": "s", "studio-internal-staff-role": "super_admin" };
    for (const op of ["migrate", "seed-profile", "wipe-smoke-residue", "dedupe-physicians", "recompute"]) expect((await call(op, h)).status).toBe(404);
  });
});
