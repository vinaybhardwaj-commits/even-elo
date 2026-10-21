// Pure shaping of even-elo surgical API bodies into SourceTablePayload tables. No env, no I/O.
// Upstream bodies are untrusted: every field is read defensively and unknown fields are dropped.
//
// Fields NEVER emitted, whatever the upstream sends: patient_name, patient_mrn, notes on cases, and the
// before_json / after_json blobs of audit rows (they can carry those same fields). Cases are identified by
// case_ref. Audit rows show who, what, which entity and when.

import type { SourceTablePayload } from "@/lib/screens/tool-schema";
import { makePayload, type PayloadMeta } from "@/lib/http-tools/transform";

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
const r1 = (n: number | null): number | null => (n === null ? null : Math.round(n * 10) / 10);

/** Which top-level key an upstream list lives under; null = the body is not the expected shape. */
export const listOf = (body: unknown, key: string): Obj[] | null => {
  const b = obj(body);
  return b && Array.isArray(b[key]) ? arr(b[key]) : null;
};

export function vcsPayload(meta: PayloadMeta, body: unknown, limit: number): SourceTablePayload | null {
  const list = listOf(body, "vcs");
  if (!list) return null;
  const rows: Row[] = list.slice(0, limit).map((v) => ({
    vc_id: str(v.id),
    full_name: str(v.full_name),
    specialty: str(v.specialty),
    registration_no: str(v.registration_no),
    status: str(v.status),
    updated: day(v.updated_at),
  }));
  return { ...makePayload(meta, ["vc_id", "full_name", "specialty", "registration_no", "status", "updated"], rows), ...(list.length > limit ? { total: list.length } : {}) };
}

export function leaderboardPayload(meta: PayloadMeta, body: unknown, limit: number): SourceTablePayload | null {
  const list = listOf(body, "rows");
  if (!list) return null;
  const rows: Row[] = list.slice(0, limit).map((v) => ({
    vc_id: str(v.vc_id),
    full_name: str(v.full_name),
    specialty: str(v.specialty),
    status: str(v.status),
    composite: r1(num(v.composite)),
    caseload: r1(num(v.caseload_score)),
    outcomes: r1(num(v.outcomes_score)),
    adherence: r1(num(v.adherence_score)),
    tier: str(v.tier),
    low_confidence: bool(v.low_confidence),
    cases_in_window: num(v.case_count_window),
    observations: num(v.total_observations),
    computed: day(v.computed_at),
  }));
  const cols = ["full_name", "specialty", "composite", "caseload", "outcomes", "adherence", "tier", "low_confidence", "cases_in_window", "observations", "computed", "vc_id"];
  return { ...makePayload(meta, cols, rows), ...(list.length > limit ? { total: list.length } : {}) };
}

export function casesPayload(meta: PayloadMeta, body: unknown, limit: number): SourceTablePayload | null {
  const list = listOf(body, "cases");
  if (!list) return null;
  const rows: Row[] = list.slice(0, limit).map((c) => ({
    case_id: str(c.id),
    case_ref: str(c.case_ref),
    vc_id: str(c.vc_id),
    surgeon: str(c.surgeon_name),
    specialty: str(c.specialty),
    surgery_date: day(c.surgery_date),
    procedure: str(c.procedure_label),
    status: str(c.case_status),
    los_days: num(c.los_days),
  }));
  const cols = ["case_ref", "surgery_date", "surgeon", "specialty", "procedure", "status", "los_days", "case_id", "vc_id"];
  return { ...makePayload(meta, cols, rows), ...(list.length > limit ? { total: list.length } : {}) };
}

export function streamsPayload(meta: PayloadMeta, body: unknown): SourceTablePayload | null {
  const list = listOf(body, "streams");
  if (!list) return null;
  const rows: Row[] = list.map((s) => ({
    stream_id: str(s.id),
    label: str(s.label),
    component: str(s.component),
    team_owner: str(s.team_owner),
    data_type: str(s.data_type),
    default_rule: str(s.default_rule),
    direction: str(s.direction),
    floor_value: num(s.floor_value),
    target_value: num(s.target_value),
    active: bool(s.active),
  }));
  return makePayload(meta, ["label", "component", "team_owner", "data_type", "default_rule", "direction", "floor_value", "target_value", "active", "stream_id"], rows);
}

export function weightsPayload(meta: PayloadMeta, body: unknown, limit: number): SourceTablePayload | null {
  const list = listOf(body, "versions");
  if (!list) return null;
  const rows: Row[] = list.slice(0, limit).map((w) => ({
    version_id: str(w.id),
    caseload_pct: num(w.caseload_pct),
    outcomes_pct: num(w.outcomes_pct),
    adherence_pct: num(w.adherence_pct),
    is_current: bool(w.is_current),
    effective_from: day(w.effective_from),
    set_by_position: str(w.set_by_position),
    rationale: str(w.rationale),
  }));
  return makePayload(meta, ["effective_from", "caseload_pct", "outcomes_pct", "adherence_pct", "is_current", "set_by_position", "rationale", "version_id"], rows);
}

export function positionsPayload(meta: PayloadMeta, body: unknown): SourceTablePayload | null {
  const list = listOf(body, "positions");
  if (!list) return null;
  const rows: Row[] = list.map((p) => ({ position_name: str(p.position_name), team: str(p.team), description: str(p.description), active: bool(p.active) }));
  return makePayload(meta, ["position_name", "team", "description", "active"], rows);
}

export function auditPayload(meta: PayloadMeta, body: unknown, limit: number): SourceTablePayload | null {
  const list = listOf(body, "rows");
  if (!list) return null;
  const rows: Row[] = list.slice(0, limit).map((a) => ({
    at: str(a.at),
    actor_position: str(a.actor_position),
    action: str(a.action),
    entity_type: str(a.entity_type),
    entity_id: str(a.entity_id),
  }));
  return makePayload(meta, ["at", "actor_position", "action", "entity_type", "entity_id"], rows);
}

/** Overview: roster counts, current weights and the latest-snapshot tier spread, as metric/value rows. */
export function overviewPayload(meta: PayloadMeta, vcsBody: unknown, weightsBody: unknown, boardBody: unknown, casesBody: unknown): SourceTablePayload | null {
  const vcs = listOf(vcsBody, "vcs");
  const versions = listOf(weightsBody, "versions");
  const board = obj(boardBody);
  const cases = listOf(casesBody, "cases");
  if (!vcs || !versions || !board || !cases) return null;
  const rows: Row[] = [];
  const add = (metric: string, value: Cell, note: string | null = null) => rows.push({ metric, value, note });
  add("vcs_active", vcs.filter((v) => v.status === "active").length);
  add("vcs_total", vcs.length);
  add("vcs_suspended", vcs.filter((v) => v.status === "suspended").length);
  add("vcs_terminated", vcs.filter((v) => v.status === "terminated").length);
  // The cases route caps at 500; past that the count is a floor, and it says so.
  add("cases_completed", cases.length, cases.length >= 500 ? "at least; the API caps the list at 500" : null);
  const cur = versions.find((w) => w.is_current === true);
  add("weights_current", cur ? `${num(cur.caseload_pct)}/${num(cur.outcomes_pct)}/${num(cur.adherence_pct)}` : null, "caseload/outcomes/adherence %");
  add("weight_versions", versions.length);
  const dist = obj(board.distribution) ?? {};
  for (const tier of Object.keys(dist).sort()) {
    const n = num(dist[tier]);
    if (n !== null) add(`tier_${tier.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 30)}`, n, "VCs at their latest snapshot");
  }
  return makePayload(meta, ["metric", "value", "note"], rows);
}

type Section = "summary" | "components" | "snapshots" | "cases" | "activity";

/** One section of /api/vcs/{id}/detail as a table. */
export function vcDetailPayload(meta: PayloadMeta, body: unknown, section: Section, limit: number): SourceTablePayload | null {
  const b = obj(body);
  const vc = obj(b?.vc);
  const result = obj(b?.result);
  if (!b || !vc || !result) return null;
  if (section === "summary") {
    const w = obj(b.weights);
    const rows: Row[] = [];
    const add = (metric: string, value: Cell) => rows.push({ metric, value });
    add("full_name", str(vc.full_name));
    add("specialty", str(vc.specialty));
    add("registration_no", str(vc.registration_no));
    add("status", str(vc.status));
    add("composite", r1(num(result.composite)));
    add("tier", str(result.tier));
    add("low_confidence", bool(result.low_confidence));
    add("total_observations", num(result.total_observations));
    add("case_count_window", num(result.case_count_window));
    add("required_stream_count", num(b.required_stream_count));
    add("weights_caseload_outcomes_adherence", w ? `${num(w.caseload_pct)}/${num(w.outcomes_pct)}/${num(w.adherence_pct)}` : null);
    return makePayload(meta, ["metric", "value"], rows);
  }
  if (section === "components") {
    const labels = new Map(arr(b.streams).map((s) => [str(s.id), str(s.label)] as const));
    const rows: Row[] = [];
    for (const comp of ["caseload", "outcomes", "adherence"] as const) {
      const c = obj(result[comp]);
      for (const s of arr(c?.streams)) {
        rows.push({ component: comp, component_score: r1(num(c?.score)), stream: labels.get(str(s.stream_id)) ?? str(s.stream_id), sub_score: r1(num(s.sub_score)), n_observations: num(s.n_observations) });
      }
    }
    return makePayload(meta, ["component", "component_score", "stream", "sub_score", "n_observations"], rows);
  }
  if (section === "snapshots") {
    const rows: Row[] = arr(b.snapshot_history).slice(-limit).map((s) => ({
      computed_at: str(s.computed_at),
      composite: r1(num(s.composite)),
      caseload: r1(num(s.caseload_score)),
      outcomes: r1(num(s.outcomes_score)),
      adherence: r1(num(s.adherence_score)),
      tier: str(s.tier),
      trigger: str(s.trigger),
      low_confidence: bool(s.low_confidence),
    }));
    return makePayload(meta, ["computed_at", "composite", "caseload", "outcomes", "adherence", "tier", "trigger", "low_confidence"], rows);
  }
  if (section === "cases") {
    // patient_name is in the upstream rows and is dropped here.
    const rows: Row[] = arr(b.cases).slice(0, limit).map((c) => ({
      case_ref: str(c.case_ref),
      surgery_date: day(c.surgery_date),
      procedure: str(c.procedure_label),
      status: str(c.case_status),
      streams_observed: num(c.observation_count),
      case_id: str(c.id),
    }));
    return makePayload(meta, ["case_ref", "surgery_date", "procedure", "status", "streams_observed", "case_id"], rows);
  }
  const rows: Row[] = arr(b.activity).slice(0, limit).map((a) => ({
    at: str(a.at),
    actor_position: str(a.actor_position),
    action: str(a.action),
    entity_type: str(a.entity_type),
    case_ref: str(a.case_ref_for_obs),
  }));
  return makePayload(meta, ["at", "actor_position", "action", "entity_type", "case_ref"], rows);
}
