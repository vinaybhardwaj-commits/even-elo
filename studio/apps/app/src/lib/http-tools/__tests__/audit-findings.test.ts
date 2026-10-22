// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runHttpTool } from "../run";
import { buildHttpToolActions } from "../actions";
import { SourceTablePayload } from "@/lib/screens/tool-schema";

const ACTOR = { staffId: "staff-1", role: "super_admin" };
const ROSTER = {
  doctors: [
    { doctor_uid: "D1", name: "Dr One", signals: [
      { reference: "EHRC-AUD-2026-0001", doctor_uid: "D1", label: "Dose ceiling", status: "escalated", overdue: true, response: { verb: "disagree", comment: "SECRET-COMMENT" }, routed_at: "2026-10-02", importance: "high" },
      { reference: "EHRC-AUD-2026-0002", doctor_uid: "D1", signal_type: "missing_allergy", status: "routed", response_required: "explanation", routed_at: "2026-10-05" },
      { reference: "EHRC-AUD-2026-0003", doctor_uid: "D1", status: "ruled", ruling: { action: "dismissed", note: "SECRET-RULING" }, routed_at: "2026-09-01" },
    ] },
    { doctor_uid: "D2", name: "Dr Two", signals: [
      { reference: "XYZ-AUD-2026-0004", doctor_uid: "D2", status: "routed", response_required: "none", routed_at: "2026-10-06" },
      { reference: "EHRC-AUD-2026-0001", doctor_uid: "D2", status: "routed" },
    ] },
  ],
};
const DETAIL = {
  ok: true,
  signal: { ...ROSTER.doctors[0].signals[0], window: { from: "2026-09-01", to: "2026-09-30" }, instances: 2,
    ruling: { action: "closed", note: "SECRET-RULING", actor: "gov:a@even.in", ruled_at: "2026-10-09" } },
  instances: [{ audit_id: "A1", finding_ref: "F1", verdict: "fail", note_date: "2026-09-12", subject: "SECRET-SUBJECT", rationale: "SECRET-RATIONALE", citations: [{ n: 1, title: "Guideline 7" }] }],
  events: [
    { event: "responded", at: "2026-10-03", actor: "doctor:D1", payload: { verb: "disagree", comment: "SECRET-COMMENT" } },
    { event: "routed", at: "2026-10-02", actor: "cm:asha", payload: {} },
  ],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("audit findings tools", () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  beforeEach(() => {
    calls.length = 0;
    process.env.GOV_API_BASE = "https://cdmss.invalid";
    process.env.GOV_API_KEY = "gov-key";
    process.env.AGENT_URL = "https://agent.invalid/agent";
    process.env.STUDIO_SERVICE_TOKEN = "svc";
    process.env.STUDIO_ACTOR_SECRET = "actor-secret-0123456789abcdef0123456789";
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/agent/audit")) return json({ ok: true });
      if (url.includes("/roster-audits")) return json(ROSTER);
      if (url.endsWith("/audit-signal/EHRC-AUD-2026-0001")) return json(DETAIL);
      if (url.includes("/audit-signal/")) return json({ ok: false }, 404);
      return json({}, 500);
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ["GOV_API_BASE", "GOV_API_KEY", "AGENT_URL", "STUDIO_SERVICE_TOKEN", "STUDIO_ACTOR_SECRET"]) delete process.env[k];
  });
  const up = () => calls.filter((c) => !c.url.endsWith("/agent/audit"));

  it("list: since/until filter by routed date; with since and no window_days the CDMSS window reaches back to it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T06:00:00Z"));
    try {
      const p = SourceTablePayload.parse((await runHttpTool("audit_findings", { view: "all", since: "2026-10-03", until: "2026-10-05" }, ACTOR)).body);
      expect(p.rows.map((r) => r.reference)).toEqual(["EHRC-AUD-2026-0002"]);
      expect(up()[0].url).toContain("window=20");
    } finally {
      vi.useRealTimers();
    }
  });

  it("list: default view is attention, de-duplicated, no comments or notes", async () => {
    const p = SourceTablePayload.parse((await runHttpTool("audit_findings", {}, ACTOR)).body);
    expect(p.rows.map((r) => r.reference)).toEqual(["EHRC-AUD-2026-0001"]);
    expect(p.rows[0]).toMatchObject({ hospital: "EHRC", doctor: "Dr One", finding: "Dose ceiling", status: "escalated", doctor_response: "disagree", overdue: true });
    expect(JSON.stringify(p)).not.toContain("SECRET");
    expect(p.source.tool).toBe("audit_findings");
  });

  it("list filters: status, hospital, view=all, doctor_uid passed upstream", async () => {
    const all = SourceTablePayload.parse((await runHttpTool("audit_findings", { view: "all" }, ACTOR)).body);
    expect(all.row_count).toBe(4);
    const ruled = SourceTablePayload.parse((await runHttpTool("audit_findings", { view: "all", status: "ruled" }, ACTOR)).body);
    expect(ruled.rows.map((r) => r.reference)).toEqual(["EHRC-AUD-2026-0003"]);
    expect(ruled.rows[0].ruling_action).toBe("dismissed");
    const xyz = SourceTablePayload.parse((await runHttpTool("audit_findings", { view: "all", hospital: "XYZ" }, ACTOR)).body);
    expect(xyz.rows.map((r) => r.reference)).toEqual(["XYZ-AUD-2026-0004"]);
    await runHttpTool("audit_findings", { doctor_uid: "D1", window_days: 7 }, ACTOR);
    expect(calls.find((c) => c.url.includes("doctor_uid=D1"))?.url).toContain("window=7");
  });

  it("detail: header, evidence, timeline and free text, with no flag", async () => {
    const full = SourceTablePayload.parse((await runHttpTool("audit_finding_detail", { reference: "EHRC-AUD-2026-0001" }, ACTOR)).body);
    const g = (section: string, field: string) => full.rows.find((r) => r.section === section && r.field === field)?.value;
    expect(g("thread", "status")).toBe("escalated");
    expect(g("evidence_1", "verdict")).toBe("fail");
    expect(g("evidence_1", "citations")).toBe("Guideline 7");
    expect(g("event_01", "event")).toBe("routed");
    expect(g("event_02", "actor")).toBe("doctor");
    expect(g("evidence_1", "rationale")).toBe("SECRET-RATIONALE");
    expect(g("response", "comment")).toBe("SECRET-COMMENT");
    expect(g("ruling", "note")).toBe("SECRET-RULING");
  });

  it("detail: unknown thread 404, bad reference 422 with no upstream call", async () => {
    expect(await runHttpTool("audit_finding_detail", { reference: "EHRC-AUD-2026-9999" }, ACTOR)).toMatchObject({ status: 404, body: { error: "not_found" } });
    calls.length = 0;
    for (const reference of ["../x", "EHRC-INC-2026-0001", "ehrc-aud-2026-0001", "EHRC-AUD-2026-0001/ruling"]) {
      expect((await runHttpTool("audit_finding_detail", { reference }, ACTOR)).status).toBe(422);
    }
    expect(calls).toHaveLength(0);
  });

  it("GET only, CDMSS key header, audit row is metadata only", async () => {
    await runHttpTool("audit_finding_detail", { reference: "EHRC-AUD-2026-0001" }, ACTOR);
    expect(up().every((c) => c.init?.method === "GET")).toBe(true);
    expect((up()[0].init?.headers as Record<string, string>)["x-api-key"]).toBe("gov-key");
    const a = JSON.parse(String(calls.find((c) => c.url.endsWith("/agent/audit"))!.init?.body));
    expect(a).toMatchObject({ tool: "audit_finding_detail", params: { reference: "EHRC-AUD-2026-0001" }, outcome: "ok" });
    expect(JSON.stringify(a)).not.toContain("SECRET");
  });

  it("role gate (SGC or super_admin, same text for both), strict params", async () => {
    calls.length = 0;
    expect((await runHttpTool("audit_findings", {}, { staffId: "s", role: "doctor" })).status).toBe(403);
    expect((await runHttpTool("audit_finding_detail", { reference: "EHRC-AUD-2026-0001" }, { staffId: "s", role: "doctor" })).status).toBe(403);
    calls.length = 0;
    const sgc = await runHttpTool("audit_finding_detail", { reference: "EHRC-AUD-2026-0001" }, { staffId: "s", role: "sgc_member" });
    expect(sgc.status).toBe(200);
    expect(JSON.stringify(sgc.body)).toContain("SECRET-RULING");
    expect((await runHttpTool("audit_finding_detail", { reference: "EHRC-AUD-2026-0001", include_text: true }, ACTOR)).status).toBe(422);
    calls.length = 0;
    expect((await runHttpTool("audit_findings", { sql: "x" }, ACTOR)).status).toBe(422);
    expect((await runHttpTool("audit_findings", { hospital: "ehrc" }, ACTOR)).status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it("chat actions: same text as the screen, no include_text, no write action exists", async () => {
    const actions = buildHttpToolActions(ACTOR) as unknown as Array<{ name: string; handler: (a: Record<string, unknown>) => Promise<unknown>; parameters: Array<{ name: string }> }>;
    const detail = actions.find((a) => a.name === "audit_finding_detail")!;
    expect(detail.parameters.map((p) => p.name)).toEqual(["reference"]);
    const out = SourceTablePayload.parse(await detail.handler({ reference: "EHRC-AUD-2026-0001" }));
    expect(JSON.stringify(out)).toContain("SECRET-COMMENT");
    expect(actions.map((a) => a.name).filter((n) => /rul|write|action/.test(n))).toEqual([]);
  });
});
