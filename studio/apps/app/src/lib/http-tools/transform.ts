// Pure shaping of upstream bodies into the SourceTablePayload tables the screens and the chat render.
// No env, no I/O. Upstream bodies are untrusted: every field is read defensively, unknown fields are dropped.
//
// Governance sees what the source incident page shows (V, 21 Oct: no doctor or PHI gating): narrative,
// immediate action, root cause, CAPA actions, patient name / UHID / age / sex (phi_*) and the reporter as the
// page shows it (name unless anonymous; contact only for confidential reports). Not emitted: attachment links.

import type { SourceTablePayload } from "@/lib/screens/tool-schema";

type Cell = string | number | boolean | null;
type Row = Record<string, Cell>;
type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export interface PayloadMeta {
  tool: string;
  queryHash: string;
}

// ---------------------------------------------------------------------------------------------
// Date ranges (since / until). The upstreams have no date filter, so the range is applied here.
// ---------------------------------------------------------------------------------------------

export interface DateRange {
  since?: string;
  until?: string;
}

const IST = "+05:30";
const DAY_MS = 86_400_000;

/** A timestamp in ms. Upstream and caller timestamps without an offset are Asia/Kolkata wall time, read so
 *  explicitly (not in the server's zone); a bare date is Kolkata midnight. "2026-10-01 10:00:00+00" and
 *  "2026-10-01 10:00:00 +05:30" (a space before the offset) are accepted. */
export function instantMs(v: string): number {
  const t = v.trim().replace(/^(\d{4}-\d{2}-\d{2}) (?=\d)/, "$1T");
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return Date.parse(`${t}T00:00:00${IST}`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t)) return NaN;
  const offset = /\s*([+-])(\d{2}):?(\d{2})?$/.exec(t.slice(16));
  if (offset) return Date.parse(`${t.slice(0, 16 + offset.index)}${offset[1]}${offset[2]}:${offset[3] ?? "00"}`);
  return Date.parse(/\s*Z$/i.test(t) ? t.replace(/\s+Z$/i, "Z") : `${t}${IST}`);
}

/** Start (inclusive) or end (exclusive) of a bound in ms. A bare date is an Asia/Kolkata calendar day, so
 *  until=2026-10-22 includes all of that day; a date-time without an offset is read as Asia/Kolkata too. */
export function boundMs(v: string, end: boolean): number {
  return instantMs(v) + (end ? (v.length === 10 ? DAY_MS : 1) : 0);
}

export const hasRange = (r: DateRange): boolean => Boolean(r.since || r.until);

/** True when the timestamp falls in the range. With a range set, a row without a parsable date is excluded. */
export function inRange(at: string | null | undefined, r: DateRange): boolean {
  if (!hasRange(r)) return true;
  const t = at ? instantMs(at) : NaN;
  if (Number.isNaN(t)) return false;
  if (r.since && t < boundMs(r.since, false)) return false;
  if (r.until && t >= boundMs(r.until, true)) return false;
  return true;
}

/** e-IRIS GET /api/office/incidents returns its newest 300 incidents and no more (as the MCP list tool notes). */
export const EIRIS_LIST_CAP = 300;

/** The upstream list is capped (newest first): when it came back full AND its oldest dated row is later than
 *  `since`, earlier incidents in the range were not returned. Gives that oldest timestamp, else null (a short
 *  list is the whole table, however recent its oldest row). */
export function truncatedAt(ats: (string | null)[], since: string | undefined, cap = EIRIS_LIST_CAP): string | null {
  if (!since || ats.length < cap) return null;
  let oldest: { at: string; t: number } | null = null;
  for (const at of ats) {
    const t = at ? instantMs(at) : NaN;
    if (!Number.isNaN(t) && (!oldest || t < oldest.t)) oldest = { at: at!, t };
  }
  return oldest && oldest.t > boundMs(since, false) ? oldest.at : null;
}

const incompleteNote = (cut: string) => `e-IRIS returned incidents back to ${cut} only; earlier ones in the range are not included`;

export function makePayload(meta: PayloadMeta, columns: string[], rows: Row[]): SourceTablePayload {
  return {
    source: { tool: meta.tool, query_hash: meta.queryHash },
    mode: "live",
    synthetic: false,
    columns,
    rows,
    row_count: rows.length,
  };
}

// ---------------------------------------------------------------------------------------------
// eiris_incidents
// ---------------------------------------------------------------------------------------------

/** INFERRED: the upstream has no single "closed" flag in the shapes we have seen. Closed = a closed_at, an
 *  sla_state of "closed", or a status of closed/resolved. */
export function isClosedIncident(r: Obj): boolean {
  if (str(r.closed_at)) return true;
  if (r.sla_state === "closed") return true;
  const s = str(r.status)?.toLowerCase();
  return s === "closed" || s === "resolved";
}

const sevOf = (r: Obj): string => str(r.severity) ?? "unrated";

export interface IncidentsInput {
  incidents: unknown;
  stats: unknown | null;
  mm: unknown | null;
  view: "summary" | "list";
  status?: "open" | "closed";
  severity?: string;
  since?: string;
  until?: string;
  limit: number;
}

const SUMMARY_COLUMNS = ["scope", "key", "open", "closed", "total"];
const LIST_COLUMNS = [
  "id", "reported_at", "severity", "state", "status", "near_miss", "type", "department", "unit_code",
  "rca_count", "has_rca", "sla_state", "due_at",
];

export function incidentRows(body: unknown): Obj[] {
  return arr(obj(body)?.incidents).map(obj).filter((r): r is Obj => r !== null);
}

export function toIncidentsPayload(meta: PayloadMeta, input: IncidentsInput): SourceTablePayload {
  const all = incidentRows(input.incidents);
  const sevFilter = input.severity?.toLowerCase();
  const range = { since: input.since, until: input.until };
  const cut = truncatedAt(all.map((r) => str(r.reported_at)), range.since);
  const rows = all.filter((r) => {
    if (!inRange(str(r.reported_at), range)) return false;
    if (sevFilter && sevOf(r).toLowerCase() !== sevFilter) return false;
    if (input.status === "open" && isClosedIncident(r)) return false;
    if (input.status === "closed" && !isClosedIncident(r)) return false;
    return true;
  });

  if (input.view === "list") {
    const out: Row[] = rows.slice(0, input.limit).map((r) => ({
      id: str(r.id),
      reported_at: str(r.reported_at),
      severity: sevOf(r),
      state: isClosedIncident(r) ? "closed" : "open",
      status: str(r.status),
      near_miss: r.near_miss === true,
      type: str(r.type_name),
      department: str(r.dept_name),
      unit_code: str(r.unit_code),
      rca_count: num(r.rca_count) ?? 0,
      has_rca: (num(r.rca_count) ?? 0) > 0,
      sla_state: str(r.sla_state),
      due_at: str(r.due_at),
    }));
    const payload = makePayload(meta, LIST_COLUMNS, out);
    return cut ? { ...payload, incomplete: incompleteNote(cut) } : payload;
  }

  const bySev = new Map<string, { open: number; closed: number }>();
  for (const r of rows) {
    const k = sevOf(r);
    const c = bySev.get(k) ?? { open: 0, closed: 0 };
    if (isClosedIncident(r)) c.closed += 1;
    else c.open += 1;
    bySev.set(k, c);
  }
  const out: Row[] = [...bySev.entries()]
    .sort((a, b) => b[1].open + b[1].closed - (a[1].open + a[1].closed) || a[0].localeCompare(b[0]))
    .map(([k, c]) => ({ scope: "severity", key: k, open: c.open, closed: c.closed, total: c.open + c.closed }));
  if (hasRange(range)) {
    // A date range is answered from the filtered incidents only: their count and their categories. The upstream's
    // all-time totals would not match the range, so they are left out.
    const byType = new Map<string, { open: number; closed: number }>();
    for (const r of rows) {
      const k = str(r.type_name) ?? "uncategorised";
      const c = byType.get(k) ?? { open: 0, closed: 0 };
      if (isClosedIncident(r)) c.closed += 1;
      else c.open += 1;
      byType.set(k, c);
    }
    for (const [k, c] of [...byType.entries()].sort((a, b) => b[1].open + b[1].closed - (a[1].open + a[1].closed) || a[0].localeCompare(b[0]))) {
      out.push({ scope: "type", key: k, open: c.open, closed: c.closed, total: c.open + c.closed });
    }
    const open = rows.filter((r) => !isClosedIncident(r)).length;
    out.push({ scope: "range", key: `${range.since ?? "start"}..${range.until ?? "now"}`, open, closed: rows.length - open, total: rows.length });
    if (cut) {
      // Say so rather than under-count: the counts above cover only what the capped list returned.
      out.push({ scope: "range_incomplete", key: incompleteNote(cut), open: null, closed: null, total: null });
      return { ...makePayload(meta, SUMMARY_COLUMNS, out), incomplete: incompleteNote(cut) };
    }
    return makePayload(meta, SUMMARY_COLUMNS, out);
  }
  // Rows above come from the newest incidents the upstream list returns (it caps the list); the totals below
  // are the upstream's own all-time counts.
  const totals = obj(obj(input.stats)?.totals);
  for (const key of ["total", "open", "near_miss", "high_sev", "with_rca", "overdue", "due_soon"]) {
    const v = num(totals?.[key]);
    if (v !== null) out.push({ scope: "totals", key, open: null, closed: null, total: v });
  }
  const mm = obj(obj(input.mm)?.totals);
  for (const key of ["open", "in_review", "gaps_open"]) {
    const v = num(mm?.[key]);
    if (v !== null) out.push({ scope: "mm_cases", key, open: null, closed: null, total: v });
  }
  return makePayload(meta, SUMMARY_COLUMNS, out);
}

// ---------------------------------------------------------------------------------------------
// eiris_incident_detail
// ---------------------------------------------------------------------------------------------

const DETAIL_COLUMNS = ["section", "field", "value"];

export function toDetailPayload(meta: PayloadMeta, body: unknown): SourceTablePayload | null {
  const inc = obj(obj(body)?.incident);
  if (!inc) return null;
  const rows: Row[] = [];
  const add = (section: string, field: string, value: Cell | undefined) => {
    if (value !== null && value !== undefined && value !== "") rows.push({ section, field, value });
  };
  add("incident", "id", str(inc.id));
  add("incident", "severity", sevOf(inc));
  add("incident", "status", str(inc.status));
  add("incident", "state", isClosedIncident(inc) ? "closed" : "open");
  add("incident", "near_miss", inc.near_miss === true);
  add("incident", "type", str(inc.type_name));
  add("incident", "department", str(inc.dept_name));
  add("incident", "location", str(inc.location_name));
  add("incident", "unit_code", str(inc.unit_code));
  add("incident", "impact_domain", str(inc.impact_domain));
  add("incident", "reporter_role", str(inc.role_name));
  add("incident", "source", str(inc.source));
  const conf = str(inc.confidentiality);
  add("incident", "confidentiality", conf);
  // As the incident page: anonymous reports show no reporter; contact only on confidential reports.
  if (conf !== "anonymous") add("incident", "reporter", str(inc.reporter_name));
  if (conf === "confidential") add("incident", "reporter_contact", str(inc.reporter_contact));
  add("patient", "name", str(inc.phi_patient_name));
  add("patient", "uhid", str(inc.phi_uhid));
  add("patient", "age", str(inc.phi_patient_age) ?? num(inc.phi_patient_age));
  add("patient", "sex", str(inc.phi_patient_sex));
  add("incident", "occurred_at", str(inc.occurred_at));
  add("incident", "reported_at", str(inc.reported_at));
  add("incident", "due_at", str(inc.due_at));
  add("incident", "closed_at", str(inc.closed_at));
  add("incident", "sla_state", str(inc.sla_state));
  add("text", "narrative", str(inc.narrative));
  add("text", "immediate_action", str(inc.immediate_action));
  const rcas = arr(obj(body)?.rcas).map(obj).filter((r): r is Obj => r !== null);
  add("rca", "rca_count", rcas.length);
  rcas.forEach((r, i) => {
    const n = `rca_${i + 1}`;
    const factors = arr(obj(r.contributory_factors)?.factors).map(obj).filter((f): f is Obj => f !== null);
    const capas = arr(r.capas).map(obj).filter((c): c is Obj => c !== null);
    add(n, "root_cause_recorded", str(r.root_cause) !== null);
    add(n, "factor_categories", [...new Set(factors.map((f) => str(f.category)).filter(Boolean))].join(", ") || null);
    add(n, "capa_count", capas.length);
    add(n, "capa_control_levels", [...new Set(capas.map((c) => str(c.control_level)).filter(Boolean))].join(", ") || null);
    add(n, "state", r.effectiveness_verified ? "verified effective" : r.closed_at ? "closed" : "open");
    add(n, "root_cause", str(r.root_cause));
    capas.forEach((c, k) => add(n, `capa_${k + 1}`, [str(c.kind), str(c.action)].filter(Boolean).join(": ") || null));
  });
  return makePayload(meta, DETAIL_COLUMNS, rows);
}

// ---------------------------------------------------------------------------------------------
// opd_signals
// ---------------------------------------------------------------------------------------------

const SIGNAL_COLUMNS = [
  "doctor_uid", "doctor", "threads", "open", "overdue", "disagreed", "awaiting_ruling", "awaiting_doctor",
  "ruled", "closed", "latest_routed_at",
];

/** Per-doctor summary of CDMSS routed audit threads (roster-audits). Counts and dates only. */
export function toSignalsPayload(meta: PayloadMeta, body: unknown, limit: number): SourceTablePayload {
  const out: Array<Row & { _attn: number }> = [];
  for (const d of arr(obj(body)?.doctors)) {
    const doc = obj(d);
    const uid = str(doc?.doctor_uid);
    if (!doc || !uid) continue;
    const seen = new Set<string>();
    let threads = 0, open = 0, overdue = 0, disagreed = 0, awaitingRuling = 0, awaitingDoctor = 0, ruled = 0, closed = 0;
    let latest: string | null = null;
    for (const s of arr(doc.signals)) {
      const sig = obj(s);
      const ref = str(sig?.reference);
      if (!sig || !ref || seen.has(ref)) continue;
      seen.add(ref);
      threads += 1;
      const status = str(sig.status) ?? "routed";
      const isOpen = status !== "ruled" && status !== "closed";
      const resp = obj(sig.response);
      const verb = resp?.verb ?? resp?.verdict;
      if (isOpen) open += 1;
      if (status === "ruled") ruled += 1;
      if (status === "closed") closed += 1;
      if (isOpen && sig.overdue === true) overdue += 1;
      if (isOpen && verb === "disagree") disagreed += 1;
      if (status === "escalated") awaitingRuling += 1;
      if (status === "routed" && (str(sig.response_required) ?? "none") !== "none") awaitingDoctor += 1;
      const at = str(sig.routed_at);
      if (at && (!latest || at > latest)) latest = at;
    }
    out.push({
      doctor_uid: uid,
      doctor: str(doc.name),
      threads,
      open,
      overdue,
      disagreed,
      awaiting_ruling: awaitingRuling,
      awaiting_doctor: awaitingDoctor,
      ruled,
      closed,
      latest_routed_at: latest,
      _attn: overdue + disagreed + awaitingRuling,
    });
  }
  out.sort((a, b) => b._attn - a._attn || Number(b.open) - Number(a.open) || String(a.doctor).localeCompare(String(b.doctor)));
  const rows = out.slice(0, limit).map((r) => {
    const copy: Row = { ...r };
    delete copy._attn;
    return copy;
  });
  return makePayload(meta, SIGNAL_COLUMNS, rows);
}
