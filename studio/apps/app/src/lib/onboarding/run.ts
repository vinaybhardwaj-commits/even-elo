/* eslint-disable @typescript-eslint/no-explicit-any -- params are zod-validated before use; the builders read them by key */
import { createHash } from "node:crypto";
import { fetchAgent } from "@/lib/agent-fetch";
import { agentHeaders } from "@/lib/zone/actor-token";
import type { SourceTablePayload } from "@/lib/screens/tool-schema";
import {
  ONBOARDING_READ_PARAMS,
  ONBOARDING_WRITE_AUDIT_TOOL,
  ONBOARDING_WRITE_PARAMS,
  type OnboardingReadName,
  type OnboardingWriteName,
} from "./schema";
import { hospitalsPayload, observationsPayload, overviewPayload, pendingCredentialsPayload, pipelinePayload, prescreenSummaryPayload } from "./transform";

// VC onboarding / credentialing reads and writes (M3-onboarding). They run HERE (Vercel, server side) and call the
// EXISTING even-elo API routes the /onboarding pages use, with the user's staff session cookie forwarded, so
// even-elo keeps its own auth, audit_log and stage rules. Nothing here touches the database.
//
// Env (names only): EVEN_ELO_API_BASE (default https://governance.evenos.app), plus the agent pair
// (AGENT_URL, STUDIO_SERVICE_TOKEN, STUDIO_ACTOR_SECRET) for the studio_audit row.
// Reads are GET only. Writes are POST to fixed paths, never DELETE. Error bodies carry fixed codes only,
// never upstream text.

/**
 * Role gates, equal to the source. GET /api/vc-onboarding/prescreens shows rows only to super_admin, Site Medical
 * Head and HR (others get an empty list); pre-screen POST has the same gate; the decision POST is super_admin or
 * Site Medical Head (even-elo then narrows to the prescreen's hospital). The detail GET has no role check in
 * even-elo; here it takes the stricter list gate. Pending credentials, hospitals and observation POST need only a
 * signed-in staff member, as in even-elo. The Studio zone admits only super_admin today, so the others are latent.
 */
const LIST_ROLES: ReadonlySet<string> = new Set(["super_admin", "site_medical_head", "hr"]);
const DECISION_ROLES: ReadonlySet<string> = new Set(["super_admin", "site_medical_head"]);
const anyStaff = (role: string) => role.length > 0;

const READ_GATE: Record<OnboardingReadName, (role: string) => boolean> = {
  onboarding_overview: (r) => LIST_ROLES.has(r),
  onboarding_pipeline: (r) => LIST_ROLES.has(r),
  onboarding_prescreen: (r) => LIST_ROLES.has(r),
  onboarding_pending_credentials: anyStaff,
  onboarding_hospitals: anyStaff,
};
const WRITE_GATE: Record<OnboardingWriteName, (role: string) => boolean> = {
  prescreen_create: (r) => LIST_ROLES.has(r),
  prescreen_decision: (r) => DECISION_ROLES.has(r),
  observation_add: anyStaff,
};
const UPSTREAM_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 55_000;
const AUDIT_TIMEOUT_MS = 8_000;
const SESSION_COOKIE = "epi_session";
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export interface OnboardingActor {
  staffId: string;
  role: string;
  /** The user's epi_session JWT, forwarded to even-elo as its cookie. Never logged, never returned. */
  session: string | null;
}

export type OnboardingResult =
  | { status: 200; body: SourceTablePayload }
  | { status: number; body: { ok: false; error: string }; headers?: Record<string, string> };

export type OnboardingWriteResult =
  | { status: 200; body: { ok: true; action: OnboardingWriteName } }
  | { status: number; body: { ok: false; error: string }; headers?: Record<string, string> };

const fail = (status: number, error: string, headers?: Record<string, string>) => ({ status, body: { ok: false as const, error }, ...(headers ? { headers } : {}) });

const QUERIES: Record<OnboardingReadName, string> = {
  onboarding_overview: "GET /api/vc-onboarding/prescreens; GET /api/admin/qualifications/pending",
  onboarding_pipeline: "GET /api/vc-onboarding/prescreens",
  onboarding_prescreen: "GET /api/vc-onboarding/prescreens/{id}; GET /api/vc-onboarding/prescreens/{id}/observations",
  onboarding_pending_credentials: "GET /api/admin/qualifications/pending",
  onboarding_hospitals: "GET /api/hospitals",
};
export const queryHash = (tool: OnboardingReadName): string => createHash("sha256").update(QUERIES[tool]).digest("hex").slice(0, 12);

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

type Outcome = { ok: true; body: unknown } | { ok: false; status: 401 | 403 | 404 | 409 | 422 | 502 | 503; error: string };

function mapStatus(status: number): Outcome & { ok: false } {
  if (status === 401 || status === 403) return { ok: false, status: 403, error: "upstream_denied" };
  if (status === 404) return { ok: false, status: 404, error: "not_found" };
  if (status === 409) return { ok: false, status: 409, error: "conflict" };
  if (status === 400 || status === 422) return { ok: false, status: 422, error: "rejected" };
  return { ok: false, status: 502, error: "upstream_failed" };
}

async function call(method: "GET" | "POST", path: string, cookie: string, body?: unknown, timeoutMs = UPSTREAM_TIMEOUT_MS): Promise<Outcome> {
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

async function buildRead(tool: OnboardingReadName, p: Record<string, any>, cookie: string): Promise<Built> {
  const meta = { tool, queryHash: queryHash(tool) };
  const limit = (d: number) => (typeof p.limit === "number" ? p.limit : d);
  switch (tool) {
    case "onboarding_overview": {
      const [pipeline, pending] = await Promise.all([call("GET", "/api/vc-onboarding/prescreens", cookie), call("GET", "/api/admin/qualifications/pending", cookie)]);
      for (const o of [pipeline, pending]) if (!o.ok) return failed(o);
      return built(overviewPayload(meta, (pipeline as any).body, (pending as any).body));
    }
    case "onboarding_pipeline": {
      const o = await call("GET", `/api/vc-onboarding/prescreens${qs({ stage: p.stage })}`, cookie);
      return o.ok ? built(pipelinePayload(meta, o.body, limit(200))) : failed(o);
    }
    case "onboarding_prescreen": {
      const id = enc(p.prescreen_id);
      if (p.section === "observations") {
        const o = await call("GET", `/api/vc-onboarding/prescreens/${id}/observations`, cookie);
        return o.ok ? built(observationsPayload(meta, o.body)) : failed(o);
      }
      const o = await call("GET", `/api/vc-onboarding/prescreens/${id}`, cookie);
      return o.ok ? built(prescreenSummaryPayload(meta, o.body)) : failed(o);
    }
    case "onboarding_pending_credentials": {
      const o = await call("GET", "/api/admin/qualifications/pending", cookie);
      return o.ok ? built(pendingCredentialsPayload(meta, o.body, limit(200))) : failed(o);
    }
    case "onboarding_hospitals": {
      const o = await call("GET", "/api/hospitals", cookie);
      return o.ok ? built(hospitalsPayload(meta, o.body)) : failed(o);
    }
  }
}

/** Appends the studio_audit row through the agent. false = the row was not written (the caller returns no data). */
async function audit(
  actor: OnboardingActor,
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
    const res = await fetchAgent(
      `${agentUrl.replace(/\/+$/, "")}/audit`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ tool, params, row_count: rowCount, duration_ms: Math.max(0, Date.now() - startedAt), outcome }),
        cache: "no-store",
        redirect: "error",
      },
      AUDIT_TIMEOUT_MS,
    );
    return res.ok ? { ok: true } : { ok: false, status: res.status };
  } catch {
    return { ok: false, status: 502 };
  }
}

/**
 * Run one onboarding read for an authenticated staff member. Order: role gate, params, upstream read, audit row,
 * then data. If the audit row cannot be written the data is withheld (fail closed, as the SQL tools do).
 */
export async function runOnboardingRead(tool: OnboardingReadName, rawParams: unknown, actor: OnboardingActor): Promise<OnboardingResult> {
  if (!actor.staffId || !actor.role) return fail(401, "unauthorized");
  if (!READ_GATE[tool](actor.role)) return fail(403, "forbidden");
  const parsed = ONBOARDING_READ_PARAMS[tool].safeParse(rawParams ?? {});
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
export type SecondFactor = (actor: OnboardingActor, action: OnboardingWriteName) => Promise<boolean>;
const noSecondFactor: SecondFactor = async () => false;

interface Request {
  method: "POST";
  path: string;
  body: Record<string, unknown>;
}

const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** The fixed upstream request each write maps to. Paths are literals plus uuid-validated, encoded ids. */
export function writeRequests(action: OnboardingWriteName, p: Record<string, any>): Request[] {
  switch (action) {
    case "prescreen_create":
      return [
        {
          method: "POST",
          path: "/api/vc-onboarding/prescreens",
          body: defined({
            prospective_email: p.prospective_email,
            prospective_full_name: p.prospective_full_name,
            prospective_specialty: p.prospective_specialty,
            hospital_codes: p.hospital_codes,
            years_post_postgraduate: p.years_post_postgraduate,
            prior_corporate_hospitals: p.prior_corporate_hospitals,
            commitments_acknowledged: p.commitments_acknowledged,
            red_flags: p.red_flags,
            decision: p.decision,
            decision_rationale: p.decision_rationale,
            cooldown_override: p.cooldown_override,
          }),
        },
      ];
    case "prescreen_decision":
      return [{ method: "POST", path: `/api/vc-onboarding/prescreens/${enc(p.prescreen_id)}/decision`, body: { decision: p.decision, rationale: p.rationale } }];
    case "observation_add":
      return [
        {
          method: "POST",
          path: `/api/vc-onboarding/prescreens/${enc(p.prescreen_id)}/observations`,
          body: defined({ case_date: p.case_date, procedure: p.procedure, observer_role: p.observer_role, hospital_id: p.hospital_id, scores: p.scores, narrative_notes: p.narrative_notes, flag_severity: p.flag_severity }),
        },
      ];
  }
}

/**
 * Run one confirmed write. Order: role gate, params, session, second factor, intent audit row (fail closed),
 * then the existing even-elo route with the staff session forwarded. No autosave: the caller is a confirm card.
 */
export async function runOnboardingWrite(
  action: OnboardingWriteName,
  rawParams: unknown,
  actor: OnboardingActor,
  deps: { secondFactor?: SecondFactor } = {},
): Promise<OnboardingWriteResult> {
  if (!actor.staffId || !actor.role) return fail(401, "unauthorized");
  if (!WRITE_GATE[action](actor.role)) return fail(403, "forbidden");
  const parsed = ONBOARDING_WRITE_PARAMS[action].safeParse(rawParams ?? {});
  if (!parsed.success) return fail(422, "bad_params");
  const cookie = cookieHeader(actor.session);
  if (!cookie) return fail(401, "unauthorized");
  if (!(await (deps.secondFactor ?? noSecondFactor)(actor, action))) return fail(403, "needs_second_factor");
  if (!liveReadsEnabled()) return fail(503, "live_reads_off");

  const startedAt = Date.now();
  const params = { action, ...(parsed.data as Record<string, unknown>) };
  // Intent row first: a write nobody can audit is not made.
  const a = await audit(actor, ONBOARDING_WRITE_AUDIT_TOOL, params, 0, startedAt, "ok");
  if (!a.ok) return a.status === 429 ? fail(429, "rate_limited", { "Retry-After": "60" }) : fail(503, "audit_unavailable");

  for (const req of writeRequests(action, parsed.data as Record<string, unknown>)) {
    const o = await call(req.method, req.path, cookie, req.body, WRITE_TIMEOUT_MS);
    if (!o.ok) return fail(o.status, o.error);
  }
  return { status: 200, body: { ok: true, action } };
}
