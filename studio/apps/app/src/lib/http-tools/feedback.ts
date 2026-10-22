import { createHash } from "node:crypto";
import { fetchAgent } from "@/lib/agent-fetch";
import { agentHeaders } from "@/lib/zone/actor-token";
import { SESSION_COOKIE } from "@/lib/zone/authorize";
import { FEEDBACK_ITEM_COLUMNS, FEEDBACK_LIST_PARAMS, FEEDBACK_WRITE_PARAMS, type FeedbackOp, type FeedbackPayload } from "@/lib/screens/feedback-schema";
import { canUseTool, hasAnyRole } from "@/lib/zone/access";
import { liveReadsEnabled } from "./run";

// Patient feedback (M3): the governance `incidents` table, read and retracted through even-elo's existing
// /api/incidents routes (the page's own source) with the caller's epi_session forwarded, so even-elo applies its
// own auth, visibility and hospital filter. Same order as run.ts: role gate, params, upstream, audit row, data.
// Env (names only): EVENELO_API_BASE, plus the agent trio the other reads use.
//
// Retract needs the G3 second factor. None exists yet, so secondFactorOk is false and a write returns
// 403 second_factor_required before any upstream call. Replies are written by the target physician only
// (POST /api/incidents/[id]/replies checks the physician's own email); there is no staff reply action here.

const UPSTREAM_TIMEOUT_MS = 10_000;
const AUDIT_TIMEOUT_MS = 8_000;
/** Retract on the source route is super_admin only; mirrored here so the card never reaches upstream otherwise. */
const RETRACT_ROLES: ReadonlySet<string> = new Set(["super_admin"]);

export type Actor = { staffId: string; role: string; sessionCookie?: string | null };
export type FeedbackResult = { status: number; body: unknown; headers?: Record<string, string> };
export type FeedbackDeps = { secondFactorOk?: (actor: Actor) => Promise<boolean> };

const fail = (status: number, error: string, headers?: Record<string, string>): FeedbackResult => ({
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

const COUNT_COLUMNS = ["status", "severity", "feedback"] as const;

/** Shapes even-elo's GET /api/incidents body into typed tables (allowlisted columns only); null if it is not that body. */
export function toFeedbackPayload(body: unknown, writeEnabled: boolean): FeedbackPayload | null {
  const b = rec(body);
  if (b.ok !== true || !Array.isArray(b.rows) || !Array.isArray(b.counts)) return null;
  const items = arr(b.rows).map((r) => {
    const replies = typeof r.reply_count === "number" ? r.reply_count : 0;
    const out: Record<string, Cell> = {};
    for (const c of FEEDBACK_ITEM_COLUMNS) out[c] = cell(r[c]);
    out.feedback_id = cell(r.id);
    out.physician_id = cell(r.target_physician_id);
    out.physician_name = cell(r.target_physician_name);
    out.reply_count = replies;
    out.reply_state = r.status === "retracted" ? "retracted" : replies > 0 ? "replied" : "no reply";
    return out;
  });
  const counts = arr(b.counts).map((r) => ({ status: cell(r.status), severity: cell(r.severity), feedback: typeof r.n === "number" ? r.n : null }));
  return {
    items: table("patient_feedback", "GET /api/incidents", FEEDBACK_ITEM_COLUMNS, items),
    counts: table("patient_feedback_counts", "GET /api/incidents#counts", COUNT_COLUMNS, counts),
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
    const res = await fetchAgent(
      `${agentUrl.replace(/\/+$/, "")}/audit`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        // Ids and filters only: no names, no narrative, no retraction reason text.
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

export async function runFeedback(op: FeedbackOp, rawParams: unknown, actor: Actor, deps: FeedbackDeps = {}): Promise<FeedbackResult> {
  if (!actor.staffId || !actor.role) return fail(401, "unauthorized");
  if (!canUseTool(actor.role, "patient_feedback")) return fail(403, "forbidden");
  const secondFactorOk = deps.secondFactorOk ?? noSecondFactorYet;
  return op === "list" ? runList(rawParams, actor, secondFactorOk) : runRetract(rawParams, actor, secondFactorOk);
}

async function runList(rawParams: unknown, actor: Actor, secondFactorOk: (a: Actor) => Promise<boolean>): Promise<FeedbackResult> {
  const parsed = FEEDBACK_LIST_PARAMS.safeParse(rawParams ?? {});
  if (!parsed.success) return fail(422, "bad_params");
  if (!liveReadsEnabled()) return fail(503, "live_reads_off");
  const up = upstream(actor);
  if (!up) return fail(503, "upstream_not_configured");

  const startedAt = Date.now();
  const qs = new URLSearchParams();
  if (parsed.data.status) qs.set("status", parsed.data.status);
  if (parsed.data.severity) qs.set("severity", parsed.data.severity);
  if (parsed.data.source) qs.set("source", parsed.data.source);
  qs.set("limit", String(parsed.data.limit ?? 100));

  let payload: FeedbackPayload | null = null;
  let failure = { status: 502, error: "upstream_failed" };
  try {
    const res = await fetch(`${up.base}/api/incidents?${qs}`, {
      method: "GET",
      headers: up.headers,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (res.status === 401) failure = { status: 401, error: "unauthorized" };
    else if (res.ok) {
      payload = toFeedbackPayload(await res.json().catch(() => null), hasAnyRole(actor.role, RETRACT_ROLES) && (await secondFactorOk(actor).catch(() => false)));
      if (!payload) failure = { status: 502, error: "bad_payload" };
    }
  } catch {
    failure = { status: 502, error: "upstream_unreachable" };
  }

  const a = await audit(actor, "patient_feedback", parsed.data, payload?.items.row_count ?? 0, startedAt, payload ? "ok" : "error");
  if (!a.ok) return a.status === 429 ? fail(429, "rate_limited", { "Retry-After": "60" }) : fail(503, "audit_unavailable");
  if (!payload) return fail(failure.status, failure.error);
  return { status: 200, body: payload };
}

const SAFE_ERRORS = new Set(["not found", "already retracted", "retraction_reason required", "Super admin only"]);
const ERROR_CODE: Record<string, string> = {
  "not found": "not_found",
  "already retracted": "already_retracted",
  "retraction_reason required": "reason_required",
  "Super admin only": "forbidden",
};

async function runRetract(rawParams: unknown, actor: Actor, secondFactorOk: (a: Actor) => Promise<boolean>): Promise<FeedbackResult> {
  const parsed = FEEDBACK_WRITE_PARAMS.retract.safeParse(rawParams ?? {});
  if (!parsed.success) return fail(422, "bad_params");
  if (!hasAnyRole(actor.role, RETRACT_ROLES)) return fail(403, "forbidden");
  if (!(await secondFactorOk(actor).catch(() => false))) return fail(403, "second_factor_required");
  const up = upstream(actor);
  if (!up) return fail(503, "upstream_not_configured");

  const startedAt = Date.now();
  let status = 502;
  let error: string | null = "upstream_failed";
  let ok = false;
  try {
    // Retract is a status change, never a delete: the row and its audit trail stay.
    const res = await fetch(`${up.base}/api/incidents/${encodeURIComponent(parsed.data.feedback_id)}`, {
      method: "PATCH",
      headers: { ...up.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "retracted", retraction_reason: parsed.data.retraction_reason }),
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
      status = res.status === 404 ? 404 : res.status === 401 ? 401 : res.status === 403 ? 403 : res.status === 409 ? 409 : res.status === 400 ? 400 : 502;
      error = typeof body.error === "string" && SAFE_ERRORS.has(body.error) ? ERROR_CODE[body.error] : "upstream_failed";
    }
  } catch {
    error = "upstream_unreachable";
  }

  // The write has already happened upstream (even-elo is the system of record); a missing audit row is reported, not hidden.
  const a = await audit(actor, "feedback_retract", { feedback_id: parsed.data.feedback_id }, ok ? 1 : 0, startedAt, ok ? "ok" : "error");
  if (!ok) return fail(status, error!);
  return { status: 200, body: { ok: true, audit_recorded: a.ok } };
}
