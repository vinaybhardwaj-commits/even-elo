import { createHash } from "node:crypto";
import { fetchAgent } from "@/lib/agent-fetch";
import { agentHeaders } from "@/lib/zone/actor-token";
import { SESSION_COOKIE } from "@/lib/zone/authorize";
import {
  ADMIN_PARAMS,
  AUDIT_COLUMNS,
  RESIGNATION_COLUMNS,
  ROLE_COLUMNS,
  USER_COLUMNS,
  USER_COUNT_COLUMNS,
  isAdminWriteOp,
  type AdminOp,
  type AdminPayload,
} from "@/lib/screens/admin-schema";
import { liveReadsEnabled } from "./run";

// Admin (M3): the READ parts of even-elo /admin (users and profiles, hospital roles, resignation requests, audit log),
// read through even-elo's existing routes with the caller's epi_session forwarded, so even-elo applies its own auth.
// Same order as run.ts / feedback.ts: role gate, params, upstream, audit row, data. Env (names only): EVENELO_API_BASE,
// plus the agent trio the other reads use.
//
// Three writes, each a confirm card calling an EXISTING route: profile status (PATCH /api/admin/profiles/{id}),
// hospital role grant (POST .../roles) and resignation processing (POST .../process). They need the G3 second factor;
// none exists yet, so secondFactorOk is false and a write returns 403 second_factor_required before any upstream call.
// There is deliberately no path to migrate, seed, wipe-smoke, dedupe, recompute or any other ops route: the upstream
// paths below are the only ones this file can build.

const UPSTREAM_TIMEOUT_MS = 10_000;
const AUDIT_TIMEOUT_MS = 8_000;
/** The source routes are super_admin only (the resignation list also admits site_medical_head, which the Studio zone does not). */
export const ADMIN_ROLES: ReadonlySet<string> = new Set(["super_admin"]);

export type Actor = { staffId: string; role: string; sessionCookie?: string | null };
export type AdminResult = { status: number; body: unknown; headers?: Record<string, string> };
export type AdminDeps = { secondFactorOk?: (actor: Actor) => Promise<boolean> };

const fail = (status: number, error: string, headers?: Record<string, string>): AdminResult => ({
  status,
  body: { ok: false, error },
  ...(headers ? { headers } : {}),
});

const queryHash = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);

/** G3 second factor: not built yet, so writes are refused. Replace with the real check when G3 lands. */
export const noSecondFactorYet = async (): Promise<boolean> => false;

function upstream(actor: Actor) {
  const base = process.env.EVENELO_API_BASE;
  if (!base || !actor.sessionCookie) return null;
  return { base: base.replace(/\/+$/, ""), headers: { Cookie: `${SESSION_COOKIE}=${actor.sessionCookie}` } };
}

type Cell = string | number | boolean | null;
const cell = (v: unknown): Cell => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(rec) : []);

function table(tool: string, hashText: string, columns: readonly string[], rows: Record<string, Cell>[]) {
  return {
    source: { tool, query_hash: queryHash(hashText) },
    mode: "live" as const,
    synthetic: false,
    columns: [...columns],
    rows,
    row_count: rows.length,
  };
}

const pick = (r: Record<string, unknown>, columns: readonly string[]) => {
  const out: Record<string, Cell> = {};
  for (const c of columns) out[c] = cell(r[c]);
  return out;
};

const FLAG_ROLES: Array<[string, string]> = [
  ["is_super_admin", "super_admin"],
  ["is_site_medical_head", "site_medical_head"],
  ["is_hr", "hr"],
  ["is_sgc_member", "sgc_member"],
];

/** Shapes each upstream body into allowlisted typed tables; null if it is not that body. */
export function toAdminPayload(op: "users" | "roles" | "resignations" | "audit", body: unknown, writeEnabled: boolean, hashText: string): AdminPayload | null {
  const b = rec(body);
  if (b.ok !== true) return null;
  if (op === "users") {
    if (!Array.isArray(b.rows)) return null;
    const rows = arr(b.rows).map((r) => {
      const out = pick(r, USER_COLUMNS);
      out.profile_id = cell(r.id);
      out.roles = FLAG_ROLES.filter(([flag]) => r[flag] === true).map(([, name]) => name).join(", ") || null;
      return out;
    });
    const counts = Object.entries(rec(b.counts)).map(([status, n]) => ({ status, users: typeof n === "number" ? n : null }));
    return { table: table("admin_users", hashText, USER_COLUMNS, rows), counts: table("admin_user_counts", hashText + "#counts", USER_COUNT_COLUMNS, counts), write_enabled: writeEnabled };
  }
  if (op === "roles") {
    if (!Array.isArray(b.roles)) return null;
    return { table: table("admin_roles", hashText, ROLE_COLUMNS, arr(b.roles).map((r) => pick(r, ROLE_COLUMNS))), write_enabled: writeEnabled };
  }
  if (!Array.isArray(b.rows)) return null;
  if (op === "resignations") {
    const rows = arr(b.rows).map((r) => {
      const out = pick(r, RESIGNATION_COLUMNS);
      out.request_id = cell(r.id);
      return out;
    });
    return { table: table("admin_resignations", hashText, RESIGNATION_COLUMNS, rows), write_enabled: writeEnabled };
  }
  // audit: before_json / after_json are shown as the old audit page shows them (objects become JSON text).
  const auditRows = arr(b.rows).map((r) => {
    const out = pick(r, AUDIT_COLUMNS);
    for (const k of ["before_json", "after_json"] as const) {
      const v = r[k];
      if (v !== null && typeof v === "object") out[k] = JSON.stringify(v);
    }
    return out;
  });
  return { table: table("admin_audit", hashText, AUDIT_COLUMNS, auditRows), write_enabled: writeEnabled };
}

async function audit(actor: Actor, tool: string, params: Record<string, unknown>, rows: number, startedAt: number, outcome: "ok" | "error") {
  const agentUrl = process.env.AGENT_URL;
  if (!agentUrl) return { ok: false as const, status: 503 };
  let headers: Record<string, string>;
  try {
    headers = await agentHeaders(actor.staffId, actor.role, {
      STUDIO_SERVICE_TOKEN: process.env.STUDIO_SERVICE_TOKEN,
      STUDIO_ACTOR_SECRET: process.env.STUDIO_ACTOR_SECRET,
    });
  } catch {
    return { ok: false as const, status: 503 };
  }
  try {
    const res = await fetchAgent(
      `${agentUrl.replace(/\/+$/, "")}/audit`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        // Ids, statuses and filters only: no names, emails or free text.
        body: JSON.stringify({ tool, params, row_count: rows, duration_ms: Math.max(0, Date.now() - startedAt), outcome }),
        cache: "no-store",
        redirect: "error",
      },
      AUDIT_TIMEOUT_MS,
    );
    return res.ok ? { ok: true as const } : { ok: false as const, status: res.status };
  } catch {
    return { ok: false as const, status: 502 };
  }
}

export async function runAdmin(op: AdminOp, rawParams: unknown, actor: Actor, deps: AdminDeps = {}): Promise<AdminResult> {
  if (!actor.staffId || !actor.role) return fail(401, "unauthorized");
  if (!ADMIN_ROLES.has(actor.role)) return fail(403, "forbidden");
  const secondFactorOk = deps.secondFactorOk ?? noSecondFactorYet;
  return isAdminWriteOp(op) ? runWrite(op, rawParams, actor, secondFactorOk) : runRead(op, rawParams, actor, secondFactorOk);
}

function readUrl(op: "users" | "roles" | "resignations" | "audit", p: Record<string, unknown>, base: string): { url: string; tool: string; hashText: string } {
  const qs = new URLSearchParams();
  if (op === "users") {
    if (typeof p.status === "string") qs.set("status", p.status);
    return { url: `${base}/api/admin/profiles?${qs}`, tool: "admin_users", hashText: "GET /api/admin/profiles" };
  }
  if (op === "roles") return { url: `${base}/api/admin/profiles/${encodeURIComponent(String(p.profile_id))}/roles`, tool: "admin_roles", hashText: "GET /api/admin/profiles/:id/roles" };
  if (op === "resignations") return { url: `${base}/api/admin/resignations`, tool: "admin_resignations", hashText: "GET /api/admin/resignations" };
  for (const k of ["action", "entity_type", "actor"] as const) if (typeof p[k] === "string") qs.set(k, p[k] as string);
  qs.set("limit", String(p.limit ?? 100));
  qs.set("offset", String(p.offset ?? 0));
  qs.set("format", "json");
  return { url: `${base}/api/audit?${qs}`, tool: "admin_audit", hashText: "GET /api/audit" };
}

async function runRead(op: "users" | "roles" | "resignations" | "audit", rawParams: unknown, actor: Actor, secondFactorOk: (a: Actor) => Promise<boolean>): Promise<AdminResult> {
  const parsed = ADMIN_PARAMS[op].safeParse(rawParams ?? {});
  if (!parsed.success) return fail(422, "bad_params");
  if (!liveReadsEnabled()) return fail(503, "live_reads_off");
  const up = upstream(actor);
  if (!up) return fail(503, "upstream_not_configured");

  const startedAt = Date.now();
  const params = parsed.data as Record<string, unknown>;
  const { url, tool, hashText } = readUrl(op, params, up.base);

  let payload: AdminPayload | null = null;
  let failure = { status: 502, error: "upstream_failed" };
  try {
    const res = await fetch(url, { method: "GET", headers: up.headers, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    if (res.status === 401) failure = { status: 401, error: "unauthorized" };
    else if (res.status === 403) failure = { status: 403, error: "forbidden" };
    else if (res.ok) {
      payload = toAdminPayload(op, await res.json().catch(() => null), await secondFactorOk(actor).catch(() => false), hashText);
      if (!payload) failure = { status: 502, error: "bad_payload" };
    }
  } catch {
    failure = { status: 502, error: "upstream_unreachable" };
  }

  const a = await audit(actor, tool, params, payload?.table.row_count ?? 0, startedAt, payload ? "ok" : "error");
  if (!a.ok) return a.status === 429 ? fail(429, "rate_limited", { "Retry-After": "60" }) : fail(503, "audit_unavailable");
  if (!payload) return fail(failure.status, failure.error);
  return { status: 200, body: payload };
}

// Upstream error strings that are safe to map to a fixed code. Anything else becomes upstream_failed.
const ERROR_CODE: Record<string, string> = {
  "not found": "not_found",
  "already processed": "already_processed",
  "Super admin only": "forbidden",
  "Not permitted": "forbidden",
  "Cannot demote the last super_admin": "last_super_admin",
  "invalid status": "bad_params",
};

type WriteOp = "set_status" | "grant_role" | "process_resignation";

function writeRequest(op: WriteOp, p: Record<string, string>, base: string): { url: string; method: "PATCH" | "POST"; body: unknown; tool: string; auditParams: Record<string, unknown> } {
  if (op === "set_status") {
    return { url: `${base}/api/admin/profiles/${encodeURIComponent(p.profile_id)}`, method: "PATCH", body: { status: p.status }, tool: "admin_set_status", auditParams: { profile_id: p.profile_id, status: p.status } };
  }
  if (op === "grant_role") {
    // granted:true only. Revoking is a DELETE of the grant row, which is a hard delete, so it is not offered.
    return {
      url: `${base}/api/admin/profiles/${encodeURIComponent(p.profile_id)}/roles`,
      method: "POST",
      body: { hospital_code: p.hospital_code, role: p.role, granted: true },
      tool: "admin_grant_role",
      auditParams: { profile_id: p.profile_id, hospital_code: p.hospital_code, role: p.role },
    };
  }
  return { url: `${base}/api/admin/resignations/${encodeURIComponent(p.request_id)}/process`, method: "POST", body: {}, tool: "admin_process_resignation", auditParams: { request_id: p.request_id } };
}

async function runWrite(op: WriteOp, rawParams: unknown, actor: Actor, secondFactorOk: (a: Actor) => Promise<boolean>): Promise<AdminResult> {
  const parsed = ADMIN_PARAMS[op].safeParse(rawParams ?? {});
  if (!parsed.success) return fail(422, "bad_params");
  if (!(await secondFactorOk(actor).catch(() => false))) return fail(403, "second_factor_required");
  const up = upstream(actor);
  if (!up) return fail(503, "upstream_not_configured");

  const startedAt = Date.now();
  const req = writeRequest(op, parsed.data as Record<string, string>, up.base);
  let status = 502;
  let error: string | null = "upstream_failed";
  let ok = false;
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: { ...up.headers, "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const body = rec(await res.json().catch(() => null));
    if (res.ok && body.ok === true) {
      ok = true;
      status = 200;
      error = null;
    } else {
      status = [400, 401, 403, 404, 409].includes(res.status) ? res.status : 502;
      error = typeof body.error === "string" && body.error in ERROR_CODE ? ERROR_CODE[body.error] : "upstream_failed";
    }
  } catch {
    error = "upstream_unreachable";
  }

  // The write has already happened upstream (even-elo is the system of record); a missing audit row is reported, not hidden.
  const a = await audit(actor, req.tool, req.auditParams, ok ? 1 : 0, startedAt, ok ? "ok" : "error");
  if (!ok) return fail(status, error!);
  return { status: 200, body: { ok: true, audit_recorded: a.ok } };
}
