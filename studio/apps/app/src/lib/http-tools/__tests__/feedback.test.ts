// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runFeedback, toFeedbackPayload } from "../feedback";
import { FeedbackPayload } from "@/lib/screens/feedback-schema";

const ACTOR = { staffId: "staff-1", role: "super_admin", sessionCookie: "tok" };
const FID = "33333333-3333-4333-8333-333333333333";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const LIST = {
  ok: true,
  total: 2,
  rows: [
    { id: FID, target_physician_id: "p1", target_physician_name: "Dr A", target_physician_email: "SECRET-EMAIL", submitted_at: "2026-10-01T10:00:00Z", submitter_label: "SECRET-SUBMITTER", anonymous_flag: true, hospital_code: "RR", category: "clinical", severity: "high", polarity: "negative", source: "patient", patient_rating: 2, narrative_preview: "SECRET-NARRATIVE", status: "open", retracted_at: null, retraction_reason: "SECRET-REASON", reply_count: 1, last_reply_at: "2026-10-02T10:00:00Z" },
    { id: "44444444-4444-4444-8444-444444444444", target_physician_id: "p2", target_physician_name: "Dr B", submitted_at: "2026-09-01T10:00:00Z", severity: "low", status: "retracted", reply_count: 3 },
  ],
  counts: [{ status: "open", severity: "high", n: 4 }, { status: "retracted", severity: "low", n: 1 }],
};

describe("feedback", () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let auditStatus = 200;
  let up: (url: string, init?: RequestInit) => Response;
  beforeEach(() => {
    calls.length = 0;
    auditStatus = 200;
    up = () => json(LIST);
    process.env.EVENELO_API_BASE = "https://elo.invalid/";
    process.env.AGENT_URL = "https://agent.invalid/agent";
    process.env.STUDIO_SERVICE_TOKEN = "svc";
    process.env.STUDIO_ACTOR_SECRET = "actor-secret-0123456789abcdef0123456789";
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return url.endsWith("/audit") ? json({ ok: true }, auditStatus) : up(url, init);
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ["EVENELO_API_BASE", "AGENT_URL", "STUDIO_SERVICE_TOKEN", "STUDIO_ACTOR_SECRET", "STUDIO_LIVE_READS"]) delete process.env[k];
  });
  const audits = () => calls.filter((c) => c.url.endsWith("/audit")).map((c) => JSON.parse(String(c.init?.body)));
  const upstream = () => calls.filter((c) => !c.url.endsWith("/audit"));

  it("lists with the session forwarded; typed tables with source lines; no narrative, submitter or email; one audit row", async () => {
    const r = await runFeedback("list", { status: "open", severity: "high", limit: 50 }, ACTOR);
    expect(r.status).toBe(200);
    const p = FeedbackPayload.parse(r.body);
    expect(p.items.source.tool).toBe("patient_feedback");
    expect(p.items.rows[0]).toMatchObject({ feedback_id: FID, physician_name: "Dr A", reply_state: "replied", reply_count: 1 });
    expect(p.items.rows[1].reply_state).toBe("retracted");
    expect(p.counts.rows[0]).toEqual({ status: "open", severity: "high", feedback: 4 });
    const text = JSON.stringify(p);
    for (const s of ["SECRET-NARRATIVE", "SECRET-SUBMITTER", "SECRET-EMAIL", "SECRET-REASON"]) expect(text).not.toContain(s);
    expect(p.write_enabled).toBe(false);
    expect(upstream()[0].url).toBe("https://elo.invalid/api/incidents?status=open&severity=high&limit=50");
    expect((upstream()[0].init?.headers as Record<string, string>).Cookie).toBe("epi_session=tok");
    expect(upstream()[0].init?.redirect).toBe("error");
    expect(audits()).toEqual([{ tool: "patient_feedback", params: { status: "open", severity: "high", limit: 50 }, row_count: 2, duration_ms: expect.any(Number), outcome: "ok" }]);
  });

  it("role gate before any fetch; bad params; kill switch; missing config", async () => {
    expect((await runFeedback("list", {}, { ...ACTOR, role: "rmo" })).status).toBe(403);
    expect((await runFeedback("list", { sql: "x" }, ACTOR)).status).toBe(422);
    expect((await runFeedback("list", { status: "deleted" }, ACTOR)).status).toBe(422);
    expect((await runFeedback("list", {}, { ...ACTOR, staffId: "" })).status).toBe(401);
    expect(calls).toHaveLength(0);
    process.env.STUDIO_LIVE_READS = "off";
    expect((await runFeedback("list", {}, ACTOR)).status).toBe(503);
    delete process.env.STUDIO_LIVE_READS;
    expect((await runFeedback("list", {}, { ...ACTOR, sessionCookie: null })).status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("withholds data when the audit row fails; upstream 401 and junk bodies give fixed codes", async () => {
    auditStatus = 500;
    expect(await runFeedback("list", {}, ACTOR)).toMatchObject({ status: 503, body: { error: "audit_unavailable" } });
    auditStatus = 200;
    up = () => json({ ok: false, error: "Unauthenticated SECRET" }, 401);
    expect(await runFeedback("list", {}, ACTOR)).toMatchObject({ status: 401, body: { error: "unauthorized" } });
    up = () => json({ nope: 1 });
    expect(await runFeedback("list", {}, ACTOR)).toMatchObject({ status: 502, body: { error: "bad_payload" } });
  });

  it("retract is refused (403 second_factor_required) before any upstream call while G3 is absent", async () => {
    expect(await runFeedback("retract", { feedback_id: FID, retraction_reason: "dup" }, ACTOR)).toMatchObject({ status: 403, body: { error: "second_factor_required" } });
    expect(calls).toHaveLength(0);
    expect((await runFeedback("retract", { feedback_id: "nope", retraction_reason: "dup" }, ACTOR)).status).toBe(422);
    expect((await runFeedback("retract", { feedback_id: FID }, ACTOR)).status).toBe(422);
    expect((await runFeedback("retract", { feedback_id: FID, retraction_reason: "dup", status: "open" }, ACTOR)).status).toBe(422);
  });

  it("with a second factor, retract PATCHes the existing route as a status change, audits the id only; super_admin only", async () => {
    up = () => json({ ok: true, incident: {} });
    const ok = { secondFactorOk: async () => true };
    const r = await runFeedback("retract", { feedback_id: FID, retraction_reason: "entered in error" }, ACTOR, ok);
    expect(r).toMatchObject({ status: 200, body: { ok: true, audit_recorded: true } });
    expect(upstream()[0].url).toBe(`https://elo.invalid/api/incidents/${FID}`);
    expect(upstream()[0].init?.method).toBe("PATCH");
    expect(JSON.parse(String(upstream()[0].init?.body))).toEqual({ status: "retracted", retraction_reason: "entered in error" });
    expect(audits()[0]).toEqual({ tool: "feedback_retract", params: { feedback_id: FID }, row_count: 1, duration_ms: expect.any(Number), outcome: "ok" });
    expect(JSON.stringify(audits())).not.toContain("entered in error");
    calls.length = 0;
    expect((await runFeedback("retract", { feedback_id: FID, retraction_reason: "x" }, { ...ACTOR, role: "sgc_member" }, ok)).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("a failed retract maps to a fixed code and records an error audit", async () => {
    up = () => json({ ok: false, error: "already retracted" }, 409);
    const ok = { secondFactorOk: async () => true };
    expect(await runFeedback("retract", { feedback_id: FID, retraction_reason: "x" }, ACTOR, ok)).toMatchObject({ status: 409, body: { error: "already_retracted" } });
    up = () => json({ ok: false, error: "db_error SECRET" }, 500);
    expect(await runFeedback("retract", { feedback_id: FID, retraction_reason: "x" }, ACTOR, ok)).toMatchObject({ status: 502, body: { error: "upstream_failed" } });
    expect(audits().every((a) => a.outcome === "error" && a.row_count === 0)).toBe(true);
  });

  it("toFeedbackPayload refuses a body that is not the list", () => {
    expect(toFeedbackPayload({ ok: true }, false)).toBeNull();
    expect(toFeedbackPayload(null, false)).toBeNull();
  });
});
