// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

const AUTH = { "studio-internal-staff-id": "staff-1", "studio-internal-staff-role": "super_admin" };
const call = (op: string, body: unknown = {}, headers: Record<string, string> = AUTH) =>
  POST(new NextRequest(`https://governance.evenos.app/studio/api/feedback/${op}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }), {
    params: Promise.resolve({ op }),
  });

describe("/studio/api/feedback/[op]", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("401 without the proxy's actor headers; 404 for an unknown op (no delete); 422 for junk or oversize bodies", async () => {
    expect((await call("list", {}, {})).status).toBe(401);
    expect((await call("delete")).status).toBe(404);
    expect((await call("list", "{not json")).status).toBe(422);
    expect((await call("list", { limit: 5, pad: "x".repeat(3000) })).status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retract is 403 second_factor_required and nothing leaves the server", async () => {
    const res = await call("retract", { feedback_id: "33333333-3333-4333-8333-333333333333", retraction_reason: "duplicate" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "second_factor_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
