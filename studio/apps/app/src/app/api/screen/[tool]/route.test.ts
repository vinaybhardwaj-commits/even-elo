// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

const PID = "22222222-2222-4222-8222-222222222222";
const AUTH = { "studio-internal-staff-id": "staff-1", "studio-internal-staff-role": "super_admin" };

const payload = (tool: string) => ({
  source: { tool, query_hash: "0123456789ab" },
  mode: "live",
  synthetic: false,
  columns: ["metric", "value"],
  rows: [{ metric: "physicians_active", value: 3 }],
  row_count: 1,
});

const call = (tool: string, body: unknown = {}, headers: Record<string, string> = AUTH) =>
  POST(
    new NextRequest(`https://governance.evenos.app/studio/api/screen/${tool}`, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ tool }) },
  );

describe("/studio/api/screen/[tool]", () => {
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

  it("401 without the actor headers the proxy sets; nothing is forwarded", async () => {
    expect((await call("overview_counts", {}, {})).status).toBe(401);
    expect((await call("overview_counts", {}, { "studio-internal-staff-id": "s" })).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["plan_visualization", "write_file", "execute", "sql", "overview_counts2", "../copilotkit", "LIST_PHYSICIANS"])(
    "404 for %s (allowlist is exactly the twelve read tools)",
    async (tool) => {
      expect((await call(tool)).status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["physician_profile", {}],
    ["physician_profile", { physician_id: "not-a-uuid" }],
    ["physician_profile", { physician_id: PID, staff_id: "attacker" }],
    ["interventions", { limit: 0 }],
    ["interventions", { limit: 201 }],
    ["signal_snapshots", { window_days: 366 }],
    ["incident_summary", { window_days: "30" }],
    ["incident_summary", { sql: "select 1" }],
    ["overview_counts", { x: 1 }],
    ["list_physicians", { filter: { status: "bogus" } }],
    ["list_physicians", { filter: { name_contains: "x".repeat(81) } }],
    ["list_physicians", [1]],
    ["list_physicians", { offset: -1 }],
    ["list_physicians", { offset: 100001 }],
    ["list_physicians", { offset: 1.5 }],
    ["physician_privileges", {}],
    ["physician_oppe", { physician_id: "not-a-uuid" }],
    ["physician_metrics", { physician_id: PID, months: 61 }],
    ["physician_metrics", { physician_id: PID, months: 0 }],
    ["physician_qualifications", { physician_id: PID, sql: "select 1" }],
    ["capture_gaps", { physician_id: PID }],
    ["capture_gaps", { limit: 201 }],
    ["feedback_by_physician", { physician_id: PID, source: "everyone" }],
    ["feedback_by_physician", { physician_id: PID, window_days: 1826 }],
    ["feedback_by_physician", { physician_id: PID, staff_id: "attacker" }],
  ])("422 for invalid params %s %j", async (tool, body) => {
    const res = await call(tool, body);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: "bad_params" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("422 for malformed or oversized bodies", async () => {
    expect((await call("overview_counts", "{nope")).status).toBe(422);
    expect((await call("overview_counts", { pad: "x".repeat(5000) })).status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("503 when the agent or its secrets are not configured", async () => {
    delete process.env.STUDIO_ACTOR_SECRET;
    expect((await call("overview_counts")).status).toBe(503);
    delete process.env.AGENT_URL;
    expect((await call("overview_counts")).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards exactly one tool call with the service token and an actor JWT, and returns the tool JSON", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload("interventions")), { status: 200 }));
    const res = await call("interventions", { physician_id: PID, limit: 10 });
    expect(res.status).toBe(200);
    expect((await res.json()).source).toEqual({ tool: "interventions", query_hash: "0123456789ab" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://agent.invalid/agent/tools/interventions");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Studio-Service-Token"]).toBe("svc");
    expect(init.headers["X-Studio-Actor"].split(".")).toHaveLength(3);
    expect(JSON.parse(init.body)).toEqual({ physician_id: PID, limit: 10 });
  });

  it.each([
    ["physician_privileges", { physician_id: PID, limit: 5 }],
    ["physician_oppe", { physician_id: PID }],
    ["physician_metrics", { physician_id: PID, months: 6 }],
    ["physician_qualifications", { physician_id: PID }],
    ["capture_gaps", {}],
    ["feedback_by_physician", { physician_id: PID, window_days: 90, source: "patient" }],
  ])("forwards the view tool %s to the agent unchanged and returns its payload", async (tool, body) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload(tool)), { status: 200 }));
    const res = await call(tool, body);
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://agent.invalid/agent/tools/${tool}`);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(body);
  });

  it("never forwards client-supplied identity or cookies", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload("overview_counts")), { status: 200 }));
    await call("overview_counts", {}, { ...AUTH, cookie: "epi_session=abc", "x-studio-actor": "forged" });
    const init = fetchMock.mock.calls[0][1];
    expect(Object.keys(init.headers).map((h) => h.toLowerCase())).not.toContain("cookie");
    expect(init.headers["X-Studio-Actor"]).not.toBe("forged");
  });

  it("refuses an upstream payload without its source line or for a different tool", async () => {
    const { source: _s, ...noSource } = payload("overview_counts");
    void _s;
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(noSource), { status: 200 }));
    expect((await call("overview_counts")).status).toBe(502);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload("list_physicians")), { status: 200 }));
    expect((await call("overview_counts")).status).toBe(502);
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    expect((await call("overview_counts")).status).toBe(502);
  });

  it("fails closed on a 3xx from the agent and sends nothing onward", async () => {
    // redirect: "error" makes the real fetch reject; the mock mirrors that when a redirect is not allowed.
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      if (init.redirect === "error") throw new TypeError("redirect mode is set to error");
      return new Response(null, { status: 302, headers: { location: "https://evil.invalid/steal" } });
    });
    const res = await call("overview_counts");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "agent_unreachable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].redirect).toBe("error");
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("evil.invalid"))).toBe(true);
  });

  it("adds a scheme to a bare-host AGENT_URL like the chat route", async () => {
    process.env.AGENT_URL = "agent.internal:8123/agent";
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload("overview_counts")), { status: 200 }));
    await call("overview_counts");
    expect(fetchMock.mock.calls[0][0]).toBe("http://agent.internal:8123/agent/tools/overview_counts");
  });

  it("maps upstream failures to fixed codes and leaks no upstream text", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "tool_failed", message: "host=db.internal password=hunter2" }), { status: 502 }),
    );
    const failed = await call("overview_counts");
    expect(failed.status).toBe(502);
    const text = await failed.text();
    expect(JSON.parse(text)).toEqual({ ok: false, error: "tool_failed" });
    expect(text).not.toContain("hunter2");

    fetchMock.mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.5:8123 secret"));
    const down = await call("overview_counts");
    expect(down.status).toBe(502);
    expect(await down.json()).toEqual({ ok: false, error: "agent_unreachable" });

    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 429 }));
    const limited = await call("overview_counts");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  describe("HTTP read tools", () => {
    it.each(["eiris_incidents", "eiris_incident_detail", "opd_signals"])("%s is served by this app, not forwarded to the agent tools door", async (tool) => {
      delete process.env.INCIDENT_API_BASE;
      delete process.env.GOV_API_KEY;
      fetchMock.mockImplementation(async (url: string) => new Response(JSON.stringify({ ok: true }), { status: url.endsWith("/audit") ? 200 : 500 }));
      const body = tool === "eiris_incident_detail" ? { incident_id: "EHRC-INC-2026-0001" } : {};
      const res = await call(tool, body);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false, error: "upstream_not_configured" });
      expect(fetchMock.mock.calls.every(([u]) => !String(u).includes("/tools/"))).toBe(true);
    });

    it("401 without actor headers; 422 on bad params; nothing leaves the app", async () => {
      expect((await call("opd_signals", {}, {})).status).toBe(401);
      expect((await call("eiris_incident_detail", { incident_id: "bad" })).status).toBe(422);
      expect((await call("opd_signals", "{not json")).status).toBe(422);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("403 for a non-SGC role", async () => {
      const res = await call("eiris_incidents", {}, { "studio-internal-staff-id": "s", "studio-internal-staff-role": "doctor" });
      expect(res.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
