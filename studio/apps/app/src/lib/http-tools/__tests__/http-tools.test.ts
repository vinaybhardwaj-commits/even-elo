// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runHttpTool, queryHash } from "../run";
import { buildHttpToolActions } from "../actions";
import { SourceTablePayload } from "@/lib/screens/tool-schema";

const ACTOR = { staffId: "staff-1", role: "super_admin" };

const INCIDENTS = {
  ok: true,
  incidents: [
    { id: "EHRC-INC-2026-0001", reported_at: "2026-10-01T10:00:00Z", severity: "major", near_miss: false, status: "open", type_name: "Fall", dept_name: "Ward", location_name: "W1", narrative_snippet: "SECRET-NARRATIVE", rca_count: 1, sla_state: "overdue", due_at: "2026-10-10", unit_code: "EHRC" },
    { id: "EHRC-INC-2026-0002", reported_at: "2026-09-20T10:00:00Z", severity: "major", near_miss: true, status: "closed", type_name: "Med", dept_name: "Pharm", rca_count: 0, closed_at: "2026-09-28", sla_state: "closed" },
    { id: "EHRC-INC-2026-0003", reported_at: "2026-09-10T10:00:00Z", severity: null, near_miss: false, status: "under_investigation", rca_count: 0 },
  ],
};
const STATS = { ok: true, totals: { total: 40, open: 12, near_miss: 5, high_sev: 3, with_rca: 20, overdue: 2 } };
const MM = { ok: true, totals: { open: 4, in_review: 2, gaps_open: 1 } };
const DETAIL = {
  ok: true,
  incident: {
    id: "EHRC-INC-2026-0001", severity: "major", status: "open", near_miss: false, type_name: "Fall", dept_name: "Ward",
    narrative: "SECRET-NARRATIVE", immediate_action: "SECRET-ACTION", confidentiality: "confidential",
    reporter_name: "SECRET-REPORTER", reporter_contact: "SECRET-CONTACT", phi_patient_name: "SECRET-PATIENT", phi_uhid: "SECRET-UHID",
    reported_at: "2026-10-01T10:00:00Z",
  },
  rcas: [
    { root_cause: "SECRET-ROOT", contributory_factors: { factors: [{ category: "staffing", note: "SECRET-NOTE" }] }, capas: [{ kind: "corrective", action: "SECRET-CAPA", control_level: "engineering" }], effectiveness_verified: false },
  ],
};
const ROSTER = {
  doctors: [
    { doctor_uid: "D1", name: "Dr One", signals: [
      { reference: "EHRC-AUD-2026-0001", status: "escalated", overdue: true, response: { verb: "disagree", comment: "SECRET-COMMENT" }, routed_at: "2026-10-02" },
      { reference: "EHRC-AUD-2026-0002", status: "routed", response_required: "explanation", routed_at: "2026-10-05" },
      { reference: "EHRC-AUD-2026-0002", status: "routed", response_required: "explanation" },
      { reference: "EHRC-AUD-2026-0003", status: "ruled", ruling: { note: "SECRET-RULING" } },
    ] },
    { doctor_uid: "D2", name: "Dr Two", signals: [{ reference: "EHRC-AUD-2026-0004", status: "routed", response_required: "none" }] },
  ],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("HTTP read tools", () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let auditStatus = 200;
  let upstream: (url: string) => Response;

  beforeEach(() => {
    calls.length = 0;
    auditStatus = 200;
    upstream = (url) => {
      if (url.endsWith("/api/office/incidents")) return json(INCIDENTS);
      if (url.endsWith("/api/office/stats")) return json(STATS);
      if (url.endsWith("/api/mm/stats")) return json(MM);
      if (url.includes("/api/office/incidents/EHRC-INC-2026-0001")) return json(DETAIL);
      if (url.includes("/api/office/incidents/")) return json({ ok: false }, 404);
      if (url.includes("/api/governance/roster-audits")) return json(ROSTER);
      return json({}, 500);
    };
    process.env.INCIDENT_API_BASE = "https://incident.invalid";
    process.env.INCIDENT_API_TOKEN = "inc-token";
    process.env.GOV_API_BASE = "https://cdmss.invalid";
    process.env.GOV_API_KEY = "gov-key";
    process.env.AGENT_URL = "https://agent.invalid/agent";
    process.env.STUDIO_SERVICE_TOKEN = "svc";
    process.env.STUDIO_ACTOR_SECRET = "actor-secret-0123456789abcdef0123456789";
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "https://agent.invalid/agent/audit") return json({ ok: auditStatus === 200 }, auditStatus);
      return upstream(url);
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ["INCIDENT_API_BASE", "INCIDENT_API_TOKEN", "GOV_API_BASE", "GOV_API_KEY", "AGENT_URL", "STUDIO_SERVICE_TOKEN", "STUDIO_ACTOR_SECRET", "STUDIO_LIVE_READS"]) delete process.env[k];
  });

  const audits = () => calls.filter((c) => c.url.endsWith("/agent/audit")).map((c) => JSON.parse(String(c.init?.body)));

  it("eiris_incidents summary: counts by severity open/closed, totals, M&M; typed payload with source line", async () => {
    const r = await runHttpTool("eiris_incidents", {}, ACTOR);
    expect(r.status).toBe(200);
    const p = SourceTablePayload.parse(r.body);
    expect(p.source).toEqual({ tool: "eiris_incidents", query_hash: queryHash("eiris_incidents") });
    expect(p.mode).toBe("live");
    expect(p.synthetic).toBe(false);
    expect(p.rows).toContainEqual({ scope: "severity", key: "major", open: 1, closed: 1, total: 2 });
    expect(p.rows).toContainEqual({ scope: "severity", key: "unrated", open: 1, closed: 0, total: 1 });
    expect(p.rows).toContainEqual({ scope: "totals", key: "open", open: null, closed: null, total: 12 });
    expect(p.rows).toContainEqual({ scope: "mm_cases", key: "in_review", open: null, closed: null, total: 2 });
  });

  it("eiris_incidents list: ids, status, dates, RCA flag; filters; no narrative", async () => {
    const r = await runHttpTool("eiris_incidents", { view: "list", status: "open", limit: 5 }, ACTOR);
    const p = SourceTablePayload.parse(r.body);
    expect(p.rows.map((x) => x.id)).toEqual(["EHRC-INC-2026-0001", "EHRC-INC-2026-0003"]);
    expect(p.rows[0]).toMatchObject({ state: "open", has_rca: true, rca_count: 1, sla_state: "overdue" });
    expect(JSON.stringify(p)).not.toContain("SECRET");
    const sev = SourceTablePayload.parse((await runHttpTool("eiris_incidents", { view: "list", severity: "MAJOR", status: "closed" }, ACTOR)).body);
    expect(sev.rows.map((x) => x.id)).toEqual(["EHRC-INC-2026-0002"]);
  });

  it("eiris_incidents summary survives a stats outage", async () => {
    const base = upstream;
    upstream = (url) => (url.endsWith("/stats") ? json({}, 500) : base(url));
    const p = SourceTablePayload.parse((await runHttpTool("eiris_incidents", {}, ACTOR)).body);
    expect(p.rows.some((x) => x.scope === "severity")).toBe(true);
    expect(p.rows.some((x) => x.scope === "totals" || x.scope === "mm_cases")).toBe(false);
  });

  it("eiris_incident_detail: structure only by default; never patient or reporter identity", async () => {
    const p = SourceTablePayload.parse((await runHttpTool("eiris_incident_detail", { incident_id: "EHRC-INC-2026-0001" }, ACTOR)).body);
    const text = JSON.stringify(p);
    expect(text).not.toContain("SECRET");
    expect(p.rows).toContainEqual({ section: "incident", field: "confidentiality", value: "confidential" });
    expect(p.rows).toContainEqual({ section: "rca_1", field: "factor_categories", value: "staffing" });
    expect(p.rows).toContainEqual({ section: "rca_1", field: "root_cause_recorded", value: true });
  });

  it("eiris_incident_detail include_text adds only narrative, action, root cause, CAPA text", async () => {
    const p = SourceTablePayload.parse((await runHttpTool("eiris_incident_detail", { incident_id: "EHRC-INC-2026-0001", include_text: true }, ACTOR)).body);
    const text = JSON.stringify(p);
    for (const ok of ["SECRET-NARRATIVE", "SECRET-ACTION", "SECRET-ROOT", "SECRET-CAPA"]) expect(text).toContain(ok);
    for (const never of ["SECRET-REPORTER", "SECRET-CONTACT", "SECRET-PATIENT", "SECRET-UHID", "SECRET-NOTE"]) expect(text).not.toContain(never);
  });

  it("eiris_incident_detail: unknown id is 404 not_found and is audited as an error", async () => {
    const r = await runHttpTool("eiris_incident_detail", { incident_id: "EHRC-INC-2026-9999" }, ACTOR);
    expect(r).toMatchObject({ status: 404, body: { ok: false, error: "not_found" } });
    expect(audits()[0]).toMatchObject({ tool: "eiris_incident_detail", row_count: 0, outcome: "error" });
  });

  it.each([{}, { incident_id: "x" }, { incident_id: "EHRC-INC-2026-0001/../x" }, { incident_id: "EHRC-INC-2026-0001", extra: 1 }])(
    "eiris_incident_detail refuses bad params %j before any call",
    async (params) => {
      expect((await runHttpTool("eiris_incident_detail", params, ACTOR)).status).toBe(422);
      expect(calls).toHaveLength(0);
    },
  );

  it("opd_signals: per-doctor counts, de-duplicated threads, attention first, no comments", async () => {
    const p = SourceTablePayload.parse((await runHttpTool("opd_signals", { window_days: 14 }, ACTOR)).body);
    expect(p.rows[0]).toMatchObject({ doctor_uid: "D1", doctor: "Dr One", threads: 3, open: 2, overdue: 1, disagreed: 1, awaiting_ruling: 1, awaiting_doctor: 1, ruled: 1, closed: 0, latest_routed_at: "2026-10-05" });
    expect(p.rows[1]).toMatchObject({ doctor_uid: "D2", threads: 1, awaiting_doctor: 0 });
    expect(JSON.stringify(p)).not.toContain("SECRET");
    expect(calls[0].url).toBe("https://cdmss.invalid/api/governance/roster-audits?window=14");
  });

  it("opd_signals passes doctor_uid and uses the CDMSS key header", async () => {
    await runHttpTool("opd_signals", { doctor_uid: "D1" }, ACTOR);
    expect(calls[0].url).toContain("doctor_uid=D1");
    expect((calls[0].init?.headers as Record<string, string>)["x-api-key"]).toBe("gov-key");
  });

  it("every upstream call is a GET with the right credential; the audit row carries metadata only", async () => {
    await runHttpTool("eiris_incidents", { view: "list" }, ACTOR);
    const up = calls.filter((c) => !c.url.endsWith("/agent/audit"));
    expect(up.every((c) => c.init?.method === "GET")).toBe(true);
    expect((up[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer inc-token");
    const [a] = audits();
    expect(a).toEqual({ tool: "eiris_incidents", params: { view: "list" }, row_count: 3, duration_ms: expect.any(Number), outcome: "ok" });
    const auditCall = calls.find((c) => c.url.endsWith("/agent/audit"))!;
    const h = auditCall.init?.headers as Record<string, string>;
    expect(h["X-Studio-Service-Token"]).toBe("svc");
    expect(h["X-Studio-Actor"]).toBeTruthy();
  });

  it("fails closed: no audit row, no data", async () => {
    auditStatus = 503;
    expect(await runHttpTool("eiris_incidents", {}, ACTOR)).toMatchObject({ status: 503, body: { ok: false, error: "audit_unavailable" } });
    auditStatus = 429;
    expect(await runHttpTool("eiris_incidents", {}, ACTOR)).toMatchObject({ status: 429, body: { error: "rate_limited" } });
    delete process.env.AGENT_URL;
    expect(await runHttpTool("eiris_incidents", {}, ACTOR)).toMatchObject({ status: 503, body: { error: "audit_unavailable" } });
  });

  it.each(["doctor", "nurse", "physician", ""])("role %j is refused with no upstream call and no audit", async (role) => {
    const r = await runHttpTool("eiris_incidents", {}, { staffId: "s", role });
    expect(r.status).toBe(role ? 403 : 401);
    expect(calls).toHaveLength(0);
  });

  it("SGC members pass the same gate as even-elo's /api/safety proxy", async () => {
    expect((await runHttpTool("eiris_incidents", {}, { staffId: "s", role: "sgc_member" })).status).toBe(200);
  });

  it("include_text is super_admin only: sgc_member gets 403 and no upstream call", async () => {
    const r = await runHttpTool("eiris_incident_detail", { incident_id: "EHRC-INC-2026-0001", include_text: true }, { staffId: "s", role: "sgc_member" });
    expect(r).toMatchObject({ status: 403, body: { error: "forbidden" } });
    expect(calls).toHaveLength(0);
    expect((await runHttpTool("eiris_incident_detail", { incident_id: "EHRC-INC-2026-0001" }, { staffId: "s", role: "sgc_member" })).status).toBe(200);
  });

  it("the chat action has no include_text parameter and drops it if the model sends it", async () => {
    const actions = buildHttpToolActions(ACTOR) as unknown as Array<{ handler: (a: Record<string, unknown>) => Promise<unknown>; parameters: Array<{ name: string }> }>;
    expect(actions[1].parameters.map((p) => p.name)).not.toContain("include_text");
    const out = SourceTablePayload.parse(await actions[1].handler({ incident_id: "EHRC-INC-2026-0001", include_text: true }));
    expect(JSON.stringify(out)).not.toContain("SECRET-");
  });

  it("STUDIO_LIVE_READS=0 is a kill switch: 503 live_reads_off, no upstream read, no audit row", async () => {
    for (const v of ["0", "false", "off", "no", ""]) {
      process.env.STUDIO_LIVE_READS = v;
      expect(await runHttpTool("opd_signals", {}, ACTOR)).toMatchObject({ status: 503, body: { error: "live_reads_off" } });
    }
    expect(calls).toHaveLength(0);
    process.env.STUDIO_LIVE_READS = "1";
    expect((await runHttpTool("opd_signals", {}, ACTOR)).status).toBe(200);
    delete process.env.STUDIO_LIVE_READS;
    expect((await runHttpTool("opd_signals", {}, ACTOR)).status).toBe(200);
  });

  it("e-IRIS reads forward the actor's role flags", async () => {
    await runHttpTool("eiris_incidents", { view: "list" }, { staffId: "s", role: "sgc_member" });
    const h = calls[0].init?.headers as Record<string, string>;
    expect(h).toMatchObject({ "x-actor-super": "0", "x-actor-sgc": "1" });
  });

  it("missing upstream config is a fixed code and is audited as an error", async () => {
    delete process.env.INCIDENT_API_TOKEN;
    expect(await runHttpTool("eiris_incidents", {}, ACTOR)).toMatchObject({ status: 503, body: { error: "upstream_not_configured" } });
    expect(audits()[0]).toMatchObject({ outcome: "error", row_count: 0 });
    delete process.env.GOV_API_KEY;
    expect(await runHttpTool("opd_signals", {}, ACTOR)).toMatchObject({ status: 503, body: { error: "upstream_not_configured" } });
  });

  it("upstream failure bodies and exceptions never reach the caller", async () => {
    upstream = () => new Response("db host leak postgres://u:p@h/x", { status: 500 });
    const r = await runHttpTool("eiris_incidents", {}, ACTOR);
    expect(r).toMatchObject({ status: 502, body: { error: "upstream_failed" } });
    expect(JSON.stringify(r)).not.toContain("postgres");
    upstream = () => {
      throw new Error("ECONNREFUSED internal.host");
    };
    const r2 = await runHttpTool("opd_signals", {}, ACTOR);
    expect(JSON.stringify(r2)).not.toContain("internal.host");
  });

  it("a malformed upstream body is bad_payload", async () => {
    upstream = () => json({ nothing: true });
    expect(await runHttpTool("eiris_incidents", { view: "list" }, ACTOR)).toMatchObject({ status: 502, body: { error: "bad_payload" } });
    expect(await runHttpTool("opd_signals", {}, ACTOR)).toMatchObject({ status: 502, body: { error: "bad_payload" } });
  });

  it("CopilotKit actions expose exactly the HTTP tools and run the same handler", async () => {
    const actions = buildHttpToolActions(ACTOR) as unknown as Array<{ name: string; handler: (a: Record<string, unknown>) => Promise<unknown>; parameters: Array<{ name: string }> }>;
    expect(actions.map((a) => a.name)).toEqual(["eiris_incidents", "eiris_incident_detail", "opd_signals", "audit_findings", "audit_finding_detail"]);
    const out = SourceTablePayload.parse(await actions[2].handler({ limit: 1 }));
    expect(out.row_count).toBe(1);
    expect(await actions[1].handler({ incident_id: "nope" })).toEqual({ ok: false, error: "bad_params" });
    // The actor is fixed at build time; no action parameter can name another staff member or a role.
    expect(actions.flatMap((a) => a.parameters.map((p) => p.name))).not.toEqual(expect.arrayContaining(["staff_id", "role"]));
  });
});
