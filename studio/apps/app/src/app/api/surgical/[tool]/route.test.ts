// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { POST as WRITE } from "../write/[action]/route";

const AUTH = { "studio-internal-staff-id": "staff-1", "studio-internal-staff-role": "super_admin", cookie: "epi_session=aaa.bbb.ccc" };
const VC = "11111111-1111-4111-8111-111111111111";

const read = (tool: string, body: unknown = {}, headers: Record<string, string> = AUTH) =>
  POST(new NextRequest(`https://governance.evenos.app/studio/api/surgical/${tool}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }), { params: Promise.resolve({ tool }) });
const write = (action: string, body: unknown = {}, headers: Record<string, string> = AUTH) =>
  WRITE(new NextRequest(`https://governance.evenos.app/studio/api/surgical/write/${action}`, { method: "POST", headers, body: JSON.stringify(body) }), { params: Promise.resolve({ action }) });

describe("/studio/api/surgical", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    process.env.EVEN_ELO_API_BASE = "https://elo.invalid";
    process.env.AGENT_URL = "https://agent.invalid/agent";
    process.env.STUDIO_SERVICE_TOKEN = "svc";
    process.env.STUDIO_ACTOR_SECRET = "actor-secret-0123456789abcdef0123456789";
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) =>
      String(url).startsWith("https://agent.invalid") ? new Response("{}", { status: 200 }) : new Response(JSON.stringify({ ok: true, vcs: [{ id: VC, full_name: "Dr A", specialty: "ENT", status: "active" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("401 without the proxy's actor headers, before any fetch", async () => {
    expect((await read("surgical_vcs", {}, { cookie: AUTH.cookie })).status).toBe(401);
    expect((await write("recompute_all", {}, { cookie: AUTH.cookie })).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("403 for a non super_admin role on reads and writes", async () => {
    const h = { ...AUTH, "studio-internal-staff-role": "sgc_member" };
    expect((await read("surgical_vcs", {}, h)).status).toBe(403);
    expect((await write("recompute_all", {}, h)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404 for an unknown tool or action (no pass-through of arbitrary paths)", async () => {
    expect((await read("surgical_sql")).status).toBe(404);
    expect((await read("..%2Fadmin")).status).toBe(404);
    expect((await write("delete_vc")).status).toBe(404);
  });

  it("422 on bad or oversized bodies", async () => {
    expect((await read("surgical_vcs", "{nope")).status).toBe(422);
    expect((await read("surgical_vcs", { status: "x".repeat(5000) })).status).toBe(422);
    expect((await read("surgical_vcs", { extra: true })).status).toBe(422);
  });

  it("200 read: forwards the cookie from the request, returns the typed table, no-store", async () => {
    const res = await read("surgical_vcs", { status: "all" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.source.tool).toBe("surgical_vcs");
    expect(body.rows[0].full_name).toBe("Dr A");
    const upstream = fetchMock.mock.calls.find((c) => String(c[0]).startsWith("https://elo.invalid"))!;
    expect(upstream[1].headers.Cookie).toBe("epi_session=aaa.bbb.ccc");
  });

  it("a write is refused with needs_second_factor and nothing reaches even-elo", async () => {
    const res = await write("case_void", { case_id: "33333333-3333-4333-8333-333333333333" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "needs_second_factor" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
