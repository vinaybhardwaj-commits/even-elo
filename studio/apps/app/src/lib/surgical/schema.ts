import { z } from "zod";

// Contract for the Surgical Governance (even-elo /surgical-governance) screens and chat tools.
// Reads go through /api/surgical/<tool>; writes through /api/surgical/write/<action>. Both run in this app,
// server side, and call the EXISTING even-elo API routes with the staff session forwarded (fable ruling D).
// Strict objects: unknown keys are refused, so nothing but typed fields reaches an upstream URL or body.

export const SURGICAL_READ_NAMES = [
  "surgical_overview",
  "surgical_leaderboard",
  "surgical_vcs",
  "surgical_vc_detail",
  "surgical_cases",
  "surgical_streams",
  "surgical_weights",
  "surgical_positions",
  "surgical_audit_log",
] as const;
export type SurgicalReadName = (typeof SURGICAL_READ_NAMES)[number];

export const isSurgicalRead = (name: string): name is SurgicalReadName => (SURGICAL_READ_NAMES as readonly string[]).includes(name);

/** Audit rows for writes use this tool name (studio_audit allowlist in apps/agent/src/studio_screen.py). */
export const SURGICAL_WRITE_AUDIT_TOOL = "surgical_write";

export const SURGICAL_WRITE_NAMES = [
  "vc_create",
  "vc_update",
  "stream_update",
  "weights_apply",
  "position_update",
  "case_void",
  "recompute_all",
] as const;
export type SurgicalWriteName = (typeof SURGICAL_WRITE_NAMES)[number];
export const isSurgicalWrite = (name: string): name is SurgicalWriteName => (SURGICAL_WRITE_NAMES as readonly string[]).includes(name);

/**
 * G3 second factor for writers. Not built yet (no verifier exists in the Studio zone), so confirm cards are
 * disabled and the write route refuses. Flip this and the verifier in run.ts together when G3 lands.
 */
export const SECOND_FACTOR_AVAILABLE = false;

const uuid = z.string().uuid();
const limit = z.number().int().min(1).max(500);
const text = (max: number) => z.string().trim().min(1).max(max);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const token = z.string().regex(/^[A-Za-z0-9_.:-]{1,60}$/);

export const SURGICAL_READ_PARAMS = {
  surgical_overview: z.object({}).strict(),
  surgical_leaderboard: z.object({ status: z.enum(["active", "all"]).optional(), limit: limit.optional() }).strict(),
  surgical_vcs: z.object({ status: z.enum(["active", "all"]).optional(), limit: limit.optional() }).strict(),
  surgical_vc_detail: z
    .object({
      vc_id: uuid,
      section: z.enum(["summary", "components", "snapshots", "cases", "activity"]).optional(),
      limit: limit.optional(),
    })
    .strict(),
  surgical_cases: z
    .object({ vc_id: uuid.optional(), status: z.enum(["completed", "all"]).optional(), from: date.optional(), to: date.optional(), limit: limit.optional() })
    .strict(),
  surgical_streams: z
    .object({ component: z.enum(["caseload", "outcomes", "adherence"]).optional(), team: z.string().max(40).optional(), active_only: z.boolean().optional() })
    .strict(),
  surgical_weights: z.object({ limit: limit.optional() }).strict(),
  surgical_positions: z.object({}).strict(),
  surgical_audit_log: z
    .object({ action: token.optional(), entity_type: token.optional(), actor: z.string().max(60).optional(), limit: limit.optional(), offset: z.number().int().min(0).max(100_000).optional() })
    .strict(),
} as const satisfies Record<SurgicalReadName, z.ZodTypeAny>;

export type SurgicalReadParams<T extends SurgicalReadName> = z.input<(typeof SURGICAL_READ_PARAMS)[T]>;

// Writes. Only the fields the existing page forms send. No hard delete exists: a VC leaves the roster by
// status "terminated" (the existing PATCH), a case by status "voided".
const weightPct = z.number().int().min(0).max(100);

export const SURGICAL_WRITE_PARAMS = {
  vc_create: z
    .object({ full_name: text(120), specialty: text(80), registration_no: z.string().trim().max(60).nullable().optional(), notes: z.string().trim().max(500).nullable().optional() })
    .strict(),
  vc_update: z
    .object({
      vc_id: uuid,
      full_name: text(120).optional(),
      specialty: text(80).optional(),
      registration_no: z.string().trim().max(60).nullable().optional(),
      notes: z.string().trim().max(500).nullable().optional(),
      status: z.enum(["active", "suspended", "terminated"]).optional(),
    })
    .strict(),
  stream_update: z
    .object({ stream_id: uuid, floor_value: z.number().finite().nullable().optional(), target_value: z.number().finite().nullable().optional(), active: z.boolean().optional(), recompute_all: z.boolean().optional() })
    .strict(),
  weights_apply: z
    .object({ caseload_pct: weightPct, outcomes_pct: weightPct, adherence_pct: weightPct, rationale: z.string().trim().max(500).nullable().optional() })
    .strict()
    .refine((w) => w.caseload_pct + w.outcomes_pct + w.adherence_pct === 100, { message: "weights must sum to 100" }),
  position_update: z.object({ position_name: text(120), description: z.string().trim().max(500).nullable() }).strict(),
  case_void: z.object({ case_id: uuid }).strict(),
  recompute_all: z.object({}).strict(),
} as const satisfies Record<SurgicalWriteName, z.ZodTypeAny>;

export type SurgicalWriteParams<T extends SurgicalWriteName> = z.input<(typeof SURGICAL_WRITE_PARAMS)[T]>;

/** What a confirm card shows before anything is sent. */
export const WRITE_LABELS: Record<SurgicalWriteName, { title: string; effect: string }> = {
  vc_create: { title: "Add visiting consultant", effect: "Creates a roster row (POST /api/vcs)." },
  vc_update: { title: "Edit visiting consultant", effect: "Updates the roster row (PATCH /api/vcs/{id}). Terminating keeps the row; nothing is deleted." },
  stream_update: { title: "Edit stream", effect: "Changes floor, target or active flag (PATCH /api/streams/{id}). Optionally recomputes every active VC." },
  weights_apply: { title: "Apply weight version", effect: "Creates a new current weight version and recomputes every active VC (POST /api/weights)." },
  position_update: { title: "Edit position description", effect: "Updates the description (PATCH /api/positions)." },
  case_void: { title: "Void case", effect: "Sets the case to voided so it stops counting (PATCH /api/cases/{id}). The row is kept." },
  recompute_all: { title: "Recompute all scores", effect: "Recomputes every active VC (POST /api/admin/recompute?all=true)." },
};
