// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runOnboardingRead, runOnboardingWrite, queryHash, writeRequests, type OnboardingActor } from "../run";
import { buildOnboardingActions } from "../actions";
import { ONBOARDING_READ_NAMES, ONBOARDING_READ_PARAMS, ONBOARDING_WRITE_NAMES, ONBOARDING_WRITE_PARAMS, SECOND_FACTOR_AVAILABLE } from "../schema";
import { SourceTablePayload } from "@/lib/screens/tool-schema";

const PS = "11111111-1111-4111-8111-111111111111";
const HOSP = "22222222-2222-4222-8222-222222222222";
const SESSION = "aaa.bbb.ccc";
const ACTOR: OnboardingActor = { staffId: "staff-1", role: "super_admin", session: SESSION };

const LIST = {
  ok: true,
  counts: { observation: 2, onboarded: 5, rejected: 1 },
  total: 1,
  rows: [{ id: PS, prospective_email: "dr@example.test", prospective_full_name: "Dr Example", prospective_specialty: "Ortho", hospital_code: "H1", hospital_codes: ["H1", "H2"], stage: "observation", decision: "invite", years_post_postgraduate: 9, red_flags: "x".repeat(400), prescreened_by_email: "hr@example.test", prescreened_at: "2026-10-01T00:00:00Z", decided_at: null, physician_id: null }],
};
const DETAIL = {
  ok: true,
  prescreen: { id: PS, prospective_email: "dr@example.test", prospective_full_name: "Dr Example", hospital_code: "H1", hospital_name: "Hospital One", hospital_codes: ["H1"], stage: "observation", trigger: "new_visiting_consultant", commitments_acknowledged: { ot_timings: true, formulary: false }, cases_per_hospital: { H1: 2 }, decision: "invite" },
};
const OBS = { ok: true, allowed_roles: ["x"], rows: [{ id: "o1", case_number: 1, case_date: "2026-10-02", procedure: "TKR", observer_role: "OT Coordinator", observer_name: "Obs One", observer_email: "SECRET-EMAIL@example.test", scores: { teamwork: 4, outcome: 5 }, narrative_notes: "SECRET-NARRATIVE patient", flag_severity: "none", trigger: "new_visiting_consultant" }] };
const PENDING = { ok: true, rows: [{ id: "q1", physician_id: "p1", physician_name: "Dr Q", primary_specialty: "ENT", degree: "MS", year_completed: 2010, institution: "Inst", country: "IN", has_file: true, filename: "d.pdf", file_data: "SECRET-FILE", created_at: "2026-09-01" }] };
const HOSPITALS = { ok: true, hospitals: [{ id: HOSP, code: "H1", name: "Hospital One", is_active: true }] };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("onboarding tools", () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let auditStatus = 200;
  let upstreamStatus = 200;

  beforeEach(() => {
    calls.length = 0;
    auditStatus = 200;
    upstreamStatus = 200;
    process.env.EVEN_ELO_API_BASE = "https://elo.invalid";
    process.env.AGENT_URL = "https://agent.invalid/agent";
    process.env.STUDIO_SERVICE_TOKEN = "svc";
    process.env.STUDIO_ACTOR_SECRET = "actor-secret-0123456789abcdef0123456789";
    delete process.env.STUDIO_LIVE_READS;
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.startsWith("https://agent.invalid")) return json({ ok: true }, auditStatus);
      if (upstreamStatus !== 200) return json({ ok: false, error: "SECRET-UPSTREAM-TEXT" }, upstreamStatus);
      if (init?.method && init.method !== "GET") return json({ ok: true });
      if (url.includes("/observations")) return json(OBS);
      if (url.includes("/api/vc-onboarding/prescreens/")) return json(DETAIL);
      if (url.includes("/api/vc-onboarding/prescreens")) return json(LIST);
      if (url.includes("/api/admin/qualifications/pending")) return json(PENDING);
      if (url.includes("/api/hospitals")) return json(HOSPITALS);
      return json({}, 500);
    });
  });

  const upstreamCalls = () => calls.filter((c) => c.url.startsWith("https://elo.invalid"));
  const auditCalls = () => calls.filter((c) => c.url.startsWith("https://agent.invalid"));

  describe("role gates (equal to the source pages) and session", () => {
    it.each(["sgc_member", "doctor", ""])("refuses role %j on the gated reads before any fetch", async (role) => {
      for (const t of ["onboarding_overview", "onboarding_pipeline"] as const) expect((await runOnboardingRead(t, {}, { ...ACTOR, role })).status).toBe(role ? 403 : 401);
      expect((await runOnboardingRead("onboarding_prescreen", { prescreen_id: PS }, { ...ACTOR, role })).status).toBe(role ? 403 : 401);
      expect(calls).toHaveLength(0);
    });
    it.each(["site_medical_head", "hr"])("%s may read the pipeline; credentials and hospitals need only a signed-in role", async (role) => {
      expect((await runOnboardingRead("onboarding_pipeline", {}, { ...ACTOR, role })).status).toBe(200);
      expect((await runOnboardingRead("onboarding_pending_credentials", {}, { ...ACTOR, role: "doctor" })).status).toBe(200);
      expect((await runOnboardingRead("onboarding_hospitals", {}, { ...ACTOR, role: "doctor" })).status).toBe(200);
    });
    it("write gates: create = super_admin/SMH/HR; decision = super_admin/SMH only; observation = any signed-in role", async () => {
      expect((await runOnboardingWrite("prescreen_decision", {}, { ...ACTOR, role: "hr" })).status).toBe(403);
      expect((await runOnboardingWrite("prescreen_create", {}, { ...ACTOR, role: "doctor" })).status).toBe(403);
      expect((await runOnboardingWrite("prescreen_decision", { prescreen_id: PS, decision: "terminate", rationale: "r" }, { ...ACTOR, role: "site_medical_head" })).status).toBe(403);
      expect((await runOnboardingWrite("observation_add", {}, { ...ACTOR, role: "doctor" })).status).toBe(422);
      expect(calls).toHaveLength(0);
    });
    it("refuses a missing staff id and a missing or malformed session", async () => {
      expect((await runOnboardingRead("onboarding_pipeline", {}, { ...ACTOR, staffId: "" })).status).toBe(401);
      expect((await runOnboardingRead("onboarding_pipeline", {}, { ...ACTOR, session: null })).status).toBe(401);
      expect((await runOnboardingRead("onboarding_pipeline", {}, { ...ACTOR, session: "a.b.c\r\nX-Evil: 1" })).status).toBe(401);
      expect(calls).toHaveLength(0);
    });
  });

  describe("reads", () => {
    it("forwards the staff session as the even-elo cookie, GET only, no redirects, fixed host", async () => {
      const r = await runOnboardingRead("onboarding_pipeline", { stage: "observation" }, ACTOR);
      expect(r.status).toBe(200);
      const [c] = upstreamCalls();
      expect(c.url).toBe("https://elo.invalid/api/vc-onboarding/prescreens?stage=observation");
      expect(c.init?.method).toBe("GET");
      expect((c.init?.headers as Record<string, string>).Cookie).toBe(`epi_session=${SESSION}`);
      expect(c.init?.redirect).toBe("error");
    });
    it("every read returns a valid SourceTablePayload with its own tool and query hash, and writes one audit row", async () => {
      const params: Record<string, unknown> = { onboarding_prescreen: { prescreen_id: PS } };
      for (const tool of ONBOARDING_READ_NAMES) {
        calls.length = 0;
        const r = await runOnboardingRead(tool, params[tool] ?? {}, ACTOR);
        expect(r.status).toBe(200);
        const p = SourceTablePayload.parse(r.body);
        expect(p.source).toEqual({ tool, query_hash: queryHash(tool) });
        expect(auditCalls()).toHaveLength(1);
      }
    });
    it("overview counts every stage and the pending credentials", async () => {
      const r = await runOnboardingRead("onboarding_overview", {}, ACTOR);
      const rows = (r.body as unknown as { rows: Array<{ metric: string; value: number }> }).rows;
      expect(rows.find((x) => x.metric === "stage_onboarded")?.value).toBe(5);
      expect(rows.find((x) => x.metric === "pipeline_total")?.value).toBe(8);
      expect(rows.find((x) => x.metric === "pending_credentials")?.value).toBe(1);
    });
    it("observations: scores by dimension, no narrative, no observer email", async () => {
      const r = await runOnboardingRead("onboarding_prescreen", { prescreen_id: PS, section: "observations" }, ACTOR);
      const s = JSON.stringify(r.body);
      expect(s).not.toContain("SECRET");
      const row = (r.body as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
      expect(row).toMatchObject({ case_number: 1, teamwork: 4, outcome: 5, has_notes: true, observer: "Obs One" });
    });
    it("credentials never carry file data; the pipeline shortens free text", async () => {
      const c = await runOnboardingRead("onboarding_pending_credentials", {}, ACTOR);
      expect(JSON.stringify(c.body)).not.toContain("SECRET");
      const p = await runOnboardingRead("onboarding_pipeline", {}, ACTOR);
      const row = (p.body as unknown as { rows: Array<{ red_flags: string; hospitals: string }> }).rows[0];
      expect(row.red_flags.length).toBeLessThan(170);
      expect(row.hospitals).toBe("H1, H2");
    });
    it("summary shows commitments and per-hospital case counts", async () => {
      const r = await runOnboardingRead("onboarding_prescreen", { prescreen_id: PS }, ACTOR);
      const rows = (r.body as unknown as { rows: Array<{ metric: string; value: unknown }> }).rows;
      expect(rows.find((x) => x.metric === "commitment_formulary")?.value).toBe(false);
      expect(rows.find((x) => x.metric === "cases_H1")?.value).toBe(2);
    });
    it("rejects unknown keys, bad ids and sql-ish values before any fetch", async () => {
      expect((await runOnboardingRead("onboarding_pipeline", { stage: "x'; drop table" }, ACTOR)).status).toBe(422);
      expect((await runOnboardingRead("onboarding_prescreen", { prescreen_id: "../admin" }, ACTOR)).status).toBe(422);
      expect((await runOnboardingRead("onboarding_pipeline", { sql: "select 1" }, ACTOR)).status).toBe(422);
      expect(calls).toHaveLength(0);
    });
    it("withholds data (503) when the audit row cannot be written; 429 passes through", async () => {
      auditStatus = 500;
      const r = await runOnboardingRead("onboarding_pipeline", {}, ACTOR);
      expect(r.status).toBe(503);
      expect(JSON.stringify(r.body)).not.toContain("Dr Example");
      auditStatus = 429;
      expect((await runOnboardingRead("onboarding_pipeline", {}, ACTOR)).status).toBe(429);
    });
    it("maps upstream failures to fixed codes, never upstream text", async () => {
      for (const [status, code, out] of [[403, "upstream_denied", 403], [404, "not_found", 404], [500, "upstream_failed", 502]] as const) {
        upstreamStatus = status;
        const r = await runOnboardingRead("onboarding_pipeline", {}, ACTOR);
        expect([r.status, (r.body as unknown as { error: string }).error]).toEqual([out, code]);
        expect(JSON.stringify(r.body)).not.toContain("SECRET");
      }
    });
    it("STUDIO_LIVE_READS=off stops every read before any fetch", async () => {
      process.env.STUDIO_LIVE_READS = "off";
      expect((await runOnboardingRead("onboarding_pipeline", {}, ACTOR)).status).toBe(503);
      expect(calls).toHaveLength(0);
    });
  });

  describe("writes (confirm cards, G3)", () => {
    const create = { prospective_email: "Dr@Example.test", prospective_full_name: "Dr Example", hospital_codes: ["H1"], decision: "invite" as const };
    it("second factor is not built: every write is 403 needs_second_factor and sends nothing", async () => {
      expect(SECOND_FACTOR_AVAILABLE).toBe(false);
      const r = await runOnboardingWrite("prescreen_create", create, ACTOR);
      expect([r.status, (r.body as unknown as { error: string }).error]).toEqual([403, "needs_second_factor"]);
      expect(calls).toHaveLength(0);
    });
    it("with a verifier: intent audit first, then exactly one existing route, POST only", async () => {
      const ok = async () => true;
      const r = await runOnboardingWrite("prescreen_decision", { prescreen_id: PS, decision: "confirm_privileges", rationale: "FPPE satisfactory" }, ACTOR, { secondFactor: ok });
      expect(r.status).toBe(200);
      expect(calls[0].url.startsWith("https://agent.invalid")).toBe(true);
      expect(JSON.parse(String(calls[0].init?.body)).tool).toBe("onboarding_write");
      const ups = upstreamCalls();
      expect(ups).toHaveLength(1);
      expect(ups[0].url).toBe(`https://elo.invalid/api/vc-onboarding/prescreens/${PS}/decision`);
      expect(ups[0].init?.method).toBe("POST");
      expect(JSON.parse(String(ups[0].init?.body))).toEqual({ decision: "confirm_privileges", rationale: "FPPE satisfactory" });
    });
    it("no audit row means no write", async () => {
      auditStatus = 500;
      const r = await runOnboardingWrite("prescreen_create", create, ACTOR, { secondFactor: async () => true });
      expect(r.status).toBe(503);
      expect(upstreamCalls()).toHaveLength(0);
    });
    it("a 409 from even-elo (cooldown, stage, case cap) surfaces as conflict without upstream text", async () => {
      upstreamStatus = 409;
      const r = await runOnboardingWrite("prescreen_create", create, ACTOR, { secondFactor: async () => true });
      expect([r.status, (r.body as unknown as { error: string }).error]).toEqual([409, "conflict"]);
    });
    it("no write maps to DELETE or to a non-onboarding path", () => {
      const sample: Record<string, Record<string, unknown>> = {
        prescreen_create: ONBOARDING_WRITE_PARAMS.prescreen_create.parse(create),
        prescreen_decision: { prescreen_id: PS, decision: "terminate", rationale: "r" },
        observation_add: { prescreen_id: PS, case_date: "2026-10-01", procedure: "p", observer_role: "r", hospital_id: HOSP, scores: { teamwork: 3, emr_documentation: 3, ot_etiquette: 3, protocol_adherence: 3, outcome: 3, demeanor: 3 } },
      };
      for (const a of ONBOARDING_WRITE_NAMES) for (const q of writeRequests(a, sample[a])) {
        expect(q.method).toBe("POST");
        expect(q.path.startsWith("/api/vc-onboarding/prescreens")).toBe(true);
      }
    });
    it("write params are strict: bad score, extra key, empty hospitals refused", () => {
      const sc = { teamwork: 3, emr_documentation: 3, ot_etiquette: 3, protocol_adherence: 3, outcome: 3, demeanor: 3 };
      const obs = { prescreen_id: PS, case_date: "2026-10-01", procedure: "p", observer_role: "r", hospital_id: HOSP, scores: sc };
      expect(ONBOARDING_WRITE_PARAMS.observation_add.safeParse(obs).success).toBe(true);
      expect(ONBOARDING_WRITE_PARAMS.observation_add.safeParse({ ...obs, scores: { ...sc, outcome: 6 } }).success).toBe(false);
      expect(ONBOARDING_WRITE_PARAMS.observation_add.safeParse({ ...obs, sql: "x" }).success).toBe(false);
      expect(ONBOARDING_WRITE_PARAMS.prescreen_create.safeParse({ ...create, hospital_codes: [] }).success).toBe(false);
      expect(ONBOARDING_WRITE_PARAMS.prescreen_decision.safeParse({ prescreen_id: PS, decision: "delete", rationale: "r" }).success).toBe(false);
    });
  });

  it("chat gets the read tools only, and read params cover every name", () => {
    const names = (buildOnboardingActions(ACTOR) as unknown as Array<{ name: string }>).map((a) => a.name).sort();
    expect(names).toEqual([...ONBOARDING_READ_NAMES].sort());
    expect(Object.keys(ONBOARDING_READ_PARAMS).sort()).toEqual([...ONBOARDING_READ_NAMES].sort());
  });
});
