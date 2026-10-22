// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRmo, toInboxPayload } from "../rmo";
import { RmoInboxPayload } from "@/lib/screens/rmo-schema";

const ACTOR = { staffId: "staff-1", role: "super_admin", sessionCookie: "tok" };
const FID = "33333333-3333-4333-8333-333333333333";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const INBOX = {
  ok: true,
  headline: { open: 2, sla_risk: 1 },
  pipe_counts: { open: 2, in_progress: 0, remediated: 0, contested: 0, escalated: 1 },
  items: [{ finding_id: FID, audit_id: "a", finding_label: "Missing plan", severity: "high", status: "open", physician_id: "p", physician_name: "Dr A", portal_visible: false, author_pending: true, open_age_days: 3, SECRET_EXTRA: "x" }],
  exceptions: [{ finding_id: FID, finding_label: "Missing plan", severity: "high", exception_score: 9 }],
  doctors: [],
};

describe("rmo", () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let auditStatus = 200;
  let up: (url: string, init?: RequestInit) => Response;
  beforeEach(() => {
    calls.length = 0;
    auditStatus = 200;
    up = () => json(INBOX);
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

  it("reads the inbox with the session forwarded, typed tables with source lines, one audit row", async () => {
    const r = await runRmo("inbox", { pipe: "open", q: "ab" }, ACTOR);
    expect(r.status).toBe(200);
    const p = RmoInboxPayload.parse(r.body);
    expect(p.items.source.tool).toBe("rmo_inbox");
    expect(p.items.rows[0].finding_label).toBe("Missing plan");
    expect(JSON.stringify(p)).not.toContain("SECRET_EXTRA");
    expect(p.write_enabled).toBe(false);
    expect(p.counts.rows.find((x) => x.metric === "sla_risk")?.value).toBe(1);
    expect(upstream()[0].url).toBe("https://elo.invalid/api/rmo-inbox?pipe=open&q=ab");
    expect((upstream()[0].init?.headers as Record<string, string>).Cookie).toBe("epi_session=tok");
    expect(upstream()[0].init?.redirect).toBe("error");
    expect(audits()).toEqual([{ tool: "rmo_inbox", params: { pipe: "open", q: "ab" }, row_count: 1, duration_ms: expect.any(Number), outcome: "ok" }]);
  });

  it("role gate before any fetch; bad params; kill switch; missing config", async () => {
    expect((await runRmo("inbox", {}, { ...ACTOR, role: "rmo" })).status).toBe(403);
    expect((await runRmo("inbox", { sql: "x" }, ACTOR)).status).toBe(422);
    expect((await runRmo("inbox", {}, { ...ACTOR, staffId: "" })).status).toBe(401);
    expect(calls).toHaveLength(0);
    process.env.STUDIO_LIVE_READS = "off";
    expect((await runRmo("inbox", {}, ACTOR)).status).toBe(503);
    delete process.env.STUDIO_LIVE_READS;
    expect((await runRmo("inbox", {}, { ...ACTOR, sessionCookie: null })).status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("withholds data when the audit row fails; upstream 401 and junk bodies give fixed codes", async () => {
    auditStatus = 500;
    const r = await runRmo("inbox", {}, ACTOR);
    expect(r).toMatchObject({ status: 503, body: { error: "audit_unavailable" } });
    auditStatus = 200;
    up = () => json({ ok: false, error: "Not authenticated SECRET" }, 401);
    expect(await runRmo("inbox", {}, ACTOR)).toMatchObject({ status: 401, body: { error: "unauthorized" } });
    up = () => json({ nope: 1 });
    expect(await runRmo("inbox", {}, ACTOR)).toMatchObject({ status: 502, body: { error: "bad_payload" } });
  });

  it("an audit POST that hits a stale socket is re-sent once and the inbox read still succeeds", async () => {
    let auditSends = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/audit")) {
        auditSends += 1;
        if (auditSends === 1) throw new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
        return json({ ok: true }, auditStatus);
      }
      return up(url, init);
    });
    const r = await runRmo("inbox", {}, ACTOR);
    expect(r.status).toBe(200);
    expect(auditSends).toBe(2);
    expect(upstream()).toHaveLength(1);
  });

  it("writes are refused (403 second_factor_required) before any upstream call while G3 is absent", async () => {
    for (const op of ["author", "release"] as const) {
      expect(await runRmo(op, { finding_id: FID }, ACTOR)).toMatchObject({ status: 403, body: { error: "second_factor_required" } });
    }
    expect(calls).toHaveLength(0);
    expect((await runRmo("release", { finding_id: "nope" }, ACTOR)).status).toBe(422);
    expect((await runRmo("author", { finding_id: FID, staff_id: "x" }, ACTOR)).status).toBe(422);
  });

  it("with a second factor, a write calls the existing even-elo route and audits ids only", async () => {
    up = () => json({ ok: true, response_owner: "local" });
    const r = await runRmo("release", { finding_id: FID }, ACTOR, { secondFactorOk: async () => true });
    expect(r).toMatchObject({ status: 200, body: { ok: true, audit_recorded: true } });
    expect(upstream()[0].url).toBe("https://elo.invalid/api/rmo-inbox/release");
    expect(upstream()[0].init?.method).toBe("POST");
    expect(JSON.parse(String(upstream()[0].init?.body))).toEqual({ finding_id: FID });
    expect(audits()[0]).toMatchObject({ tool: "rmo_release", params: { finding_id: FID }, row_count: 1, outcome: "ok" });
  });

  it("a failed write maps to a fixed code and records an error audit", async () => {
    up = () => json({ ok: false, error: "db_error SECRET" }, 400);
    const r = await runRmo("author", { finding_id: FID, authored_by_name: "Dr R" }, ACTOR, { secondFactorOk: async () => true });
    expect(r).toMatchObject({ status: 400, body: { error: "upstream_failed" } });
    expect(audits()[0]).toMatchObject({ tool: "rmo_author", outcome: "error", row_count: 0 });
  });

  it("query_hash differs by filter", async () => {
    const a = await runRmo("inbox", { pipe: "open" }, ACTOR);
    const b = await runRmo("inbox", { pipe: "escalated" }, ACTOR);
    const hash = (r: Awaited<ReturnType<typeof runRmo>>) => (r.body as { items: { source: { query_hash: string } } }).items.source.query_hash;
    expect(hash(a)).not.toBe(hash(b));
  });

  it("toInboxPayload refuses a body that is not the inbox", () => {
    expect(toInboxPayload({ ok: true }, false)).toBeNull();
    expect(toInboxPayload(null, false)).toBeNull();
  });
});
