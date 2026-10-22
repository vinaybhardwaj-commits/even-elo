import { z } from "zod";
import { DOCAUDIT_TOOL_NAMES, DOCAUDIT_TOOL_PARAMS } from "./docaudit-schema";

// Shared (server + client) contract for the governance read tools (apps/agent/src/studio_tools.py): the six
// M0-S2 tools and the six M1 tools that read the column-scoped studio_ro views.
// The screen route validates params against SCREEN_TOOL_PARAMS before anything reaches the agent, and
// validates what comes back against SourceTablePayload before anything reaches a screen.

export const GOVERNANCE_TOOL_NAMES = [
  "list_physicians",
  "physician_profile",
  "signal_snapshots",
  "interventions",
  "incident_summary",
  "overview_counts",
  ...DOCAUDIT_TOOL_NAMES,
  "physician_privileges",
  "physician_oppe",
  "physician_metrics",
  "physician_qualifications",
  "capture_gaps",
  "feedback_by_physician",
] as const;
export type GovernanceToolName = (typeof GOVERNANCE_TOOL_NAMES)[number];

export function isGovernanceTool(name: string): name is GovernanceToolName {
  return (GOVERNANCE_TOOL_NAMES as readonly string[]).includes(name);
}

const Cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const SourceTablePayload = z.object({
  source: z.object({ tool: z.string().min(1), query_hash: z.string().regex(/^[0-9a-f]{12}$/) }),
  mode: z.enum(["live", "fixture"]),
  synthetic: z.boolean(),
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), Cell)),
  row_count: z.number().int().nonnegative(),
  // Paged tools only: the match count across all pages (absent past the last page).
  total: z.number().int().nonnegative().optional(),
  // Date-range reads over a capped upstream list: what the rows do not cover, shown on the source line.
  incomplete: z.string().max(300).optional(),
});
export type SourceTablePayload = z.infer<typeof SourceTablePayload>;

const uuid = z.string().uuid();
const limit = z.number().int().min(1).max(200);
const windowDays = z.number().int().min(1).max(365);
/** A date (YYYY-MM-DD, read as an Asia/Kolkata calendar day) or an ISO date-time with an optional offset. */
export const DATE_BOUND_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})?)?$/;
/** Round trip: Date rolls 2026-02-30 over to 2 March instead of failing, so the date and the clock time must come
 *  back unchanged, and the offset must be a real one (at most ±14:00). */
export function isRealDateBound(v: string): boolean {
  if (!DATE_BOUND_RE.test(v)) return false;
  const [date, time = ""] = v.split("T");
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) return false;
  if (!time) return true;
  const [, hh, mm, ss = "00", oh = "00", om = "00"] = /^(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))?$/.exec(time) ?? [];
  return +hh < 24 && +mm < 60 && +ss < 60 && +oh * 60 + +om <= 14 * 60 && +om < 60;
}
const dateBound = z.string().refine(isRealDateBound, "not a real date");

// Strict: unknown keys are refused, so a caller cannot smuggle SQL, a staff id or anything else.
export const SCREEN_TOOL_PARAMS = {
  list_physicians: z
    .object({
      filter: z
        .object({
          status: z.enum(["active", "inactive", "terminated"]).optional(),
          specialty_contains: z.string().max(80).optional(),
          name_contains: z.string().max(80).optional(),
          hospital_code: z.string().max(40).optional(),
        })
        .strict()
        .optional(),
      limit: limit.optional(),
      offset: z.number().int().min(0).max(100_000).optional(),
    })
    .strict(),
  physician_profile: z.object({ physician_id: uuid }).strict(),
  signal_snapshots: z
    .object({ physician_id: uuid.optional(), window_days: windowDays.optional(), limit: limit.optional() })
    .strict(),
  interventions: z.object({ physician_id: uuid.optional(), limit: limit.optional() }).strict(),
  incident_summary: z.object({ window_days: windowDays.optional() }).strict(),
  overview_counts: z.object({}).strict(),
  ...DOCAUDIT_TOOL_PARAMS,
  physician_privileges: z.object({ physician_id: uuid, limit: limit.optional() }).strict(),
  physician_oppe: z.object({ physician_id: uuid, limit: limit.optional() }).strict(),
  physician_metrics: z
    .object({ physician_id: uuid, months: z.number().int().min(1).max(60).optional(), limit: limit.optional() })
    .strict(),
  physician_qualifications: z.object({ physician_id: uuid, limit: limit.optional() }).strict(),
  capture_gaps: z.object({ limit: limit.optional() }).strict(),
  feedback_by_physician: z
    .object({
      physician_id: uuid,
      window_days: z.number().int().min(1).max(1825).optional(),
      source: z.enum(["patient", "peer", "governance", "external_public"]).optional(),
      limit: limit.optional(),
    })
    .strict(),
} as const satisfies Record<GovernanceToolName, z.ZodTypeAny>;

export type ScreenToolParams<T extends GovernanceToolName> = z.input<(typeof SCREEN_TOOL_PARAMS)[T]>;

export function isUuid(value: string): boolean {
  return uuid.safeParse(value).success;
}

// ---- HTTP read tools (M1-http) ---------------------------------------------------------------------
// These three reach data that is NOT in the governance database (the e-IRIS incident API and the CDMSS
// governance API). They run in this app, server side (the agent has no egress to either host), behind the
// same /api/screen/<tool> door, and return the same SourceTablePayload. Handlers: lib/http-tools/.

export const HTTP_TOOL_NAMES = ["eiris_incidents", "eiris_incident_detail", "opd_signals", "audit_findings", "audit_finding_detail"] as const;
export type HttpToolName = (typeof HTTP_TOOL_NAMES)[number];

export function isHttpTool(name: string): name is HttpToolName {
  return (HTTP_TOOL_NAMES as readonly string[]).includes(name);
}

/** e-IRIS incident id, as even-elo validates it (src/app/api/mcp/route.ts): four letters, INC, year, serial. */
export const INCIDENT_ID_RE = /^[A-Z]{4}-INC-\d{4}-\d{1,6}$/;
/** CDMSS doctor uid is opaque; keep it to a safe token alphabet. */
export const DOCTOR_UID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

/** CDMSS audit thread reference (EHRC-AUD-2026-0042), as even-elo validates it (src/lib/cdmss-governance.ts). */
export const AUDIT_REF_RE = /^[A-Z]{2,6}-AUD-\d{4}-\d{3,}$/;
/** Hospital code = the reference prefix. */
export const HOSPITAL_CODE_RE = /^[A-Z]{2,6}$/;
export const AUDIT_STATUSES = ["routed", "responded", "escalated", "ruled", "closed"] as const;
export const AUDIT_VIEWS = ["attention", "overdue", "disagreed", "awaiting_ruling", "awaiting_doctor", "all"] as const;

export const HTTP_TOOL_PARAMS = {
  eiris_incidents: z
    .object({
      view: z.enum(["summary", "list"]).optional(),
      status: z.enum(["open", "closed"]).optional(),
      severity: z.string().max(40).optional(),
      since: dateBound.optional(),
      until: dateBound.optional(),
      limit: limit.optional(),
    })
    .strict(),
  eiris_incident_detail: z
    .object({
      incident_id: z.string().regex(INCIDENT_ID_RE),
    })
    .strict(),
  opd_signals: z
    .object({ doctor_uid: z.string().regex(DOCTOR_UID_RE).optional(), window_days: windowDays.optional(), limit: limit.optional() })
    .strict(),
  audit_findings: z
    .object({
      view: z.enum(AUDIT_VIEWS).optional(),
      status: z.enum(AUDIT_STATUSES).optional(),
      doctor_uid: z.string().regex(DOCTOR_UID_RE).optional(),
      hospital: z.string().regex(HOSPITAL_CODE_RE).optional(),
      window_days: windowDays.optional(),
      since: dateBound.optional(),
      until: dateBound.optional(),
      limit: limit.optional(),
    })
    .strict(),
  audit_finding_detail: z
    .object({
      reference: z.string().regex(AUDIT_REF_RE),
    })
    .strict(),
} as const satisfies Record<HttpToolName, z.ZodTypeAny>;

export type HttpToolParams<T extends HttpToolName> = z.input<(typeof HTTP_TOOL_PARAMS)[T]>;

/** Params of any screen read tool (governance SQL tool or HTTP tool). */
export type AnyScreenToolName = GovernanceToolName | HttpToolName;
export type AnyScreenToolParams<T extends AnyScreenToolName> = T extends GovernanceToolName
  ? ScreenToolParams<T>
  : T extends HttpToolName
    ? HttpToolParams<T>
    : never;
