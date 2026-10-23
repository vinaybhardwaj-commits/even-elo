import { wilson, funnelLimits, Z95, Z998 } from "./stats";
import type { ViewId, ViewPayload, Metric } from "./contract";

// Fixtures for tests and for the screens until builder A's CONTRACT.md lands. Synthetic names; no real identifiers.

const prov = {
  window: { from: "2026-10-17", to: "2026-10-23", label: "IST calendar weeks ending 23 Oct 2026" },
  data_cutoff: "2026-10-23T08:14:00+05:30",
  sources: ["cdmss_ro.opd_note_audit", "cdmss_ro.opd_finding", "studio_ro.dw_* (denominators)"],
  engine_family: "opd-note-audit/0.81.x",
  db13_as_of: "2026-10-22T22:30:00+05:30",
};
const env = (claim: string, plain: string) => ({
  provenance: prov,
  headline: { claim, plain },
  caveats: [
    "About 1 in 5 findings are wrong or contested; treat a flag as a prompt to look, not a verdict.",
    "NQI is an encounter proxy, not a clinician scorecard.",
    "Stored index, not policy-recomputed.",
  ],
  action: "Site medical heads: open the doctors above the 99.8% line first.",
});
export const metric = (id: string, label: string, k: number, n: number, over: Partial<Metric> = {}): Metric => ({
  id,
  label,
  unit: "proportion",
  value: n ? k / n : null,
  numerator: k,
  denominator: n,
  n,
  ci: wilson(k, n),
  status: n >= 15 ? "ok" : "grey",
  ...over,
});

const SITES = ["EHRC", "EHBR"];
const docs = [
  { doctor_uid: "d1", name: "Dr Asha Rao", site: "EHRC", k: 31, n: 80 },
  { doctor_uid: "d2", name: "Dr Bimal Nair", site: "EHRC", k: 9, n: 90 },
  { doctor_uid: "d3", name: "Dr Chitra Iyer", site: "EHBR", k: 14, n: 60 },
  { doctor_uid: "d4", name: "Dr Dev Menon", site: "EHBR", k: 3, n: 6 },
];
const REF = 0.2;

const doctors: ViewPayload<"doctors"> = {
  ...env("One doctor is clearly above the rest on low-value findings.", "Dr Rao is about 4 in 10 against a site norm of about 2 in 10."),
  family: "opd",
  metric_id: "M-OPD-05",
  reference: REF,
  overdispersion_caveat: "Plain binomial limits; no overdispersion adjustment for this metric.",
  rows: docs.map((d) => {
    const n = d.n;
    const f95 = funnelLimits(REF, n, Z95);
    const f998 = funnelLimits(REF, n, Z998);
    const rate = d.k / n;
    const small = n < 10;
    return {
      doctor_uid: d.doctor_uid,
      name: d.name,
      site: d.site,
      specialty: "General medicine",
      metric: metric("M-OPD-05", "Notes with a low-value finding", d.k, n, small ? { status: "grey", reason: "fewer than 10 notes" } : {}),
      expected: REF,
      funnel: { lo95: f95.lo, hi95: f95.hi, lo998: f998.lo, hi998: f998.hi },
      flag: small ? "not_ranked" : rate > f998.hi ? "above_998" : rate > f95.hi ? "above_95" : rate < f998.lo ? "below_998" : rate < f95.lo ? "below_95" : "within",
      cases_url: `https://cdmss.example/case/${d.doctor_uid}`,
    };
  }),
};

export const FIXTURES: { [V in ViewId]: ViewPayload<V> } = {
  this_week: {
    ...env("OPD note quality held steady this week; stewardship tiles are partly unavailable.", "About 6 in 10 notes are band A or B."),
    tiles: [
      { family: "opd", title: "OPD note audit", state: "live", headline: "Mean NQI 78 (62% of notes assessed)", metric: metric("M-OPD-01", "Mean NQI", 780, 10, { unit: "score", value: 78, coverage: 0.62 }), change: "no clear change", early_late: "first 3 weeks vs last 3 weeks" },
      { family: "stewardship", title: "Antimicrobial stewardship", state: "live", headline: "WHO Access share unavailable: no AWaRe list", metric: metric("M-AMS-01", "WHO Access share", 0, 0, { status: "unavailable", reason: "AWaRe list not supplied" }), change: null, early_late: null },
      { family: "ipd", title: "IPD discharge audit", state: "coming", headline: null, metric: null, change: null, early_late: null },
      { family: "preop", title: "Pre-op", state: "coming", headline: null, metric: null, change: null, early_late: null },
    ],
  },
  scorecard: {
    ...env("EHRC has more low-value findings than EHBR.", "About 3 in 10 notes at EHRC, about 2 in 10 at EHBR."),
    family: "opd",
    metrics: [
      { id: "M-OPD-01", label: "Mean NQI", higher_is: "better" },
      { id: "M-OPD-05", label: "Low-value findings", higher_is: "worse" },
    ],
    cells: SITES.flatMap((site, i) => [
      { ...metric("M-OPD-01", "Mean NQI", 0, 120, { unit: "score", value: 78 - i * 4, ci: null, coverage: 0.62 }), site, metric_id: "M-OPD-01" },
      { ...metric("M-OPD-05", "Low-value findings", 40 - i * 15, 170), site, metric_id: "M-OPD-05" },
    ]),
    trend: SITES.map((site, i) => ({ metric_id: "M-OPD-05", site, points: ["W40", "W41", "W42", "W43"].map((week, j) => ({ week, value: 0.3 - i * 0.08 + j * 0.005, n: 40 })) })),
    band_mix: SITES.map((site) => ({ site, n: 120, shares: { A: 0.2, B: 0.4, C: 0.25, D: 0.1, E: 0.05 } })),
    change: SITES.map((site) => ({ metric_id: "M-OPD-05", site, verdict: "no clear change" as const, early_late: "weeks 40-41 vs 42-43" })),
  },
  doctors,
  contributors: {
    ...env("Two doctors account for most of the EHRC gap.", "About 8 in 10 of the gap."),
    family: "opd",
    metric_id: "M-OPD-05",
    site: "EHRC",
    site_metric: metric("M-OPD-05", "Low-value findings", 40, 170),
    gap_to_reference: 0.035,
    site_without_top: 0.19,
    rows: [
      { doctor_uid: "d1", name: "Dr Asha Rao", metric: metric("M-OPD-05", "Low-value findings", 31, 80), share_of_gap: 0.78, cases_url: "https://cdmss.example/case/d1" },
      { doctor_uid: "d2", name: "Dr Bimal Nair", metric: metric("M-OPD-05", "Low-value findings", 9, 90), share_of_gap: 0.22, cases_url: null },
    ],
  },
  red_flags: {
    ...env("One doctor needs a dossier review.", "One of four doctors."),
    family: "opd",
    dossiers: [
      {
        doctor_uid: "d1",
        name: "Dr Asha Rao",
        site: "EHRC",
        why: "Above the 99.8% funnel limit on low-value findings, n = 80.",
        metrics: [metric("M-OPD-05", "Low-value findings", 31, 80)],
        findings: [{ finding_id: "f1", subject: "Antibiotic for acute URTI", quote: "Rx Amoxiclav 625 x5d for sore throat", case_url: "https://cdmss.example/case/n1" }],
      },
    ],
  },
  worklists: {
    ...env("12 notes to review for Dr Rao.", "About 4 in 10 of the audited notes."),
    family: "opd",
    metric_id: "M-OPD-05",
    total: 2,
    truncated: false,
    rows: [
      { row_id: "r1", doctor: "Dr Asha Rao", uhid: "UH-000001", site: "EHRC", note_date: "2026-10-20", finding: "Antibiotic for acute URTI", quote: "Rx Amoxiclav 625 x5d", case_url: "https://cdmss.example/case/n1" },
      { row_id: "r2", doctor: "Dr Asha Rao", uhid: "UH-000002", site: "EHRC", note_date: "2026-10-21", finding: "Unindicated investigation", quote: "=CBC, ESR, CRP", case_url: null },
    ],
  },
};
