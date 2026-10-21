/* eslint-disable @typescript-eslint/no-explicit-any -- params are zod-validated before use; the builders read them by key */
import { createHash } from "node:crypto";
import { agentHeaders } from "@/lib/zone/actor-token";
import type { SourceTablePayload } from "@/lib/screens/tool-schema";
import {
  SURGICAL_READ_PARAMS,
  SURGICAL_WRITE_AUDIT_TOOL,
  SURGICAL_WRITE_PARAMS,
  type SurgicalReadName,
  type SurgicalWriteName,
} from "./schema";
import { auditPayload, casesPayload, leaderboardPayload, overviewPayload, positionsPayload, streamsPayload, vcDetailPayload, vcsPayload, weightsPayload } from "./transform";


// Surgical Governance reads and writes (M3-surgical). They run HERE (Vercel, server side) and call the EXISTING
// even-elo API routes the /surgical-governance pages use, with the user's staff session cookie forwarded, so
// even-elo keeps its own auth, audit_log and recompute behaviour. Nothing here touches the database.
//
// Env (names only): EVEN_ELO_API_BASE (default https://governance.evenos.app), plus the agent pair
// (AGENT_URL, STUDIO_SERVICE_TOKEN, STUDIO_ACTOR_SECRET) for the studio_audit row.
// Reads are GET only. Writes are POST/PATCH to fixed paths, never DELETE. Error bodies carry fixed codes only,
// never upstream text.

/** The source pages are super_admin only (even-elo middleware: /surgical-governance). The zone admits no one else today. */
export const SURGICAL_ROLES: ReadonlySet<string> = new Set(["super_admin"]);
const UPSTREAM_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 55_000;
const AUDIT_TIMEOUT_MS = 8_000;
const SESSION_COOKIE = "epi_session";
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export interface SurgicalActor {
  staffId: string;
  role: string;
  /** The user's epi_session JWT, forwarded to even-elo as its cookie. Never logged, never returned. */
  session: string | null;
  /** position_label claim of the verified session; even-elo's PATCH routes want it as actor_position. */
  position: string | null;
}

export type SurgicalResult =
  | { status: 200; body: SourceTablePayload }
  | { status: number; body: { ok: false; error: string }; headers?: Record<string, string> };

export type SurgicalWriteResult =
  | { status: 200; body: { ok: true; action: SurgicalWriteName } }
  | { status: number; body: { ok: false; error: string }; headers?: Record<string, string> };

const fail = (status: number, error: string, headers?: Record<string, string>) => ({ status, body: { ok: false as const, error }, ...(headers ? { headers } : {}) });

const QUERIES: Record<SurgicalReadName, string> = {
  surgical_overview: "GET /api/vcs?status=all; GET /api/weights; GET /api/leaderboard?status=all; GET /api/cases?status=all&limit=500",
  surgical_leaderboard: "GET /api/leaderboard",
  surgical_vcs: "GET /api/vcs",
  surgical_vc_detail: "GET /api/vcs/{id}/detail",
  surgical_cases: "GET /api/cases",
  surgical_streams: "GET /api/streams",
  surgical_weights: "GET /api/weights",
  surgical_positions: "GET /api/positions",
  surgical_audit_log: "GET /api/audit",
};
export const queryHash = (tool: SurgicalReadName): string => createHash("sha256").update(QUERIES[tool]).digest("hex").slice(0, 12);

export function liveReadsEnabled(): boolean {
  const v = process.env.STUDIO_LIVE_READS;
  return v === undefined || !["", "0", "false", "off", "no"].includes(v.trim().toLowerCase());
}

const base = () => {
  const b = (process.env.EVEN_ELO_API_BASE || "https://governance.evenos.app").replace(/\/+$/, "");
  return /^https?:\/\//.test(b) ? b : null;
};

/** Cookie header for even-elo, or null if the session is missing or not JWT-shaped (no header injection). */
const cookieHeader = (session: string | null) => (session && JWT_SHAPE.test(session) ? `${SESSION_COOKIE}=${session}` : null);

type Outcome = { ok: true; body: unknown } | { ok: false; status: 401 | 403 | 404 | 422 | 502 | 503; error: string };

function mapStatus(status: number): Outcome & { ok: false } {
  if (status === 401 || status === 403) return { ok: false, status: 403, error: "upstream_denied" };
  if (status === 404) return { ok: false, status: 404, error: "not_found" };
  if (status === 400 || status === 422) return { ok: false, status: 422, error: "rejected" };
  return { ok: false, status: 502, error: "upstream_failed" };
}

async function call(method: "GET" | "POST" | "PATCH", path: string, cookie: string, body?: unknown, timeoutMs = UPSTREAM_TIMEOUT_MS): Promise<Outcome> {
  const root = base();
  if (!root) return { ok: false, status: 503, error: "upstream_not_configured" };
  let res: Response;
  try {
    res = await fetch(`${root}${path}`, {
      method,
      headers: { Cookie: cookie, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, status: 502, error: "upstream_unreachable" };
  }
  if (!res.ok) return mapStatus(res.status);
  try {
    const json: unknown = await res.json();
    if (json && typeof json === "object" && (json as { ok?: unknown }).ok === false) return { ok: false, status: 502, error: "upstream_failed" };
    return { ok: true, body: json };
  } catch {
    return { ok: false, status: 502, error: "bad_payload" };
  }
}

const enc = encodeURIComponent;
const qs = (o: Record<string, string | number | boolean | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

interface Built {
  payload: SourceTablePayload | null;
  failure?: { status: number; error: string };
}
const built = (payload: SourceTablePayload | null): Built => (payload ? { payload } : { payload: null, failure: { status: 502, error: "bad_payload" } });
const failed = (o: Extract<Outcome, { ok: false }>): Built => ({ payload: null, failure: { status: o.status, error: o.error } });

async function buildRead(tool: SurgicalReadName, p: Record<string, any>, cookie: string): Promise<Built> {
  const meta = { tool, queryHash: queryHash(tool) };
  const limit = (d: number) => (typeof p.limit === "number" ? p.limit : d);
  switch (tool) {
    case "surgical_overview": {
      const [vcs, weights, board, cases] = await Promise.all([
        call("GET", "/api/vcs?status=all", cookie),
        call("GET", "/api/weights", cookie),
        call("GET", "/api/leaderboard?status=all&include_no_snapshot=true", cookie),
        call("GET", "/api/cases?status=all&limit=500", cookie),
      ]);
      for (const o of [vcs, weights, board, cases]) if (!o.ok) return failed(o);
      return built(overviewPayload(meta, (vcs as any).body, (weights as any).body, (board as any).body, (cases as any).body));
    }
    case "surgical_leaderboard": {
      const o = await call("GET", `/api/leaderboard${qs({ status: p.status ?? "active" })}`, cookie);
      return o.ok ? built(leaderboardPayload(meta, o.body, limit(200))) : failed(o);
    }
    case "surgical_vcs": {
      const o = await call("GET", `/api/vcs${qs({ status: p.status ?? "active" })}`, cookie);
      return o.ok ? built(vcsPayload(meta, o.body, limit(200))) : failed(o);
    }
    case "surgical_vc_detail": {
      const o = await call("GET", `/api/vcs/${enc(p.vc_id)}/detail`, cookie);
      return o.ok ? built(vcDetailPayload(meta, o.body, p.section ?? "summary", limit(100))) : failed(o);
    }
    case "surgical_cases": {
      const o = await call("GET", `/api/cases${qs({ vc_id: p.vc_id, status: p.status ?? "completed", from: p.from, to: p.to, limit: limit(100) })}`, cookie);
      return o.ok ? built(casesPayload(meta, o.body, limit(100))) : failed(o);
    }
    case "surgical_streams": {
      const o = await call("GET", `/api/streams${qs({ component: p.component, team: p.team, active: p.active_only === true ? undefined : false })}`, cookie);
      return o.ok ? built(streamsPayload(meta, o.body)) : failed(o);
    }
    case "surgical_weights": {
      const o = await call("GET", "/api/weights", cookie);
      return o.ok ? built(weightsPayload(meta, o.body, limit(50))) : failed(o);
    }
    case "surgical_positions": {
      const o = await call("GET", "/api/positions", cookie);
      return o.ok ? built(positionsPayload(meta, o.body)) : failed(o);
    }
    case "surgical_audit_log": {
      const o = await call("GET", `/api/audit${qs({ action: p.action, entity_type: p.entity_type, actor: p.actor, limit: limit(100), offset: p.offset })}`, cookie);
      return o.ok ? built(auditPayload(meta, o.body, limit(100))) : failed(o);
    }
  }
}

/** Appends the studio_audit row through the agent. false = the row was not written (the caller returns no data). */
async function audit(
  actor: SurgicalActor,
  tool: string,
  params: Record<string, unknown>,
  rowCount: number,
  startedAt: number,
  outcome: "ok" | "error",
): Promise<{ ok: true } | { ok: false; status: number }> {
  const agentUrl = process.env.AGENT_URL;
  if (!agentUrl) return { ok: false, status: 503 };
  let headers: Record<string, string>;
  try {
    headers = await agentHeaders(actor.staffId, actor.role, { STUDIO_SERVICE_TOKEN: process.env.STUDIO_SERVICE_TOKEN, STUDIO_ACTOR_SECRET: process.env.STUDIO_ACTOR_SECRET });
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
 * Run one surgical read for an authenticated staff member. Order: role gate, params, upstream read, audit row,
 * then data. If the audit row cannot be written the data is withheld (fail closed, as the SQL tools do).
 */
export async function runSurgicalRead(tool: SurgicalReadName, rawParams: unknown, actor: SurgicalActor): Promise<SurgicalResult> {
  if (!actor.staffId || !actor.role) return fail(401, "unauthorized");
  if (!SURGICAL_ROLES.has(actor.role)) return fail(403, "forbidden");
  const parsed = SURGICAL_READ_PARAMS[tool].safeParse(rawParams ?? {});
  if (!parsed.success) return fail(422, "bad_params");
  const cookie = cookieHeader(actor.session);
  if (!cookie) return fail(401, "unauthorized");
  if (!liveReadsEnabled()) return fail(503, "live_reads_off");

  const startedAt = Date.now();
  const params = parsed.data as Record<string, unknown>;
  const b = await buildRead(tool, params, cookie);
  const rows = b.payload?.row_count ?? 0;
  const a = await audit(actor, tool, params, rows, startedAt, b.payload ? "ok" : "error");
  if (!a.ok) return a.status === 429 ? fail(429, "rate_limited", { "Retry-After": "60" }) : fail(503, "audit_unavailable");
  if (!b.payload) return fail(b.failure!.status, b.failure!.error);
  return { status: 200, body: b.payload };
}

// ---- writes ----------------------------------------------------------------------------------------

/**
 * G3 second factor (fable ruling G3: writers need one). None exists yet. The default verifier refuses, so every
 * write answers 403 needs_second_factor and nothing is sent to even-elo until a real verifier is wired in here.
 */
export type SecondFactor = (actor: SurgicalActor, action: SurgicalWriteName) => Promise<boolean>;
const noSecondFactor: SecondFactor = async () => false;

interface Request {
  method: "POST" | "PATCH";
  path: string;
  body?: Record<string, unknown>;
}

const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** The fixed upstream request each write maps to. Paths are literals plus uuid-validated, encoded ids. */
export function writeRequests(action: SurgicalWriteName, p: Record<string, any>, position: string): Request[] {
  switch (action) {
    case "vc_create":
      return [{ method: "POST", path: "/api/vcs", body: defined({ full_name: p.full_name, specialty: p.specialty, registration_no: p.registration_no, notes: p.notes }) }];
    case "vc_update":
      return [{ method: "PATCH", path: `/api/vcs/${enc(p.vc_id)}`, body: defined({ full_name: p.full_name, specialty: p.specialty, registration_no: p.registration_no, notes: p.notes, status: p.status, actor_position: position }) }];
    case "stream_update":
      return [
        { method: "PATCH", path: `/api/streams/${enc(p.stream_id)}`, body: defined({ floor_value: p.floor_value, target_value: p.target_value, active: p.active, actor_position: position }) },
        ...(p.recompute_all === true ? [{ method: "POST" as const, path: "/api/admin/recompute?all=true" }] : []),
      ];
    case "weights_apply":
      return [{ method: "POST", path: "/api/weights", body: defined({ caseload_pct: p.caseload_pct, outcomes_pct: p.outcomes_pct, adherence_pct: p.adherence_pct, rationale: p.rationale }) }];
    case "position_update":
      return [{ method: "PATCH", path: "/api/positions", body: { position_name: p.position_name, description: p.description } }];
    case "case_void":
      return [{ method: "PATCH", path: `/api/cases/${enc(p.case_id)}`, body: { case_status: "voided", actor_position: position } }];
    case "recompute_all":
      return [{ method: "POST", path: "/api/admin/recompute?all=true" }];
  }
}

/**
 * Run one confirmed write. Order: role gate, params, session, second factor, intent audit row (fail closed),
 * then the existing even-elo route(s) with the staff session forwarded. No autosave: the caller is a confirm card.
 */
export async function runSurgicalWrite(
  action: SurgicalWriteName,
  rawParams: unknown,
  actor: SurgicalActor,
  deps: { secondFactor?: SecondFactor } = {},
): Promise<SurgicalWriteResult> {
  if (!actor.staffId || !actor.role) return fail(401, "unauthorized");
  if (!SURGICAL_ROLES.has(actor.role)) return fail(403, "forbidden");
  const parsed = SURGICAL_WRITE_PARAMS[action].safeParse(rawParams ?? {});
  if (!parsed.success) return fail(422, "bad_params");
  const cookie = cookieHeader(actor.session);
  if (!cookie) return fail(401, "unauthorized");
  if (!(await (deps.secondFactor ?? noSecondFactor)(actor, action))) return fail(403, "needs_second_factor");
  const position = actor.position?.trim();
  if (!position) return fail(403, "no_position");
  if (!liveReadsEnabled()) return fail(503, "live_reads_off");

  const startedAt = Date.now();
  const params = { action, ...(parsed.data as Record<string, unknown>) };
  // Intent row first: a write nobody can audit is not made.
  const a = await audit(actor, SURGICAL_WRITE_AUDIT_TOOL, params, 0, startedAt, "ok");
  if (!a.ok) return a.status === 429 ? fail(429, "rate_limited", { "Retry-After": "60" }) : fail(503, "audit_unavailable");

  for (const req of writeRequests(action, parsed.data as Record<string, unknown>, position)) {
    const o = await call(req.method, req.path, cookie, req.body ?? {}, WRITE_TIMEOUT_MS);
    if (!o.ok) return fail(o.status, o.error);
  }
  return { status: 200, body: { ok: true, action } };
}

