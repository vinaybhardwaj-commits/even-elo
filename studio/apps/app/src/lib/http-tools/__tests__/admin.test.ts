// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAdmin } from "../admin";
import { ADMIN_OPS, AdminPayload } from "@/lib/screens/admin-schema";

const ACTOR = { staffId: "staff-1", role: "super_admin", sessionCookie: "tok" };
const PID = "22222222-2222-4222-8222-222222222222";
const RID = "55555555-5555-4555-8555-555555555555";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const yes = async () => true;

const USERS = {
  ok: true,
  total: 1,
  counts: { active: 3, pending_approval: 1 },
  rows: [{ id: PID, email: "a@even.in", full_name: "Staff A", status: "active", is_super_admin: false, is_hr: true, is_sgc_member: true, password_hash: "SECRET-HASH", requested_roles: "SECRET-REQ", position_label: "HR", hospital_code: "RR", last_login_at: "2026-10-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z" }],
};

describe("admin", () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let auditStatus = 200;
  let up: (url: string, init?: RequestInit) => Response;
  beforeEach(() => {
    calls.length = 0;
    auditStatus = 200;
    up = () => json(USERS);
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

  it("lists users with the session forwarded; allowlisted columns; flags folded to roles; one audit row", async () => {
    const r = await runAdmin("users", { status: "active" }, ACTOR);
    expect(r.status).toBe(200);
    const p = AdminPayload.parse(r.body);
    expect(p.table.source.tool).toBe("admin_users");
    expect(p.table.rows[0]).toMatchObject({ profile_id: PID, full_name: "Staff A", roles: "hr, sgc_member" });
    expect(p.counts?.rows).toEqual([{ status: "active", users: 3 }, { status: "pending_approval", users: 1 }]);
    const text = JSON.stringify(p);
    for (const s of ["SECRET-HASH", "SECRET-REQ"]) expect(text).not.toContain(s);
    expect(p.write_enabled).toBe(false);
    expect(upstream()[0].url).toBe("https://elo.invalid/api/admin/profiles?status=active");
    expect((upstream()[0].init?.headers as Record<string, string>).Cookie).toBe("epi_session=tok");
    expect(upstream()[0].init?.redirect).toBe("error");
    expect(audits()).toEqual([{ tool: "admin_users", params: { status: "active" }, row_count: 1, duration_ms: expect.any(Number), outcome: "ok" }]);
  });

  it("roles, resignations and audit hit only their own routes and show reason text and before/after JSON but never credentials", async () => {
    up = (url) =>
      url.includes("/roles") ? json({ ok: true, roles: [{ role: "hr", hospital_code: "RR", hospital_id: "x", granted_at: "2026-02-01" }] })
      : url.includes("/resignations") ? json({ ok: true, rows: [{ id: RID, physician_name: "Dr A", reason: "SECRET-REASON", status: "pending", hospital_code: "RR", intended_last_date: "2026-12-01", requested_at: "2026-10-01" }] })
      : json({ ok: true, rows: [{ at: "2026-10-01", actor_position: "Super", action: "grant_role", entity_type: "profile", entity_id: PID, before_json: "SECRET-BEFORE", after_json: "SECRET-AFTER" }] });
    const a = await runAdmin("roles", { profile_id: PID }, ACTOR);
    const b = await runAdmin("resignations", {}, ACTOR);
    const c = await runAdmin("audit", { action: "grant_role", limit: 20 }, ACTOR);
    for (const r of [a, b, c]) expect(r.status).toBe(200);
    const text = JSON.stringify([a.body, b.body, c.body]);
    for (const s of ["SECRET-REASON", "SECRET-BEFORE", "SECRET-AFTER"]) expect(text).toContain(s);
    expect(text).not.toContain("hospital_id");
    expect((b.body as AdminPayload).table.rows[0].request_id).toBe(RID);
    expect(upstream().map((u) => u.url)).toEqual([
      `https://elo.invalid/api/admin/profiles/${PID}/roles`,
      "https://elo.invalid/api/admin/resignations",
      "https://elo.invalid/api/audit?action=grant_role&limit=20&offset=0&format=json",
    ]);
  });

  it("is super_admin only: 403 before any upstream call or audit", async () => {
    for (const role of ["sgc_member", "site_medical_head", "hr"]) {
      const r = await runAdmin("users", {}, { ...ACTOR, role });
      expect(r.status).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  it("refuses unknown ops' params, extra keys and bad ids; the op set has no ops routes", async () => {
    expect((await runAdmin("users", { status: "x" }, ACTOR)).status).toBe(422);
    expect((await runAdmin("users", { sql: "select 1" }, ACTOR)).status).toBe(422);
    expect((await runAdmin("roles", { profile_id: "../migrate" }, ACTOR)).status).toBe(422);
    expect((await runAdmin("audit", { action: "a b; drop" }, ACTOR)).status).toBe(422);
    expect(calls).toEqual([]);
    expect(ADMIN_OPS.join()).not.toMatch(/migrate|seed|wipe|dedupe|recompute/);
  });

  it("fails closed when the audit row cannot be written, and honours the live-reads kill switch", async () => {
    auditStatus = 500;
    expect((await runAdmin("users", {}, ACTOR)).status).toBe(503);
    process.env.STUDIO_LIVE_READS = "off";
    calls.length = 0;
    expect((await runAdmin("users", {}, ACTOR)).status).toBe(503);
    expect(calls).toEqual([]);
  });

  it("an audit POST that hits a stale socket is re-sent once and the read still succeeds", async () => {
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
    const r = await runAdmin("users", {}, ACTOR);
    expect(r.status).toBe(200);
    expect(auditSends).toBe(2);
    expect(upstream()).toHaveLength(1);
  });

  it("maps upstream failures to fixed codes without echoing text", async () => {
    up = () => json({ ok: false, error: "SECRET-UPSTREAM" }, 500);
    const r = await runAdmin("users", {}, ACTOR);
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).not.toContain("SECRET");
    up = () => json({ ok: false }, 401);
    expect((await runAdmin("users", {}, ACTOR)).status).toBe(401);
  });

  describe("writes", () => {
    it("refuse with second_factor_required before any upstream call while there is no second factor", async () => {
      for (const [op, p] of [["set_status", { profile_id: PID, status: "suspended" }], ["grant_role", { profile_id: PID, hospital_code: "rr", role: "hr" }], ["process_resignation", { request_id: RID }]] as const) {
        const r = await runAdmin(op, p, ACTOR);
        expect(r).toMatchObject({ status: 403, body: { error: "second_factor_required" } });
      }
      expect(calls).toEqual([]);
    });

    it("call the existing routes with the session; grant is granted:true only; audit has ids only", async () => {
      up = () => json({ ok: true });
      expect((await runAdmin("set_status", { profile_id: PID, status: "suspended" }, ACTOR, { secondFactorOk: yes })).status).toBe(200);
      expect((await runAdmin("grant_role", { profile_id: PID, hospital_code: "rr", role: "hr" }, ACTOR, { secondFactorOk: yes })).status).toBe(200);
      expect((await runAdmin("process_resignation", { request_id: RID }, ACTOR, { secondFactorOk: yes })).status).toBe(200);
      const u = upstream();
      expect(u.map((c) => [c.init?.method, c.url])).toEqual([
        ["PATCH", `https://elo.invalid/api/admin/profiles/${PID}`],
        ["POST", `https://elo.invalid/api/admin/profiles/${PID}/roles`],
        ["POST", `https://elo.invalid/api/admin/resignations/${RID}/process`],
      ]);
      expect(JSON.parse(String(u[0].init?.body))).toEqual({ status: "suspended" });
      expect(JSON.parse(String(u[1].init?.body))).toEqual({ hospital_code: "RR", role: "hr", granted: true });
      expect(audits().map((a) => a.tool)).toEqual(["admin_set_status", "admin_grant_role", "admin_process_resignation"]);
      expect(audits().every((a) => a.outcome === "ok" && a.row_count === 1)).toBe(true);
    });

    it("refuse statuses and roles outside the card, including is_super_admin and revoke", async () => {
      const f = { secondFactorOk: yes };
      expect((await runAdmin("set_status", { profile_id: PID, status: "inactive" }, ACTOR, f)).status).toBe(422);
      expect((await runAdmin("set_status", { profile_id: PID, status: "active", is_super_admin: true }, ACTOR, f)).status).toBe(422);
      expect((await runAdmin("grant_role", { profile_id: PID, hospital_code: "RR", role: "hr", granted: false }, ACTOR, f)).status).toBe(422);
      expect((await runAdmin("grant_role", { profile_id: PID, hospital_code: "RR", role: "super_admin" }, ACTOR, f)).status).toBe(422);
      expect(calls).toEqual([]);
    });

    it("map known upstream errors to fixed codes and hide the rest; still audit the failure", async () => {
      up = () => json({ ok: false, error: "already processed" }, 409);
      expect(await runAdmin("process_resignation", { request_id: RID }, ACTOR, { secondFactorOk: yes })).toMatchObject({ status: 409, body: { error: "already_processed" } });
      up = () => json({ ok: false, error: "SECRET-SQL-TEXT" }, 500);
      const r = await runAdmin("process_resignation", { request_id: RID }, ACTOR, { secondFactorOk: yes });
      expect(r).toMatchObject({ status: 502, body: { error: "upstream_failed" } });
      expect(JSON.stringify(r.body)).not.toContain("SECRET");
      expect(audits().map((a) => a.outcome)).toEqual(["error", "error"]);
    });

    it("are super_admin only", async () => {
      expect((await runAdmin("process_resignation", { request_id: RID }, { ...ACTOR, role: "sgc_member" }, { secondFactorOk: yes })).status).toBe(403);
      expect(calls).toEqual([]);
    });
  });
});
