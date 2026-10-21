// Pure shaping of even-elo VC onboarding API bodies into SourceTablePayload tables. No env, no I/O.
// Upstream bodies are untrusted: every field is read defensively and unknown fields are dropped.
//
// Governance sees what the source pages show (V, 21 Oct: no doctor or PHI gating): observation narrative_notes,
// red flags and the decision rationale in full. NEVER emitted, whatever the upstream sends: observer email and the
// qualification file payload (only its has_file flag and filename).

import type { SourceTablePayload } from "@/lib/screens/tool-schema";
import { makePayload, type PayloadMeta } from "@/lib/http-tools/transform";
import { COMMITMENT_KEYS, SCORE_DIMENSIONS, STAGES } from "./schema";

type Cell = string | number | boolean | null;
type Row = Record<string, Cell>;
type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj).filter((o): o is Obj => o !== null) : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const day = (v: unknown): string | null => str(v)?.slice(0, 10) ?? null;
const short = (v: unknown, max = 300): string | null => {
  const s = str(v);
  return s === null ? null : s.length > max ? `${s.slice(0, max)}…` : s;
};
const codes = (v: unknown): string | null => {
  const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return list.length ? list.join(", ") : null;
};

export const listOf = (body: unknown, key: string): Obj[] | null => {
  const b = obj(body);
  return b && Array.isArray(b[key]) ? arr(b[key]) : null;
};

/** Stage counts + total from the pipeline list body, and the pending-credential count. */
export function overviewPayload(meta: PayloadMeta, pipeline: unknown, pending: unknown): SourceTablePayload | null {
  const p = obj(pipeline);
  const credentials = listOf(pending, "rows");
  if (!p || !obj(p.counts) || !credentials) return null;
  const counts = obj(p.counts)!;
  const rows: Row[] = [
    ...STAGES.map((s) => ({ metric: `stage_${s}`, value: num(counts[s]) ?? 0, note: null })),
    { metric: "pipeline_total", value: STAGES.reduce((n, s) => n + (num(counts[s]) ?? 0), 0), note: "all stages, network-wide" },
    { metric: "pending_credentials", value: credentials.length, note: credentials.length >= 200 ? "capped at 200 by the API" : "unverified qualifications, network-wide" },
  ];
  return makePayload(meta, ["metric", "value", "note"], rows);
}

export function pipelinePayload(meta: PayloadMeta, body: unknown, limit: number): SourceTablePayload | null {
  const list = listOf(body, "rows");
  if (!list) return null;
  const rows: Row[] = list.slice(0, limit).map((v) => ({
    prescreen_id: str(v.id),
    full_name: str(v.prospective_full_name),
    email: str(v.prospective_email),
    specialty: str(v.prospective_specialty),
    hospitals: codes(v.hospital_codes) ?? str(v.hospital_code),
    stage: str(v.stage),
    decision: str(v.decision),
    years_post_pg: num(v.years_post_postgraduate),
    red_flags: str(v.red_flags),
    prescreened_by: str(v.prescreened_by_email),
    prescreened: day(v.prescreened_at),
    decided: day(v.decided_at),
    onboarded: str(v.physician_id) !== null,
  }));
  const cols = ["full_name", "email", "specialty", "hospitals", "stage", "decision", "years_post_pg", "red_flags", "prescreened_by", "prescreened", "decided", "onboarded", "prescreen_id"];
  return { ...makePayload(meta, cols, rows), ...(list.length > limit ? { total: list.length } : {}) };
}

/** One pre-screen as metric/value rows (the detail page header and its panels). */
export function prescreenSummaryPayload(meta: PayloadMeta, body: unknown): SourceTablePayload | null {
  const b = obj(body);
  const p = b && obj(b.prescreen);
  if (!p) return null;
  const commitments = obj(p.commitments_acknowledged) ?? {};
  const perHospital = obj(p.cases_per_hospital) ?? {};
  const rows: Row[] = [
    { metric: "prescreen_id", value: str(p.id) },
    { metric: "full_name", value: str(p.prospective_full_name) },
    { metric: "email", value: str(p.prospective_email) },
    { metric: "specialty", value: str(p.prospective_specialty) },
    { metric: "hospitals", value: codes(p.hospital_codes) ?? str(p.hospital_code) },
    { metric: "primary_hospital", value: str(p.hospital_name) },
    { metric: "stage", value: str(p.stage) },
    { metric: "trigger", value: str(p.trigger) },
    { metric: "fppe_from_profile", value: bool(p.fppe_from_profile) },
    { metric: "decision", value: str(p.decision) },
    { metric: "decision_rationale", value: str(p.decision_rationale) },
    { metric: "years_post_postgraduate", value: num(p.years_post_postgraduate) },
    { metric: "prior_corporate_hospitals", value: codes(p.prior_corporate_hospitals) },
    { metric: "red_flags", value: str(p.red_flags) },
    { metric: "cooldown_override", value: bool(p.cooldown_override) },
    ...COMMITMENT_KEYS.map((k) => ({ metric: `commitment_${k}`, value: bool(commitments[k]) })),
    ...Object.entries(perHospital)
      .map(([code, n]) => ({ metric: `cases_${code}`, value: num(n) }))
      .filter((r): r is { metric: string; value: number } => r.value !== null),
    { metric: "prescreened_by", value: str(p.prescreened_by_email) },
    { metric: "prescreened", value: day(p.prescreened_at) },
    { metric: "decided", value: day(p.decided_at) },
    { metric: "physician_id", value: str(p.physician_id) },
  ];
  return makePayload(meta, ["metric", "value"], rows);
}

export function observationsPayload(meta: PayloadMeta, body: unknown): SourceTablePayload | null {
  const list = listOf(body, "rows");
  if (!list) return null;
  const rows: Row[] = list.map((c) => {
    const scores = obj(c.scores) ?? {};
    return {
      case_number: num(c.case_number),
      case_date: day(c.case_date),
      procedure: short(c.procedure, 120),
      observer_role: str(c.observer_role),
      observer: str(c.observer_name),
      ...Object.fromEntries(SCORE_DIMENSIONS.map((d) => [d, num(scores[d])])),
      flag: str(c.flag_severity),
      trigger: str(c.trigger),
      has_notes: str(c.narrative_notes) !== null,
      notes: str(c.narrative_notes),
    };
  });
  return makePayload(meta, ["case_number", "case_date", "procedure", "observer_role", "observer", ...SCORE_DIMENSIONS, "flag", "trigger", "has_notes", "notes"], rows);
}

export function pendingCredentialsPayload(meta: PayloadMeta, body: unknown, limit: number): SourceTablePayload | null {
  const list = listOf(body, "rows");
  if (!list) return null;
  const rows: Row[] = list.slice(0, limit).map((q) => ({
    qualification_id: str(q.id),
    physician_id: str(q.physician_id),
    physician: str(q.physician_name),
    specialty: str(q.primary_specialty),
    degree: str(q.degree),
    year: num(q.year_completed),
    institution: str(q.institution),
    country: str(q.country),
    has_file: bool(q.has_file),
    filename: str(q.filename),
    submitted: day(q.created_at),
  }));
  const cols = ["physician", "specialty", "degree", "year", "institution", "country", "has_file", "filename", "submitted", "physician_id", "qualification_id"];
  return { ...makePayload(meta, cols, rows), ...(list.length > limit ? { total: list.length } : {}) };
}

export function hospitalsPayload(meta: PayloadMeta, body: unknown): SourceTablePayload | null {
  const list = listOf(body, "hospitals");
  if (!list) return null;
  const rows: Row[] = list.map((h) => ({ code: str(h.code), name: str(h.name), hospital_id: str(h.id) }));
  return makePayload(meta, ["code", "name", "hospital_id"], rows);
}
