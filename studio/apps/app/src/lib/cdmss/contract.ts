import { z } from "zod";

// Agent <-> app contract for the CDMSS module, from builder A's .bc/CONTRACT.md (section refs in comments).
// Parsed with zod before anything is rendered: a result without its envelope is never shown. Objects are not strict
// (the agent may add keys); fields the exhibits read are required.

export const VIEW_IDS = ["this_week", "scorecard", "doctor_variation", "contributors", "redflags", "worklists"] as const;
export type ViewId = (typeof VIEW_IDS)[number];

/** View id -> agent tool name (CONTRACT section 0). */
export const VIEW_TOOL: Record<ViewId, string> = {
  this_week: "cdmss_v1_this_week",
  scorecard: "cdmss_v2_scorecard",
  doctor_variation: "cdmss_v3_doctor_variation",
  contributors: "cdmss_v4_contributors",
  redflags: "cdmss_v5_redflags",
  worklists: "cdmss_v8_worklists",
};

export const FAMILIES = ["opd", "ams"] as const;
export type Family = (typeof FAMILIES)[number];
export const WORKLISTS = ["signals_open", "signals_overdue", "low_value_findings", "missing_pdqi"] as const;
export type WorklistId = (typeof WORKLISTS)[number];
export const DV_METRICS = ["lv_rate", "nqi"] as const;
export type DvMetric = (typeof DV_METRICS)[number];

/** Params the app may send (CONTRACT 0.2 and per view). The route validates the same schema, strictly. */
export const ViewParams = z
  .object({
    window_days: z.number().int().min(7).max(182).optional(),
    site: z.string().regex(/^[A-Z]{2,12}$/).optional(),
    doctor_uid: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/).optional(),
    family: z.enum(FAMILIES).optional(),
    metric: z.enum(DV_METRICS).optional(),
    specialty: z.string().max(80).optional(),
    list: z.enum(WORKLISTS).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).max(100_000).optional(),
  })
  .strict();
export type ViewParams = z.infer<typeof ViewParams>;

const num = z.number().nullable();
const Window = z.object({ from: z.string(), to: z.string(), days: z.number().optional() });

const Change = z.object({
  direction: z.enum(["rising", "falling", "no clear change"]),
  p_value: num,
  relative_change: num,
  early: z.object({ from: z.string(), to: z.string(), value: num, n: z.number() }),
  late: z.object({ from: z.string(), to: z.string(), value: num, n: z.number() }),
});
export type Change = z.infer<typeof Change>;

/** CONTRACT 1: every number. */
export const Stat = z.object({
  metric_id: z.string(),
  label: z.string(),
  value: num,
  unit: z.enum(["score", "percent", "per_100", "per_1000", "ratio", "count"]),
  numerator: num,
  denominator: num,
  n: z.number(),
  ci95: z.tuple([z.number(), z.number()]).nullable(),
  ci_method: z.string().optional(),
  window: Window,
  coverage: z.object({ assessed: z.number(), total: z.number(), pct: z.number() }).nullable(),
  status: z.enum(["ok", "greyed", "count_only", "unavailable"]),
  grey_reason: z.string().nullable(),
  change: Change.nullable(),
  plain: z.string().nullable(),
  note: z.string().nullable(),
  band: z.string().nullable().optional(),
  extra: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type Stat = z.infer<typeof Stat>;

/** CONTRACT 0.3. */
export const Envelope = z.object({
  provenance: z.object({
    window: Window.extend({ tz: z.string().optional(), anchor: z.string().optional() }),
    data_cutoff: z.string().nullable(),
    sources: z.array(z.string()),
    engine_family: z.string(),
    db13_as_of: z.string().nullable(),
  }),
  headline: z.object({ sentence: z.string(), plain: z.string().nullable() }),
  stats: z.array(Stat),
  caveats: z.array(z.string()),
  precision_line: z.string(),
  action_line: z.string(),
});
export type Envelope = z.infer<typeof Envelope>;

const Evidence = z.object({
  audit_id: z.union([z.string(), z.number()]).nullable().optional(),
  uid: z.string().nullable().optional(),
  note_day: z.string().nullable().optional(),
  finding_no: z.number().nullable().optional(),
  subject: z.string().nullable().optional(),
  quote: z.string().nullable().optional(),
  rationale: z.string().nullable().optional(),
  case: z.object({ url: z.string().nullable(), url_verified: z.boolean() }).nullable().optional(),
});
export type Evidence = z.infer<typeof Evidence>;

const Wrapper = {
  source: z.object({ tool: z.string(), query_hash: z.string() }),
  mode: z.string(),
  synthetic: z.boolean(),
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  row_count: z.number(),
  total: z.number().optional(),
  incomplete: z.string().optional(),
};

// 3.1
export const ThisWeekView = z.object({
  envelope: Envelope,
  families: z.array(
    z.object({
      family: z.string(),
      label: z.string(),
      status: z.enum(["live", "coming"]),
      tiles: z.array(z.object({ stat: Stat, headline: z.string().nullable().optional(), plain: z.string().nullable().optional() })).optional(),
    }),
  ),
});
const SiteOption = z.object({ code: z.string(), label: z.string(), n: z.number() });
export type SiteOption = z.infer<typeof SiteOption>;
// 3.2
export const ScorecardView = z.object({
  envelope: Envelope,
  site_basis: z.string(),
  sites: z.array(SiteOption), // every site with notes in the window (CONTRACT-CHANGES B1)
  matrix_sites: z.array(z.string()), // the rows present in `matrix`
  metrics: z.array(z.object({ metric_id: z.string(), label: z.string(), unit: z.string() })),
  matrix: z.array(z.object({ site: z.string(), n_notes: z.number(), cells: z.record(z.string(), Stat) })),
  band_mix: z.array(z.object({ site: z.string(), counts: z.record(z.string(), z.number()), bands: z.object({ A: Stat, B: Stat, C: Stat, D: Stat, E: Stat }) })), // opd only; [] for ams
  trend: z.array(
    z.object({
      site: z.string(),
      metric_id: z.string(),
      points: z.array(z.object({ week_from: z.string(), week_to: z.string(), value: num, n: z.number(), status: z.string() })),
    }),
  ),
});
// 3.3
export const DoctorRow = z.object({
  doctor_uid: z.string(),
  doctor_name: z.string(),
  site: z.string().nullable(),
  speciality: z.string().nullable().optional(),
  n: z.number(),
  value: num,
  ci95: z.tuple([z.number(), z.number()]).nullable(),
  expected_rate: num.optional(),
  oe: num.optional(),
  position: z.enum(["above_998", "above_95", "within", "below_95", "below_998", "greyed"]),
  rank: z.number().nullable(),
  stat: Stat,
});
export type DoctorRow = z.infer<typeof DoctorRow>;
export const DoctorVariationView = z.object({
  envelope: Envelope,
  metric: z.enum(DV_METRICS),
  funnel: z
    .object({
      centre: z.number(),
      centre_basis: z.string(),
      z95: z.number(),
      z998: z.number(),
      adjustment: z.string(),
      min_n_include: z.number(),
      limits: z.array(z.object({ n: z.number(), lo95: z.number(), hi95: z.number(), lo998: z.number(), hi998: z.number() })),
    })
    .nullable(),
  doctors: z.array(DoctorRow),
  excluded: z.object({ count: z.number(), reason: z.string() }),
});
// 3.4
export const ContributorsView = z.object({
  envelope: Envelope,
  site: z.string(),
  sites: z.array(SiteOption),
  metric: z.string(),
  site_rate: Stat,
  other_sites_rate: Stat,
  gap: z.object({ absolute: z.number(), relative: z.number().nullable() }).nullable(),
  contributors: z.array(
    z.object({
      doctor_uid: z.string(),
      doctor_name: z.string(),
      n: z.number(),
      events: z.number(),
      rate: num,
      ci95: z.tuple([z.number(), z.number()]).nullable(),
      share_of_gap: num,
      site_rate_without: num,
      status: z.enum(["ok", "count_only"]),
    }),
  ),
  top_contributor_removed: z.object({ doctor_uid: z.string(), site_rate_without: num }).nullable(),
});
// 3.5
export const RedflagsView = z.object({
  envelope: Envelope,
  dossiers: z.array(
    z.object({
      doctor_uid: z.string(),
      doctor_name: z.string(),
      site: z.string().nullable(),
      signals: z.array(
        z.object({
          signal_id: z.union([z.string(), z.number()]),
          doctor_uid: z.string().nullable().optional(),
          doctor_name: z.string().nullable().optional(),
          site: z.string().nullable().optional(),
          reference: z.string().nullable().optional(),
          signal_type: z.string().nullable().optional(),
          importance: z.string().nullable().optional(),
          status: z.string().nullable().optional(),
          response_required: z.boolean().nullable().optional(),
          overdue: z.boolean().nullable().optional(),
          sla_due_at: z.string().nullable().optional(),
        }),
      ),
      evidence: z.array(Evidence),
    }),
  ),
});
// 3.6
export const WorklistsView = z.object({
  envelope: Envelope,
  list: z.enum(WORKLISTS),
  columns_meta: z.array(z.object({ key: z.string(), label: z.string(), kind: z.string() })),
  total: z.number(),
});

export const VIEW_SCHEMAS = {
  this_week: z.object({ ...Wrapper, view: ThisWeekView }),
  scorecard: z.object({ ...Wrapper, view: ScorecardView }),
  doctor_variation: z.object({ ...Wrapper, view: DoctorVariationView }),
  contributors: z.object({ ...Wrapper, view: ContributorsView }),
  redflags: z.object({ ...Wrapper, view: RedflagsView }),
  worklists: z.object({ ...Wrapper, view: WorklistsView }),
} as const;
export type ViewPayload<V extends ViewId> = z.infer<(typeof VIEW_SCHEMAS)[V]>;
