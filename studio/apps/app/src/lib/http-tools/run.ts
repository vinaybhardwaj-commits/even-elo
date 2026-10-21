import { createHash } from "node:crypto";
import { agentHeaders } from "@/lib/zone/actor-token";
import { HTTP_TOOL_PARAMS, type HttpToolName, type SourceTablePayload } from "@/lib/screens/tool-schema";
import { incidentRows, toDetailPayload, toIncidentsPayload, toSignalsPayload } from "./transform";

// The three HTTP read tools (M1-http): eiris_incidents, eiris_incident_detail, opd_signals.
//
// They run HERE (Vercel, server side) because the agent has no egress to the incident or CDMSS hosts. Both the
// /api/screen/<tool> route and the CopilotKit server-side actions call runHttpTool, so a screen and the chat
// get the same gate, the same audit row and the same typed table with its source line.
//
// Env (names only): INCIDENT_API_BASE, INCIDENT_API_TOKEN (e-IRIS, same service token even-elo's
// /api/safety proxy uses), GOV_API_BASE (optional, default https://even-cdmss.vercel.app), GOV_API_KEY (CDMSS),
// plus the agent pair the other screen reads already use (AGENT_URL, STUDIO_SERVICE_TOKEN, STUDIO_ACTOR_SECRET).
// Read-only: only GET requests are made. Error bodies carry fixed codes only, never upstream text.

/** Same predicate as even-elo's /api/safety proxy: super_admin or SGC member. The Studio zone admits super_admin only today. */
export const SAFETY_ROLES: ReadonlySet<string> = new Set(["super_admin", "sgc_member"]);
const UPSTREAM_TIMEOUT_MS = 10_000;
const AUDIT_TIMEOUT_MS = 8_000;

export type HttpToolResult =
  | { status: 200; body: SourceTablePayload }
  | { status: number; body: { ok: false; error: string }; headers?: Record<string, string> };

const fail = (status: number, error: string, headers?: Record<string, string>): HttpToolResult => ({
  status,
  body: { ok: false, error },
  ...(headers ? { headers } : {}),
});

/** Hash of the fixed upstream calls a tool makes (never of data), mirroring query_hash on the SQL tools. */
const QUERIES: Record<HttpToolName, string> = {
  eiris_incidents: "GET /api/office/incidents; GET /api/office/stats; GET /api/mm/stats",
  eiris_incident_detail: "GET /api/office/incidents/{id}",
  opd_signals: "GET /api/governance/roster-audits",
};
export const queryHash = (tool: HttpToolName): string => createHash("sha256").update(QUERIES[tool]).digest("hex").slice(0, 12);

type UpstreamOutcome = { ok: true; body: unknown } | { ok: false; status: 404 | 502 | 503; error: string };

async function getJson(url: string, headers: Record<string, string>): Promise<UpstreamOutcome> {
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", headers, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch {
    return { ok: false, status: 502, error: "upstream_unreachable" };
  }
  if (res.status === 404) return { ok: false, status: 404, error: "not_found" };
  if (!res.ok) return { ok: false, status: 502, error: "upstream_failed" };
  try {
    return { ok: true, body: await res.json() };
  } catch {
    return { ok: false, status: 502, error: "bad_payload" };
  }
}

const trimBase = (v: string) => v.replace(/\/+$/, "");

function incidentApi() {
  const base = process.env.INCIDENT_API_BASE;
  const token = process.env.INCIDENT_API_TOKEN;
  if (!base || !token) return null;
  return { base: trimBase(base), headers: { Authorization: `Bearer ${token}` } };
}

function cdmssApi() {
  const key = process.env.GOV_API_KEY;
  if (!key) return null;
  return { base: trimBase(process.env.GOV_API_BASE || "https://even-cdmss.vercel.app"), headers: { "x-api-key": key } };
}

interface Built {
  payload: SourceTablePayload | null;
  failure?: { status: number; error: string };
}

async function buildIncidents(p: { view?: "summary" | "list"; status?: "open" | "closed"; severity?: string; limit?: number }): Promise<Built> {
  const api = incidentApi();
  if (!api) return { payload: null, failure: { status: 503, error: "upstream_not_configured" } };
  const view = p.view ?? "summary";
  const meta = { tool: "eiris_incidents", queryHash: queryHash("eiris_incidents") };
  const list = await getJson(`${api.base}/api/office/incidents`, api.headers);
  if (!list.ok) return { payload: null, failure: { status: list.status, error: list.error } };
  if (!incidentRows(list.body).length && !Array.isArray((list.body as { incidents?: unknown } | null)?.incidents)) {
    return { payload: null, failure: { status: 502, error: "bad_payload" } };
  }
  // Totals are best-effort: a stats or M&M outage degrades the summary, it does not fail it.
  const [stats, mm] =
    view === "summary"
      ? await Promise.all([getJson(`${api.base}/api/office/stats`, api.headers), getJson(`${api.base}/api/mm/stats`, api.headers)])
      : [null, null];
  return {
    payload: toIncidentsPayload(meta, {
      incidents: list.body,
      stats: stats?.ok ? stats.body : null,
      mm: mm?.ok ? mm.body : null,
      view,
      status: p.status,
      severity: p.severity,
      limit: p.limit ?? 50,
    }),
  };
}

async function buildDetail(p: { incident_id: string; include_text?: boolean }): Promise<Built> {
  const api = incidentApi();
  if (!api) return { payload: null, failure: { status: 503, error: "upstream_not_configured" } };
  const meta = { tool: "eiris_incident_detail", queryHash: queryHash("eiris_incident_detail") };
  const r = await getJson(`${api.base}/api/office/incidents/${encodeURIComponent(p.incident_id)}`, api.headers);
  if (!r.ok) return { payload: null, failure: { status: r.status, error: r.error } };
  const payload = toDetailPayload(meta, r.body, p.include_text === true);
  return payload ? { payload } : { payload: null, failure: { status: 502, error: "bad_payload" } };
}

async function buildSignals(p: { doctor_uid?: string; window_days?: number; limit?: number }): Promise<Built> {
  const api = cdmssApi();
  if (!api) return { payload: null, failure: { status: 503, error: "upstream_not_configured" } };
  const qs = new URLSearchParams();
  if (p.doctor_uid) qs.set("doctor_uid", p.doctor_uid);
  qs.set("window", String(p.window_days ?? 30));
  const r = await getJson(`${api.base}/api/governance/roster-audits?${qs.toString()}`, api.headers);
  if (!r.ok) return { payload: null, failure: { status: r.status, error: r.error } };
  if (!Array.isArray((r.body as { doctors?: unknown } | null)?.doctors)) return { payload: null, failure: { status: 502, error: "bad_payload" } };
  return { payload: toSignalsPayload({ tool: "opd_signals", queryHash: queryHash("opd_signals") }, r.body, p.limit ?? 50) };
}

/** Appends the studio_audit row through the agent. false = the row was not written (the caller returns no data). */
async function audit(
  staffId: string,
  role: string,
  tool: HttpToolName,
  params: Record<string, unknown>,
  rowCount: number,
  startedAt: number,
  outcome: "ok" | "error",
): Promise<{ ok: true } | { ok: false; status: number }> {
  const agentUrl = process.env.AGENT_URL;
  if (!agentUrl) return { ok: false, status: 503 };
  let headers: Record<string, string>;
  try {
    headers = await agentHeaders(staffId, role, {
      STUDIO_SERVICE_TOKEN: process.env.STUDIO_SERVICE_TOKEN,
      STUDIO_ACTOR_SECRET: process.env.STUDIO_ACTOR_SECRET,
    });
  } catch {
    return { ok: false, status: 503 };
  }
  try {
    const res = await fetch(`${agentUrl.replace(/\/+$/, "")}/audit`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ tool, params, row_count: rowCount, duration_ms: Math.max(0, Date.now() - startedAt), outcome }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(AUDIT_TIMEOUT_MS),
    });
    return res.ok ? { ok: true } : { ok: false, status: res.status };
  } catch {
    return { ok: false, status: 502 };
  }
}

/**
 * Run one HTTP read tool for an authenticated staff member. Order: role gate, params, upstream read, audit row,
 * then data. If the audit row cannot be written the data is withheld (fail closed, as the SQL tools do).
 */
export async function runHttpTool(tool: HttpToolName, rawParams: unknown, actor: { staffId: string; role: string }): Promise<HttpToolResult> {
  if (!actor.staffId || !actor.role) return fail(401, "unauthorized");
  // Every tool here reads incident or physician-governance data the SGC/super_admin pages gate the same way.
  if (!SAFETY_ROLES.has(actor.role)) return fail(403, "forbidden");
  const parsed = HTTP_TOOL_PARAMS[tool].safeParse(rawParams ?? {});
  if (!parsed.success) return fail(422, "bad_params");
  const params = parsed.data as Record<string, unknown>;

  const startedAt = Date.now();
  const built =
    tool === "eiris_incidents"
      ? await buildIncidents(params)
      : tool === "eiris_incident_detail"
        ? await buildDetail(params as { incident_id: string; include_text?: boolean })
        : await buildSignals(params);

  const rows = built.payload?.row_count ?? 0;
  const a = await audit(actor.staffId, actor.role, tool, params, rows, startedAt, built.payload ? "ok" : "error");
  if (!a.ok) return a.status === 429 ? fail(429, "rate_limited", { "Retry-After": "60" }) : fail(503, "audit_unavailable");
  if (!built.payload) return fail(built.failure!.status, built.failure!.error);
  return { status: 200, body: built.payload };
}

