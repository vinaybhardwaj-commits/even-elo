import { z } from "zod";

// Contract for the VC onboarding / credentialing (even-elo /onboarding) screens and chat tools.
// Reads go through /api/onboarding/<tool>; writes through /api/onboarding/write/<action>. Both run in this app,
// server side, and call the EXISTING even-elo API routes with the staff session forwarded (fable ruling D).
// Strict objects: unknown keys are refused, so nothing but typed fields reaches an upstream URL or body.

export const ONBOARDING_READ_NAMES = [
  "onboarding_overview",
  "onboarding_pipeline",
  "onboarding_prescreen",
  "onboarding_pending_credentials",
  "onboarding_hospitals",
] as const;
export type OnboardingReadName = (typeof ONBOARDING_READ_NAMES)[number];
export const isOnboardingRead = (name: string): name is OnboardingReadName => (ONBOARDING_READ_NAMES as readonly string[]).includes(name);

/** Audit rows for writes use this tool name (studio_audit allowlist in apps/agent/src/studio_screen.py). */
export const ONBOARDING_WRITE_AUDIT_TOOL = "onboarding_write";

export const ONBOARDING_WRITE_NAMES = ["prescreen_create", "prescreen_decision", "observation_add"] as const;
export type OnboardingWriteName = (typeof ONBOARDING_WRITE_NAMES)[number];
export const isOnboardingWrite = (name: string): name is OnboardingWriteName => (ONBOARDING_WRITE_NAMES as readonly string[]).includes(name);

/**
 * G3 second factor for writers. Not built yet (no verifier exists in the Studio zone), so confirm cards are
 * disabled and the write route refuses. Flip this and the verifier in run.ts together when G3 lands.
 */
export const SECOND_FACTOR_AVAILABLE = false;

export const STAGES = ["prescreen", "observation", "decision", "onboarded", "rejected", "terminated"] as const;
export const SCORE_DIMENSIONS = ["teamwork", "emr_documentation", "ot_etiquette", "protocol_adherence", "outcome", "demeanor"] as const;
export const COMMITMENT_KEYS = ["ot_timings", "formulary", "vendor_mou", "rental_equipment", "weekend_protocol"] as const;

const uuid = z.string().uuid();
const limit = z.number().int().min(1).max(500);
const text = (max: number) => z.string().trim().min(1).max(max);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hospitalCode = z.string().trim().regex(/^[A-Za-z0-9_-]{1,20}$/);

export const ONBOARDING_READ_PARAMS = {
  onboarding_overview: z.object({}).strict(),
  onboarding_pipeline: z.object({ stage: z.enum(STAGES).optional(), limit: limit.optional() }).strict(),
  onboarding_prescreen: z.object({ prescreen_id: uuid, section: z.enum(["summary", "observations"]).optional() }).strict(),
  onboarding_pending_credentials: z.object({ limit: limit.optional() }).strict(),
  onboarding_hospitals: z.object({}).strict(),
} as const satisfies Record<OnboardingReadName, z.ZodTypeAny>;

export type OnboardingReadParams<T extends OnboardingReadName> = z.input<(typeof ONBOARDING_READ_PARAMS)[T]>;

// Writes. Only the fields the existing page forms send. Nothing is deleted: a pre-screen leaves the pipeline by
// the existing decision route (terminate / reject keep the row).
const score = z.number().int().min(1).max(5);

export const ONBOARDING_WRITE_PARAMS = {
  prescreen_create: z
    .object({
      prospective_email: z.string().trim().toLowerCase().email().max(200),
      prospective_full_name: text(120),
      prospective_specialty: z.string().trim().max(80).nullable().optional(),
      hospital_codes: z.array(hospitalCode).min(1).max(10),
      years_post_postgraduate: z.number().int().min(0).max(80).nullable().optional(),
      prior_corporate_hospitals: z.array(text(80)).max(20).optional(),
      commitments_acknowledged: z.object(Object.fromEntries(COMMITMENT_KEYS.map((k) => [k, z.boolean()])) as Record<(typeof COMMITMENT_KEYS)[number], z.ZodBoolean>).strict().optional(),
      red_flags: z.string().trim().max(1000).nullable().optional(),
      decision: z.enum(["invite", "reject"]),
      decision_rationale: z.string().trim().max(1000).nullable().optional(),
      cooldown_override: z.boolean().optional(),
    })
    .strict(),
  prescreen_decision: z
    .object({ prescreen_id: uuid, decision: z.enum(["confirm_privileges", "extend_observation", "terminate"]), rationale: text(1000) })
    .strict(),
  observation_add: z
    .object({
      prescreen_id: uuid,
      case_date: day,
      procedure: text(200),
      observer_role: text(80),
      hospital_id: uuid,
      scores: z.object(Object.fromEntries(SCORE_DIMENSIONS.map((k) => [k, score])) as Record<(typeof SCORE_DIMENSIONS)[number], z.ZodNumber>).strict(),
      narrative_notes: z.string().trim().max(1000).nullable().optional(),
      flag_severity: z.enum(["none", "concern", "immediate_termination_recommended"]).optional(),
    })
    .strict(),
} as const satisfies Record<OnboardingWriteName, z.ZodTypeAny>;

export type OnboardingWriteParams<T extends OnboardingWriteName> = z.input<(typeof ONBOARDING_WRITE_PARAMS)[T]>;

/** What a confirm card shows before anything is sent. */
export const WRITE_LABELS: Record<OnboardingWriteName, { title: string; effect: string }> = {
  prescreen_create: { title: "Start a VC pre-screen", effect: "Creates a pre-screen row, invited to observation or rejected (POST /api/vc-onboarding/prescreens)." },
  prescreen_decision: {
    title: "Record a decision",
    effect: "Confirm privileges, extend observation or terminate (POST /api/vc-onboarding/prescreens/{id}/decision). Confirming creates the physician record. Nothing is deleted.",
  },
  observation_add: { title: "Add an observation case", effect: "Adds one scored observation case, up to 5 (POST /api/vc-onboarding/prescreens/{id}/observations)." },
};
