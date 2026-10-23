// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { FIXTURES } from "@/lib/cdmss/fixtures";

const hdr = (role: string) => ({ "studio-internal-staff-id": "staff-1", "studio-internal-staff-role": role });
const call = (view: string, body: unknown = {}, role = "staff,site_medical_head") =>
  POST(new NextRequest(`https://governance.evenos.app/studio/api/cdmss/${view}`, { method: "POST", headers: role ? hdr(role) : {}, body: typeof body === "string" ? body : JSON.stringify(body) }), { params: Promise.resolve({ view }) });

describe("/studio/api/cdmss/[view]", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    process.env.AGENT_URL = "https://agent.invalid/agent";
    process.env.STUDIO_SERVICE_TOKEN = "svc";
    process.env.STUDIO_ACTOR_SECRET = "actor-secret-0123456789abcdef0123456789";
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AGENT_URL;
    delete process.env.STUDIO_SERVICE_TOKEN;
    delete process.env.STUDIO_ACTOR_SECRET;
  });

  it("refuses without an actor, and refuses plain staff and HR (403, no agent call)", async () => {
    expect((await call("scorecard", {}, "")).status).toBe(401);
    for (const role of ["staff", "staff,hr"]) expect((await call("scorecard", {}, role)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("admits super_admin, SMH and SGC", async () => {
    for (const role of ["staff,super_admin", "staff,site_medical_head", "staff,sgc_member"]) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(FIXTURES.scorecard), { status: 200 }));
      expect((await call("scorecard", {}, role)).status, role).toBe(200);
    }
  });
  it("forwards to the contract's tool name with the typed params only", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(FIXTURES.doctor_variation), { status: 200 }));
    await call("doctor_variation", { metric: "nqi", window_days: 28 });
    expect(fetchMock.mock.calls[0][0]).toBe("https://agent.invalid/agent/tools/cdmss_v3_doctor_variation");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ metric: "nqi", window_days: 28 });
  });
  it("rejects unknown views and unknown or out-of-range params (422/404, no agent call)", async () => {
    expect((await call("nope")).status).toBe(404);
    expect((await call("scorecard", { sql: "select 1" })).status).toBe(422);
    expect((await call("worklists", { limit: 5000 })).status).toBe(422);
    expect((await call("scorecard", "{not json")).status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("never passes on a result without its envelope", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...FIXTURES.scorecard, view: { sites: [] } }), { status: 200 }));
    const res = await call("scorecard");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "bad_payload" });
  });
  it("maps agent failures to fixed codes", async () => {
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    expect(await (await call("scorecard")).json()).toEqual({ ok: false, error: "tool_failed" });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 429 }));
    expect((await call("scorecard")).status).toBe(429);
  });
});
