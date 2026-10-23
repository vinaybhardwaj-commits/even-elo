import { z } from "zod";

// PROVISIONAL view payload shapes for the CDMSS module (Phase 1). Builder A's CONTRACT.md was not available when this
// was written; every field here is the spec's presentation rules (PHASE1-SPEC.md) made concrete. When CONTRACT.md lands,
// change THIS file and the fixtures only; the exhibits read these types.

export const VIEW_IDS = ["this_week", "scorecard", "doctors", "contributors", "red_flags", "worklists"] as const;
export type ViewId = (typeof VIEW_IDS)[number];

export const SITES = ["EHRC", "EHBR", "EHVJ", "EHCV"] as const; // UNVERIFIED site list: take from the contract
export const FAMILIES = ["opd", "stewardship"] as const;
export type Family = (typeof FAMILIES)[number];

const nullableNum = z.number().nullable();

export const Provenance = z.object({
  window: z.object({ from: z.string(), to: z.string(), label: z.string() }),
  data_cutoff: z.string().nullable(),
  sources: z.array(z.string()),
  engine_family: z.string(),
  db13_as_of: z.string().nullable(),
});
export type Provenance = z.infer<typeof Provenance>;

/** Rule 3: every number carries numerator, denominator, n, window and definition id. */
export const Metric = z.object({
  id: z.string(), // catalogue M-id, e.g. M-OPD-01
  label: z.string(),
  unit: z.enum(["proportion", "score", "rate_per_100", "rate_per_1000", "ratio", "count"]),
  value: nullableNum,
  numerator: nullableNum,
  denominator: nullableNum,
  n: z.number().int().nonnegative(),
  ci: z.object({ lo: z.number(), hi: z.number() }).nullable(),
  coverage: nullableNum.optional(), // full NQI: assessed / canonical (RULING Missing PDQI-9)
  status: z.enum(["ok", "grey", "unavailable"]),
  reason: z.string().nullable().optional(), // why grey / unavailable
  note: z.string().nullable().optional(), // e.g. "stored index, not policy-recomputed" (G-15)
});
export type Metric = z.infer<typeof Metric>;

export const Envelope = z.object({
  provenance: Provenance,
  headline: z.object({ claim: z.string(), plain: z.string() }),
  caveats: z.array(z.string()),
  action: z.string(),
});
export type Envelope = z.infer<typeof Envelope>;

const SiteCell = Metric.extend({ site: z.string() });
export const ThisWeek = Envelope.extend({
  tiles: z.array(
    z.object({
      family: z.string(),
      title: z.string(),
      state: z.enum(["live", "coming"]),
      headline: z.string().nullable(),
      metric: Metric.nullable(),
      change: z.enum(["rising", "falling", "no clear change"]).nullable(),
      early_late: z.string().nullable(),
    }),
  ),
});
export type ThisWeek = z.infer<typeof ThisWeek>;

export const Scorecard = Envelope.extend({
  family: z.enum(FAMILIES),
  metrics: z.array(z.object({ id: z.string(), label: z.string(), higher_is: z.enum(["better", "worse"]) })),
  cells: z.array(SiteCell.extend({ metric_id: z.string() })),
  trend: z.array(
    z.object({ metric_id: z.string(), site: z.string(), points: z.array(z.object({ week: z.string(), value: nullableNum, n: z.number().int() })) }),
  ),
  band_mix: z.array(z.object({ site: z.string(), n: z.number().int(), shares: z.record(z.string(), z.number()) })),
  change: z.array(z.object({ metric_id: z.string(), site: z.string(), verdict: z.enum(["rising", "falling", "no clear change"]), early_late: z.string() })),
});
export type Scorecard = z.infer<typeof Scorecard>;

export const DoctorRow = z.object({
  doctor_uid: z.string(),
  name: z.string(),
  site: z.string(),
  specialty: z.string().nullable(),
  metric: Metric,
  expected: nullableNum, // reference rate at this volume
  funnel: z.object({ lo95: z.number(), hi95: z.number(), lo998: z.number(), hi998: z.number() }).nullable(),
  flag: z.enum(["above_998", "above_95", "within", "below_95", "below_998", "not_ranked"]),
  cases_url: z.string().nullable(),
});
export type DoctorRow = z.infer<typeof DoctorRow>;
export const Doctors = Envelope.extend({
  family: z.enum(FAMILIES),
  metric_id: z.string(),
  reference: nullableNum,
  overdispersion_caveat: z.string().nullable(),
  rows: z.array(DoctorRow),
});
export type Doctors = z.infer<typeof Doctors>;

export const Contributors = Envelope.extend({
  family: z.enum(FAMILIES),
  metric_id: z.string(),
  site: z.string(),
  site_metric: Metric,
  gap_to_reference: nullableNum,
  site_without_top: nullableNum,
  rows: z.array(
    z.object({
      doctor_uid: z.string(),
      name: z.string(),
      metric: Metric,
      share_of_gap: nullableNum,
      cases_url: z.string().nullable(),
    }),
  ),
});
export type Contributors = z.infer<typeof Contributors>;

export const Dossier = z.object({
  doctor_uid: z.string(),
  name: z.string(),
  site: z.string(),
  why: z.string(),
  metrics: z.array(Metric),
  findings: z.array(
    z.object({
      finding_id: z.string(),
      subject: z.string(),
      quote: z.string().nullable(),
      case_url: z.string().nullable(),
    }),
  ),
});
export const RedFlags = Envelope.extend({ family: z.enum(FAMILIES), dossiers: z.array(Dossier) });
export type RedFlags = z.infer<typeof RedFlags>;

export const WorklistRow = z.object({
  row_id: z.string(),
  doctor: z.string(),
  uhid: z.string().nullable(),
  site: z.string(),
  note_date: z.string(),
  finding: z.string(),
  quote: z.string().nullable(),
  case_url: z.string().nullable(),
});
export const Worklists = Envelope.extend({
  family: z.enum(FAMILIES),
  metric_id: z.string(),
  total: z.number().int(),
  truncated: z.boolean(), // lists are capped at 500 rows
  rows: z.array(WorklistRow),
});
export type Worklists = z.infer<typeof Worklists>;

export const VIEW_SCHEMAS = {
  this_week: ThisWeek,
  scorecard: Scorecard,
  doctors: Doctors,
  contributors: Contributors,
  red_flags: RedFlags,
  worklists: Worklists,
} as const;
export type ViewPayload<V extends ViewId> = z.infer<(typeof VIEW_SCHEMAS)[V]>;

export type ViewParams = { family?: Family; site?: string; metric_id?: string; weeks?: number };
