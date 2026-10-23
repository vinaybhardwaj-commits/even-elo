import type { Stat, ViewId, ViewPayload } from "./contract";
import { funnelLimits, wilson, Z95, Z998 } from "./stats";

// Synthetic payloads shaped exactly as CONTRACT.md. Used by tests and by the opt-in fixture mode
// (NEXT_PUBLIC_CDMSS_FIXTURES=1) for local viewing; never served by the agent. Names are invented.

const win = { from: "2026-10-17", to: "2026-10-23", days: 7 };
export const stat = (id: string, label: string, over: Partial<Stat> = {}): Stat => ({
  metric_id: id, label, value: null, unit: "percent", numerator: null, denominator: null, n: 0, ci95: null, window: win,
  coverage: null, status: "ok", grey_reason: null, change: null, plain: null, note: null, band: null, ...over,
});
const prop = (id: string, label: string, k: number, n: number, over: Partial<Stat> = {}): Stat => {
  const ci = wilson(k, n);
  return stat(id, label, { value: n ? k / n : null, numerator: k, denominator: n, n, ci95: ci ? [ci.lo, ci.hi] : null, ...over });
};
const wrap = <T,>(tool: string, view: T, rows: Array<Record<string, unknown>> = [], columns: string[] = []) => ({
  source: { tool, query_hash: "0123456789ab" }, mode: "fixture", synthetic: true, columns, rows, row_count: rows.length, view,
});
const envelope = (sentence: string, plain: string, stats: Stat[] = []) => ({
  provenance: { window: { ...win, tz: "Asia/Kolkata" }, data_cutoff: "2026-10-23T02:41:07+00:00", sources: ["cdmss_ro.opd_note_audit", "cdmss_ro.opd_finding"], engine_family: "opd-note-audit/0.81.3+ (versions seen: 0.81.21)", db13_as_of: "2026-10-22T17:00:00+00:00" },
  headline: { sentence, plain },
  stats,
  caveats: ["The score is an encounter proxy, not a clinician scorecard.", "OPD site = the doctor's home site, not where the note was written."],
  precision_line: "About 1 in 5 findings are wrong or contested (engine precision).",
  action_line: "Site medical heads: start with the doctors above the 99.8% limit.",
});

const nqi = stat("M-OPD-01", "Mean OPD NQI (PDQI-assessed notes only)", { unit: "score", value: 78.4, numerator: 4234, denominator: 54, n: 54, ci95: [74.1, 82.7], coverage: { assessed: 54, total: 87, pct: 62.1 }, band: "B", plain: "about 8 in 10 on the 100-point scale",
  change: { direction: "no clear change", p_value: 0.41, relative_change: 0.02, early: { from: "2026-10-10", to: "2026-10-16", value: 76.9, n: 50 }, late: { from: "2026-10-17", to: "2026-10-23", value: 78.4, n: 54 } } });
const ams01 = stat("M-AMS-01", "WHO Access share", { status: "unavailable", grey_reason: "not_available", note: "No AWaRe list in the repo." });

const docs = [
  { doctor_uid: "d1", doctor_name: "Dr Asha Rao", site: "EHRC", n: 80, k: 33 },
  { doctor_uid: "d2", doctor_name: "Dr Bimal Nair", site: "EHRC", n: 90, k: 20 },
  { doctor_uid: "d3", doctor_name: "Dr Chitra Iyer", site: "EHBR", n: 60, k: 17 },
  { doctor_uid: "d4", doctor_name: "Dr Dev Menon", site: "EHBR", n: 6, k: 2 },
];
const C = 0.31;
const position = (n: number, v: number) => {
  if (n < 10) return "greyed" as const;
  const a = funnelLimits(C, n, Z95), b = funnelLimits(C, n, Z998);
  return v > b.hi ? ("above_998" as const) : v > a.hi ? ("above_95" as const) : v < b.lo ? ("below_998" as const) : v < a.lo ? ("below_95" as const) : ("within" as const);
};
let rank = 0;
const doctors = docs.map((d) => {
  const v = d.k / d.n, ci = wilson(d.k, d.n)!, small = d.n < 10;
  return {
    doctor_uid: d.doctor_uid, doctor_name: d.doctor_name, site: d.site, speciality: "General medicine", n: d.n,
    value: v, ci95: small ? null : ([ci.lo, ci.hi] as [number, number]), expected_rate: small ? null : C, oe: small ? null : v / C,
    position: position(d.n, v), rank: small ? null : ++rank,
    stat: small ? prop("M-OPD-05", "Notes with a low-value finding", d.k, d.n, { status: "count_only", value: null, ci95: null, grey_reason: "min_n" }) : prop("M-OPD-05", "Notes with a low-value finding", d.k, d.n),
  };
});

const lvcols = ["note_day", "doctor_uid", "doctor_name", "site", "uid", "finding_no", "subject", "lvc_category", "rule_ref", "quote", "case_url"];

export const FIXTURES: { [V in ViewId]: ViewPayload<V> } = {
  this_week: wrap("cdmss_v1_this_week", {
    envelope: envelope("Mean OPD NQI is 78 over 62% of notes this week.", "About 8 in 10.", [nqi]),
    families: [
      { family: "opd", label: "OPD note audit", status: "live", tiles: [{ stat: nqi, headline: "NQI 78, 62% of notes", plain: "about 8 in 10" }] },
      { family: "ams", label: "Antimicrobial stewardship", status: "live", tiles: [{ stat: ams01, headline: "WHO Access share is unavailable", plain: null }] },
      { family: "ipd", label: "IPD discharge & episode audits", status: "coming" },
      { family: "ot", label: "OT notes", status: "coming" },
      { family: "preop", label: "Pre-op risk", status: "coming" },
      { family: "readmission", label: "Readmissions", status: "coming" },
    ],
  }),
  scorecard: wrap("cdmss_v2_scorecard", {
    envelope: envelope("EHRC has a lower NQI than EHBR.", "About 4 points lower.", [nqi]),
    site_basis: "doctor_home_site",
    sites: ["ALL", "EHRC", "EHBR"],
    metrics: [{ metric_id: "M-OPD-01", label: "Mean NQI", unit: "score" }, { metric_id: "M-OPD-05", label: "Low-value findings per 100 notes", unit: "per_100" }],
    matrix: ["ALL", "EHRC", "EHBR"].map((site, i) => ({ site, n_notes: 400 - i * 100, cells: {
      "M-OPD-01": { ...nqi, value: 78 - i * 2 },
      "M-OPD-05": stat("M-OPD-05", "Low-value findings per 100 notes", { unit: "per_100", value: 12 + i, numerator: 40, denominator: 300, n: 300 }),
    } })),
    trend: ["EHRC", "EHBR"].flatMap((site, i) => ["M-OPD-01", "M-OPD-05"].map((metric_id) => ({
      site, metric_id, points: [0, 1, 2, 3].map((j) => ({ week_from: `2026-10-${String(2 + j * 7).padStart(2, "0")}`, week_to: `2026-10-${String(8 + j * 7).padStart(2, "0")}`, value: (metric_id === "M-OPD-01" ? 76 : 12) + i + j * 0.5, n: 90, status: "ok" })),
    }))),
  }),
  doctor_variation: wrap("cdmss_v3_doctor_variation", {
    envelope: envelope("One doctor is above the 99.8% limit on low-value findings.", "About 4 in 10 notes against about 3 in 10 overall.", doctors.map((d) => d.stat)),
    metric: "lv_rate" as const,
    funnel: { centre: C, centre_basis: "pooled rate over included doctors", z95: 1.96, z998: 3.09, adjustment: "plain binomial limits (no overdispersion adjustment, no age adjustment)", min_n_include: 50,
      limits: [10, 50, 100, 150].map((n) => { const a = funnelLimits(C, n, Z95), b = funnelLimits(C, n, Z998); return { n, lo95: a.lo, hi95: a.hi, lo998: b.lo, hi998: b.hi }; }) },
    doctors,
    excluded: { count: 14, reason: "fewer than 10 audited notes" },
  }, doctors.map((d) => ({ doctor_uid: d.doctor_uid, doctor_name: d.doctor_name, site: d.site, speciality: d.speciality, n: d.n, value: d.value, ci_lo: d.ci95?.[0] ?? null, ci_hi: d.ci95?.[1] ?? null, position: d.position }))),
  contributors: wrap("cdmss_v4_contributors", {
    envelope: envelope("Dr Rao accounts for most of the EHRC gap.", "About 8 in 10 of it."),
    site: "EHRC", metric: "lv_rate",
    site_rate: prop("M-OPD-05", "EHRC notes with a low-value finding", 53, 170),
    other_sites_rate: prop("M-OPD-05", "Other sites", 17, 66),
    gap: { absolute: 0.054, relative: 0.2 },
    contributors: [
      { doctor_uid: "d1", doctor_name: "Dr Asha Rao", n: 80, events: 33, rate: 0.41, ci95: [0.31, 0.52], share_of_gap: 0.8, site_rate_without: 0.22, status: "ok" as const },
      { doctor_uid: "d2", doctor_name: "Dr Bimal Nair", n: 90, events: 20, rate: 0.22, ci95: [0.15, 0.32], share_of_gap: 0.2, site_rate_without: 0.39, status: "ok" as const },
      { doctor_uid: "d9", doctor_name: "Dr Esha Pillai", n: 4, events: 1, rate: null, ci95: null, share_of_gap: null, site_rate_without: null, status: "count_only" as const },
    ],
    top_contributor_removed: { doctor_uid: "d1", site_rate_without: 0.22 },
  }),
  redflags: wrap("cdmss_v5_redflags", {
    envelope: envelope("One doctor has an open signal with evidence.", "One doctor."),
    dossiers: [{
      doctor_uid: "d1", doctor_name: "Dr Asha Rao", site: "EHRC", n_notes: 80,
      signals: [{ signal_id: "s1", reference: "EHRC-AUD-2026-0001", signal_type: "low_value_antibiotic", importance: "high", status: "routed", response_required: true, overdue: true, sla_due_at: "2026-10-20T00:00:00+05:30" }],
      evidence: [{ uid: "n1", note_day: "2026-10-20", finding_no: 1, subject: "Antibiotic for acute URTI", quote: "Rx Amoxiclav 625 x5d for sore throat", rationale: "No bacterial indication documented.", case: { url: "https://cases.example/care/n1" } }],
    }],
  }),
  worklists: wrap("cdmss_v8_worklists", {
    envelope: envelope("Two low-value findings to review.", "Two notes."),
    list: "low_value_findings" as const,
    columns_meta: lvcols.map((key) => ({ key, label: key.replace(/_/g, " "), kind: key === "case_url" ? "url" : "text" })),
    total: 2,
  }, [
    { note_day: "2026-10-20", doctor_uid: "d1", doctor_name: "Dr Asha Rao", site: "EHRC", uid: "n1", finding_no: 1, subject: "Antibiotic for acute URTI", lvc_category: "antibiotic", rule_ref: "r5", quote: "Rx Amoxiclav 625 x5d", case_url: "https://cases.example/care/n1" },
    { note_day: "2026-10-21", doctor_uid: "d1", doctor_name: "Dr Asha Rao", site: "EHRC", uid: "n2", finding_no: 2, subject: "Unindicated investigation", lvc_category: "unindicated_investigation", rule_ref: null, quote: "=CBC, ESR, CRP", case_url: null },
  ], lvcols),
};
