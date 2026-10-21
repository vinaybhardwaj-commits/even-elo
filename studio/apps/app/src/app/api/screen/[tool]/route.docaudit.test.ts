// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

const AUTH = { "studio-internal-staff-id": "staff-1", "studio-internal-staff-role": "super_admin" };
const payload = (tool: string) => ({ source: { tool, query_hash: "0123456789ab" }, mode: "live", synthetic: false, columns: ["metric", "value"], rows: [{ metric: "audits_total", value: 3 }], row_count: 1 });
const call = (tool: string, body: unknown) =>
  POST(new NextRequest(`https://governance.evenos.app/studio/api/screen/${tool}`, { method: "POST", headers: AUTH, body: JSON.stringify(body) }), { params: Promise.resolve({ tool }) });

describe("/studio/api/screen/[tool] document-audit tools", () => {
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

  it("forwards validated params to the agent tool and returns the typed table", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload("document_audit_headline")), { status: 200 }));
    const res = await call("document_audit_headline", { hospital_code: "H1" });
    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/tools\/document_audit_headline$/);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ hospital_code: "H1" });
  });

  it("refuses unknown keys, bad enums and bad ids before anything is forwarded", async () => {
    for (const [tool, body] of [
      ["list_document_audits", { sql: "select 1" }],
      ["list_document_audits", { filter: { severity: "extreme" } }],
      ["document_audit_detail", { audit_id: "nope" }],
    ] as const) {
      expect((await call(tool, body)).status).toBe(422);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an agent answer whose source tool does not match", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload("overview_counts")), { status: 200 }));
    expect((await call("document_audit_headline", {})).status).toBe(502);
  });
});
