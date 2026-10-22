import { createHash } from "node:crypto";
import { agentHeaders } from "@/lib/zone/actor-token";
import { SESSION_COOKIE } from "@/lib/zone/authorize";
import { RMO_INBOX_PARAMS, RMO_ITEM_COLUMNS, RMO_WRITE_PARAMS, type RmoInboxPayload, type RmoOp } from "@/lib/screens/rmo-schema";
import { canUseTool } from "@/lib/zone/access";
import { liveReadsEnabled } from "./run";

// RMO inbox (M2). Same shape as run.ts: role gate, params, upstream call, audit row, then data. The upstream is
// even-elo's existing /api/rmo-inbox routes (the page's own data source), called from this server with the
// caller's epi_session forwarded, so even-elo applies its own auth and hospital filter. The agent never sees
// these rows and never writes. Env (names only): EVENELO_API_BASE, plus the agent trio the other reads use.
//
// Writes (author stamp, release to portal) need the G3 second factor. None exists yet, so secondFactorOk is
// false and a write returns 403 second_factor_required before any upstream call.

const UPSTREAM_TIMEOUT_MS = 10_000;
const AUDIT_TIMEOUT_MS = 8_000;

export type Actor = { staffId: string; role: string; sessionCookie?: string | null };
export type RmoResult = { status: number; body: unknown; headers?: Record<string, string> };
export type RmoDeps = { secondFactorOk?: (actor: Actor) => Promise<boolean> };

const fail = (status: number, error: string, headers?: Record<string, string>): RmoResult => ({
  status,
  body: { ok: false, error },
  ...(headers ? { headers } : {}),
});

const QUERY_TEXT = "GET /api/rmo-inbox";
const queryHash = (qs = ""): string => createHash("sha256").update(`${QUERY_TEXT}${qs ? `?${qs}` : ""}`).digest("hex").slice(0, 12);

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

function table(columns: readonly string[], rows: Record<string, unknown>[], qs = "") {
  const out = rows.map((r) => Object.fromEntries(columns.map((c) => [c, cell(r[c])])) as Record<string, Cell>);
  return {
    source: { tool: "rmo_inbox", query_hash: queryHash(qs) },
    mode: "live" as const,
    synthetic: false,
    columns: [...columns],
    rows: out,
    row_count: out.length,
  };
}

const EXC_COLUMNS = ["finding_id", "finding_label", "severity", "status", "physician_name", "hospital_code", "open_age_days", "recurrence_count", "exception_score", "authored_by_name"] as const;

/** Shapes even-elo's GET /api/rmo-inbox body into typed tables; null if it is not that body. */
export function toInboxPayload(body: unknown, writeEnabled: boolean, qs = ""): RmoInboxPayload | null {
  const b = rec(body);
  if (b.ok !== true || !Array.isArray(b.items) || !Array.isArray(b.exceptions)) return null;
  const head = rec(b.headline);
  const counts = rec(b.pipe_counts);
  const metrics = [
    ...Object.entries(counts).map(([k, v]) => ({ metric: `pipe_${k}`, value: v })),
    { metric: "sla_risk", value: head.sla_risk },
  ];
  return {
    items: table(RMO_ITEM_COLUMNS, arr(b.items), qs),
    counts: table(["metric", "value"], metrics, qs),
    exceptions: table(EXC_COLUMNS, arr(b.exceptions), qs),
    write_enabled: writeEnabled,
  };
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
    const res = await fetch(`${agentUrl.replace(/\/+$/, "")}/audit`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      // Ids and filters only: no names, no finding text.
      body: JSON.stringify({ tool, params, row_count: rows, duration_ms: Math.max(0, Date.now() - startedAt), outcome }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(AUDIT_TIMEOUT_MS),
    });
    return res.ok ? { ok: true as const } : { ok: false as const, status: res.status };
  } catch {
    return { ok: false as const, status: 502 };
  }
}

const SAFE_ERRORS = new Set(["not_found", "finding_id_required", "author_name_required"]);

export async function runRmo(op: RmoOp, rawParams: unknown, actor: Actor, deps: RmoDeps = {}): Promise<RmoResult> {
  if (!actor.staffId || !actor.role) return fail(401, "unauthorized");
  if (!canUseTool(actor.role, `rmo_${op}`)) return fail(403, "forbidden");
  const secondFactorOk = deps.secondFactorOk ?? noSecondFactorYet;
  if (op === "inbox") return runRead(rawParams, actor, secondFactorOk);
  return runWrite(op, rawParams, actor, secondFactorOk);
}

async function runRead(rawParams: unknown, actor: Actor, secondFactorOk: (a: Actor) => Promise<boolean>): Promise<RmoResult> {
  const parsed = RMO_INBOX_PARAMS.safeParse(rawParams ?? {});
  if (!parsed.success) return fail(422, "bad_params");
  if (!liveReadsEnabled()) return fail(503, "live_reads_off");
  const up = upstream(actor);
  if (!up) return fail(503, "upstream_not_configured");

  const startedAt = Date.now();
  const qs = new URLSearchParams();
  if (parsed.data.pipe) qs.set("pipe", parsed.data.pipe);
  if (parsed.data.q?.trim()) qs.set("q", parsed.data.q.trim());

  let payload: RmoInboxPayload | null = null;
  let failure = { status: 502, error: "upstream_failed" };
  try {
    const res = await fetch(`${up.base}/api/rmo-inbox${qs.size ? `?${qs}` : ""}`, {
      method: "GET",
      headers: up.headers,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (res.status === 401) failure = { status: 401, error: "unauthorized" };
    else if (res.ok) {
      payload = toInboxPayload(await res.json().catch(() => null), await secondFactorOk(actor).catch(() => false), qs.toString());
      if (!payload) failure = { status: 502, error: "bad_payload" };
    }
  } catch {
    failure = { status: 502, error: "upstream_unreachable" };
  }

  const a = await audit(actor, "rmo_inbox", parsed.data, payload?.items.row_count ?? 0, startedAt, payload ? "ok" : "error");
  if (!a.ok) return a.status === 429 ? fail(429, "rate_limited", { "Retry-After": "60" }) : fail(503, "audit_unavailable");
  if (!payload) return fail(failure.status, failure.error);
  return { status: 200, body: payload };
}

async function runWrite(op: "author" | "release", rawParams: unknown, actor: Actor, secondFactorOk: (a: Actor) => Promise<boolean>): Promise<RmoResult> {
  const parsed = RMO_WRITE_PARAMS[op].safeParse(rawParams ?? {});
  if (!parsed.success) return fail(422, "bad_params");
  if (!(await secondFactorOk(actor).catch(() => false))) return fail(403, "second_factor_required");
  const up = upstream(actor);
  if (!up) return fail(503, "upstream_not_configured");

  const startedAt = Date.now();
  let status = 502;
  let error: string | null = "upstream_failed";
  let ok = false;
  try {
    const res = await fetch(`${up.base}/api/rmo-inbox/${op}`, {
      method: "POST",
      headers: { ...up.headers, "Content-Type": "application/json" },
      body: JSON.stringify(parsed.data),
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
      status = res.status === 404 ? 404 : res.status === 401 ? 401 : res.status === 400 ? 400 : 502;
      error = typeof body.error === "string" && SAFE_ERRORS.has(body.error) ? body.error : "upstream_failed";
    }
  } catch {
    error = "upstream_unreachable";
  }

  // The write has already happened upstream (even-elo is the system of record); a missing audit row is reported, not hidden.
  const a = await audit(actor, `rmo_${op}`, { finding_id: parsed.data.finding_id }, ok ? 1 : 0, startedAt, ok ? "ok" : "error");
  if (!ok) return fail(status, error!);
  return { status: 200, body: { ok: true, audit_recorded: a.ok } };
}
