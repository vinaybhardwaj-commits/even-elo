// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSurgicalRead, runSurgicalWrite, queryHash, writeRequests, type SurgicalActor } from "../run";
import { buildSurgicalActions } from "../actions";
import { SURGICAL_READ_NAMES, SURGICAL_READ_PARAMS, SURGICAL_WRITE_NAMES, SURGICAL_WRITE_PARAMS, SECOND_FACTOR_AVAILABLE } from "../schema";
import { SourceTablePayload } from "@/lib/screens/tool-schema";

const VC = "11111111-1111-4111-8111-111111111111";
const CASE = "33333333-3333-4333-8333-333333333333";
const SESSION = "aaa.bbb.ccc";
const ACTOR: SurgicalActor = { staffId: "staff-1", role: "super_admin", session: SESSION, position: "Medical Director" };

const VCS = { ok: true, vcs: [{ id: VC, full_name: "Dr Example", specialty: "Ortho", registration_no: "R1", status: "active", notes: "SECRET-NOTE", updated_at: "2026-10-01T00:00:00Z" }, { id: "x", full_name: "Dr Two", specialty: "ENT", status: "suspended" }] };
const CASES = { ok: true, cases: [{ id: CASE, case_ref: "C-001", vc_id: VC, surgeon_name: "Dr Example", specialty: "Ortho", surgery_date: "2026-09-30", procedure_label: "TKR", case_status: "completed", los_days: 3, patient_name: "SECRET-PATIENT", patient_mrn: "SECRET-MRN", notes: "SECRET-CASE-NOTE" }] };
const WEIGHTS = { ok: true, versions: [{ id: "w1", caseload_pct: 40, outcomes_pct: 40, adherence_pct: 20, is_current: true, effective_from: "2026-09-01", set_by_position: "MD", rationale: "r" }] };
const BOARD = { ok: true, rows: [{ vc_id: VC, full_name: "Dr Example", specialty: "Ortho", status: "active", composite: 71.234, tier: "Gold", low_confidence: false }], distribution: { Gold: 1 } };
const DETAIL = {
  ok: true,
  vc: { id: VC, full_name: "Dr Example", specialty: "Ortho", status: "active" },
  result: { composite: 71.2, tier: "Gold", low_confidence: false, total_observations: 9, case_count_window: 4, caseload: { score: 60, streams: [{ stream_id: "s1", sub_score: 50, n_observations: 3 }] }, outcomes: { score: 70, streams: [] }, adherence: { score: 80, streams: [] } },
  streams: [{ id: "s1", label: "Volume" }],
  snapshot_history: [{ computed_at: "2026-10-01", composite: 70, tier: "Gold" }],
  cases: [{ id: CASE, case_ref: "C-001", surgery_date: "2026-09-30", procedure_label: "TKR", patient_name: "SECRET-PATIENT", case_status: "completed", observation_count: 5 }],
  activity: [{ at: "2026-10-02", actor_position: "MD", action: "edit_vc", entity_type: "vc", entity_id: VC, before_json: { patient_name: "SECRET-BEFORE" }, after_json: { patient_name: "SECRET-AFTER" }, case_ref_for_obs: null }],
  required_stream_count: 12,
  weights: { caseload_pct: 40, outcomes_pct: 40, adherence_pct: 20 },
};
const AUDIT = { ok: true, rows: [{ at: "2026-10-02", actor_position: "MD", action: "void", entity_type: "case", entity_id: CASE, before_json: { patient_name: "SECRET-BEFORE" }, after_json: { patient_mrn: "SECRET-AFTER" } }] };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("surgical tools", () => {
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
      if (url.includes("/detail")) return json(DETAIL);
      if (url.includes("/api/vcs")) return json(VCS);
      if (url.includes("/api/cases")) return json(CASES);
      if (url.includes("/api/weights")) return json(WEIGHTS);
      if (url.includes("/api/leaderboard")) return json(BOARD);
      if (url.includes("/api/audit")) return json(AUDIT);
      if (url.includes("/api/streams")) return json({ ok: true, streams: [{ id: "s1", label: "Volume", component: "caseload", active: true, floor_value: 1, target_value: 9 }] });
      if (url.includes("/api/positions")) return json({ ok: true, positions: [{ position_name: "MD", team: "A", description: "d", active: true }] });
      return json({}, 500);
    });
  });

  const upstreamCalls = () => calls.filter((c) => c.url.startsWith("https://elo.invalid"));
  const auditCalls = () => calls.filter((c) => c.url.startsWith("https://agent.invalid"));

  describe("role gate and session", () => {
    it.each(["sgc_member", "doctor", "hr", ""])("refuses role %j before any fetch", async (role) => {
      const r = await runSurgicalRead("surgical_vcs", {}, { ...ACTOR, role });
      expect(r.status).toBe(role ? 403 : 401);
      expect(calls).toHaveLength(0);
    });
    it("refuses a missing staff id and a missing or malformed session", async () => {
      expect((await runSurgicalRead("surgical_vcs", {}, { ...ACTOR, staffId: "" })).status).toBe(401);
      expect((await runSurgicalRead("surgical_vcs", {}, { ...ACTOR, session: null })).status).toBe(401);
      expect((await runSurgicalRead("surgical_vcs", {}, { ...ACTOR, session: "a.b.c\r\nX-Evil: 1" })).status).toBe(401);
      expect(calls).toHaveLength(0);
    });
    it("refuses every write for a non super_admin before any fetch", async () => {
      for (const action of SURGICAL_WRITE_NAMES) expect((await runSurgicalWrite(action, {}, { ...ACTOR, role: "sgc_member" })).status).toBe(403);
      expect(calls).toHaveLength(0);
    });
  });

  describe("reads", () => {
    it("forwards the staff session as the even-elo cookie, GET only, no redirects, fixed host", async () => {
      const r = await runSurgicalRead("surgical_vcs", { status: "all" }, ACTOR);
      expect(r.status).toBe(200);
      const [c] = upstreamCalls();
      expect(c.url).toBe("https://elo.invalid/api/vcs?status=all");
      expect(c.init?.method).toBe("GET");
      expect((c.init?.headers as Record<string, string>).Cookie).toBe(`epi_session=${SESSION}`);
      expect(c.init?.redirect).toBe("error");
      expect(JSON.stringify(c.init)).not.toContain("authorization");
    });

    it("returns a typed table with its source line for every read tool", async () => {
      const params: Record<string, unknown> = { surgical_vc_detail: { vc_id: VC } };
      for (const tool of SURGICAL_READ_NAMES) {
        const r = await runSurgicalRead(tool, params[tool] ?? {}, ACTOR);
        expect(r.status, tool).toBe(200);
        const parsed = SourceTablePayload.safeParse(r.body);
        expect(parsed.success, tool).toBe(true);
        expect((r.body as SourceTablePayload).source).toEqual({ tool, query_hash: queryHash(tool) });
        expect((r.body as SourceTablePayload).mode).toBe("live");
      }
      expect(auditCalls()).toHaveLength(SURGICAL_READ_NAMES.length);
    });

    it("never emits patient identity, notes or audit before/after content, in any section or tool", async () => {
      const bodies: string[] = [];
      for (const section of ["summary", "components", "snapshots", "cases", "activity"] as const) bodies.push(JSON.stringify((await runSurgicalRead("surgical_vc_detail", { vc_id: VC, section }, ACTOR)).body));
      for (const tool of ["surgical_cases", "surgical_audit_log", "surgical_vcs", "surgical_overview"] as const) bodies.push(JSON.stringify((await runSurgicalRead(tool, {}, ACTOR)).body));
      const all = bodies.join("\n");
      expect(all).not.toMatch(/SECRET/);
      expect(all).toContain("C-001"); // the case ref is the identifier
    });

    it("shapes values: scores rounded, overview counts derived", async () => {
      const board = (await runSurgicalRead("surgical_leaderboard", {}, ACTOR)).body as SourceTablePayload;
      expect(board.rows[0].composite).toBe(71.2);
      const ov = (await runSurgicalRead("surgical_overview", {}, ACTOR)).body as SourceTablePayload;
      const m = Object.fromEntries(ov.rows.map((r) => [r.metric, r.value]));
      expect(m).toMatchObject({ vcs_active: 1, vcs_total: 2, vcs_suspended: 1, cases_completed: 1, weights_current: "40/40/20", tier_gold: 1 });
    });

    it("refuses unknown keys, SQL-shaped values and non-uuid ids", async () => {
      expect((await runSurgicalRead("surgical_vcs", { status: "all'; DROP" }, ACTOR)).status).toBe(422);
      expect((await runSurgicalRead("surgical_vcs", { extra: 1 }, ACTOR)).status).toBe(422);
      expect((await runSurgicalRead("surgical_vc_detail", { vc_id: "../admin" }, ACTOR)).status).toBe(422);
      expect((await runSurgicalRead("surgical_audit_log", { action: "a b&x=1" }, ACTOR)).status).toBe(422);
      expect(calls).toHaveLength(0);
    });

    it("writes the audit row (metadata only) and withholds data when it cannot", async () => {
      await runSurgicalRead("surgical_vc_detail", { vc_id: VC }, ACTOR);
      const [a] = auditCalls();
      expect(a.url).toBe("https://agent.invalid/agent/audit");
      const body = JSON.parse(String(a.init?.body));
      expect(body).toMatchObject({ tool: "surgical_vc_detail", outcome: "ok" });
      expect(Object.keys(body).sort()).toEqual(["duration_ms", "outcome", "params", "row_count", "tool"]);
      expect(JSON.stringify(a.init?.headers)).not.toContain(SESSION);
      auditStatus = 500;
      const r = await runSurgicalRead("surgical_vcs", {}, ACTOR);
      expect(r).toMatchObject({ status: 503, body: { ok: false, error: "audit_unavailable" } });
      auditStatus = 429;
      expect((await runSurgicalRead("surgical_vcs", {}, ACTOR)).status).toBe(429);
    });

    it("returns fixed codes, never upstream text", async () => {
      for (const [status, want] of [[401, 403], [403, 403], [404, 404], [400, 422], [500, 502]] as const) {
        upstreamStatus = status;
        const r = await runSurgicalRead("surgical_vcs", {}, ACTOR);
        expect(r.status).toBe(want);
        expect(JSON.stringify(r.body)).not.toContain("SECRET");
      }
    });

    it("honours the live-reads kill switch with no upstream call", async () => {
      process.env.STUDIO_LIVE_READS = "0";
      expect((await runSurgicalRead("surgical_vcs", {}, ACTOR)).body).toEqual({ ok: false, error: "live_reads_off" });
      expect(calls).toHaveLength(0);
    });
  });

  describe("writes", () => {
    const valid: Record<string, unknown> = {
      vc_create: { full_name: "Dr N", specialty: "ENT" },
      vc_update: { vc_id: VC, status: "terminated" },
      stream_update: { stream_id: VC, floor_value: 1, target_value: 9, recompute_all: true },
      weights_apply: { caseload_pct: 50, outcomes_pct: 30, adherence_pct: 20 },
      position_update: { position_name: "MD", description: "d" },
      case_void: { case_id: CASE },
      recompute_all: {},
    };

    it("is off today: no second factor, every write answers needs_second_factor and sends nothing", async () => {
      expect(SECOND_FACTOR_AVAILABLE).toBe(false);
      for (const action of SURGICAL_WRITE_NAMES) {
        const r = await runSurgicalWrite(action, valid[action], ACTOR);
        expect(r, action).toMatchObject({ status: 403, body: { ok: false, error: "needs_second_factor" } });
      }
      expect(calls).toHaveLength(0);
    });

    it("with a verifier: audits first, then calls the existing route with the session and actor_position", async () => {
      const ok = async () => true;
      const r = await runSurgicalWrite("vc_update", valid.vc_update, ACTOR, { secondFactor: ok });
      expect(r).toEqual({ status: 200, body: { ok: true, action: "vc_update" } });
      expect(calls.map((c) => c.url)).toEqual(["https://agent.invalid/agent/audit", `https://elo.invalid/api/vcs/${VC}`]);
      const audit = JSON.parse(String(calls[0].init?.body));
      expect(audit).toMatchObject({ tool: "surgical_write", outcome: "ok", params: { action: "vc_update", vc_id: VC } });
      expect(calls[1].init?.method).toBe("PATCH");
      expect(JSON.parse(String(calls[1].init?.body))).toEqual({ status: "terminated", actor_position: "Medical Director" });
      expect((calls[1].init?.headers as Record<string, string>).Cookie).toBe(`epi_session=${SESSION}`);
    });

    it("fails closed when the audit row cannot be written: the route is never called", async () => {
      auditStatus = 500;
      const r = await runSurgicalWrite("weights_apply", valid.weights_apply, ACTOR, { secondFactor: async () => true });
      expect(r.status).toBe(503);
      expect(upstreamCalls()).toHaveLength(0);
    });

    it("needs a position claim and validates params (weights must sum to 100, no unknown keys)", async () => {
      const sf = { secondFactor: async () => true };
      expect((await runSurgicalWrite("vc_update", valid.vc_update, { ...ACTOR, position: null }, sf)).status).toBe(403);
      expect((await runSurgicalWrite("weights_apply", { caseload_pct: 50, outcomes_pct: 30, adherence_pct: 30 }, ACTOR, sf)).status).toBe(422);
      expect((await runSurgicalWrite("vc_create", { full_name: "x", specialty: "y", id: "z" }, ACTOR, sf)).status).toBe(422);
      expect((await runSurgicalWrite("case_void", { case_id: "../x" }, ACTOR, sf)).status).toBe(422);
      expect(calls).toHaveLength(0);
    });

    it("maps each action to ONE fixed existing route; nothing deletes", () => {
      const all = SURGICAL_WRITE_NAMES.flatMap((a) => writeRequests(a, SURGICAL_WRITE_PARAMS[a].parse(valid[a]) as Record<string, unknown>, "MD"));
      expect(all.map((r) => `${r.method} ${r.path.replace(VC, "{id}").replace(CASE, "{id}")}`)).toEqual([
        "POST /api/vcs",
        "PATCH /api/vcs/{id}",
        "PATCH /api/streams/{id}",
        "POST /api/admin/recompute?all=true",
        "POST /api/weights",
        "PATCH /api/positions",
        "PATCH /api/cases/{id}",
        "POST /api/admin/recompute?all=true",
      ]);
      expect(all.some((r) => (r.method as string) === "DELETE")).toBe(false);
      expect(writeRequests("case_void", { case_id: CASE }, "MD")[0].body).toMatchObject({ case_status: "voided" });
    });

    it("surfaces only fixed codes when the existing route refuses", async () => {
      upstreamStatus = 400;
      const r = await runSurgicalWrite("vc_create", valid.vc_create, ACTOR, { secondFactor: async () => true });
      expect(r).toMatchObject({ status: 422, body: { ok: false, error: "rejected" } });
      expect(JSON.stringify(r)).not.toContain("SECRET");
    });
  });

  describe("chat actions", () => {
    it("are the nine reads only, no write action, and run through the same gate", async () => {
      const actions = buildSurgicalActions(ACTOR) as unknown as Array<{ name: string; handler: (a: Record<string, unknown>) => Promise<unknown> }>;
      expect(actions.map((a) => a.name).sort()).toEqual([...SURGICAL_READ_NAMES].sort());
      const vcs = actions.find((a) => a.name === "surgical_vcs")!;
      expect((await vcs.handler({})) as SourceTablePayload).toMatchObject({ source: { tool: "surgical_vcs" } });
      // A role that may not open the Surgical screen is not offered the tools at all.
      expect(buildSurgicalActions({ ...ACTOR, role: "staff,sgc_member" })).toEqual([]);
    });
  });

  it("schemas are strict", () => {
    for (const n of SURGICAL_READ_NAMES) expect(SURGICAL_READ_PARAMS[n].safeParse({ nope: 1 }).success).toBe(false);
  });
});
