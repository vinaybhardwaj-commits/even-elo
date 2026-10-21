// Pure shaping of CDMSS audit-thread bodies (roster-audits, audit-signal) into SourceTablePayload tables.
// No env, no I/O. Upstream bodies are untrusted: every field is read defensively, unknown fields are dropped.
//
// Never emitted, whatever the upstream sends: patient identity, doctor free text, ruling notes, finding
// rationale and subject. Those are emitted only when the caller sets include_text on audit_finding_detail
// (super_admin screen path; the chat action drops the key). Governance sees what the even-elo page shows.

import type { SourceTablePayload } from "@/lib/screens/tool-schema";
import { makePayload, type PayloadMeta } from "./transform";

type Cell = string | number | boolean | null;
type Row = Record<string, Cell>;
type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Hospital code = prefix of the reference (EHRC-AUD-2026-0001 -> EHRC). */
export const hospitalOf = (reference: string): string => reference.split("-")[0] ?? "";

/** The doctor's verb, from the P2 `verb` or the legacy verdict / acknowledgment type. */
function verbOf(raw: unknown): string | null {
  const o = obj(raw);
  if (!o) return null;
  const v = o.verb ?? o.verdict;
  if (v === "agree" || v === "disagree" || v === "needs_clarification") return v;
  return o.type === "acknowledgment" ? "agree" : null;
}

export type AuditView = "attention" | "overdue" | "disagreed" | "awaiting_ruling" | "awaiting_doctor" | "all";

export interface Thread {
  reference: string;
  hospital: string;
  doctor_uid: string;
  doctor: string | null;
  finding: string;
  note_class: string;
  status: string;
  importance: string | null;
  response_required: string;
  doctor_response: string | null;
  ruling_action: string | null;
  overdue: boolean;
  disagreed: boolean;
  awaiting_ruling: boolean;
  awaiting_doctor: boolean;
  routed_at: string | null;
  sla_due_at: string | null;
  instances: number | null;
}

const titleOf = (label: unknown, type: unknown): string => {
  const l = str(label);
  if (l) return l;
  const t = str(type)?.replace(/_/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "Finding";
};

/** One CDMSS signal -> a thread; null when it is not one. Same status rules as even-elo's audit-findings.ts. */
export function toThread(raw: unknown, doctorName?: string | null): Thread | null {
  const s = obj(raw);
  const reference = str(s?.reference);
  const doctorUid = str(s?.doctor_uid);
  if (!s || !reference || !doctorUid) return null;
  const status = str(s.status) ?? "routed";
  const responseRequired = str(s.response_required) ?? "none";
  const verb = verbOf(s.response);
  const open = status !== "ruled" && status !== "closed";
  const nc = s.note_class;
  return {
    reference,
    hospital: hospitalOf(reference),
    doctor_uid: doctorUid,
    doctor: doctorName ?? null,
    finding: titleOf(s.label, s.signal_type),
    note_class: nc === "discharge" || nc === "discharge_summary" ? "discharge_summary" : nc === "ot" ? "ot" : "opd",
    status,
    importance: str(s.importance),
    response_required: responseRequired,
    doctor_response: verb,
    ruling_action: str(obj(s.ruling)?.action),
    overdue: open && s.overdue === true,
    disagreed: open && verb === "disagree",
    awaiting_ruling: status === "escalated",
    awaiting_doctor: status === "routed" && responseRequired !== "none",
    routed_at: str(s.routed_at),
    sla_due_at: str(s.sla_due_at),
    instances: num(s.instances),
  };
}

const needsAttention = (t: Thread) => t.overdue || t.disagreed || t.awaiting_ruling;

export function inView(t: Thread, view: AuditView): boolean {
  switch (view) {
    case "attention": return needsAttention(t);
    case "overdue": return t.overdue;
    case "disagreed": return t.disagreed;
    case "awaiting_ruling": return t.awaiting_ruling;
    case "awaiting_doctor": return t.awaiting_doctor;
    default: return true;
  }
}

/** Every thread in a roster-audits body, de-duplicated by reference. */
export function threadsFromRoster(body: unknown): Thread[] {
  const out: Thread[] = [];
  const seen = new Set<string>();
  for (const d of arr(obj(body)?.doctors)) {
    const doc = obj(d);
    for (const sig of arr(doc?.signals)) {
      const t = toThread(sig, str(doc?.name));
      if (!t || seen.has(t.reference)) continue;
      seen.add(t.reference);
      out.push(t);
    }
  }
  return out;
}

const LIST_COLUMNS = [
  "reference", "hospital", "doctor_uid", "doctor", "finding", "note_class", "status", "importance", "response_required",
  "doctor_response", "ruling_action", "overdue", "needs_attention", "routed_at", "sla_due_at", "instances",
];

export interface FindingsFilter {
  view?: AuditView;
  status?: string;
  hospital?: string;
  limit: number;
}

/** Threads for the worklist: filtered, attention first then newest routed. Counts and codes only. */
export function toFindingsPayload(meta: PayloadMeta, body: unknown, f: FindingsFilter): SourceTablePayload {
  const view = f.view ?? "attention";
  const all = threadsFromRoster(body);
  const rows = all
    .filter((t) => inView(t, view) && (!f.status || t.status === f.status) && (!f.hospital || t.hospital === f.hospital))
    .sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)) || (b.routed_at ?? "").localeCompare(a.routed_at ?? ""))
    .slice(0, f.limit)
    .map((t): Row => ({
      reference: t.reference, hospital: t.hospital, doctor_uid: t.doctor_uid, doctor: t.doctor, finding: t.finding,
      note_class: t.note_class, status: t.status, importance: t.importance, response_required: t.response_required,
      doctor_response: t.doctor_response, ruling_action: t.ruling_action, overdue: t.overdue, needs_attention: needsAttention(t),
      routed_at: t.routed_at, sla_due_at: t.sla_due_at, instances: t.instances,
    }));
  return makePayload(meta, LIST_COLUMNS, rows);
}

const DETAIL_COLUMNS = ["section", "field", "value"];

/** One thread (audit-signal body): header, doctor response, ruling, evidence instances, timeline. */
export function toFindingDetailPayload(meta: PayloadMeta, body: unknown, includeText: boolean): SourceTablePayload | null {
  const root = obj(body);
  const sig = obj(root?.signal);
  const t = toThread(sig);
  if (!sig || !t) return null;
  const rows: Row[] = [];
  const add = (section: string, field: string, value: Cell | undefined) => {
    if (value !== null && value !== undefined && value !== "") rows.push({ section, field, value });
  };
  add("thread", "reference", t.reference);
  add("thread", "hospital", t.hospital);
  add("thread", "doctor_uid", t.doctor_uid);
  add("thread", "finding", t.finding);
  add("thread", "note_class", t.note_class);
  add("thread", "status", t.status);
  add("thread", "importance", t.importance);
  add("thread", "response_required", t.response_required);
  add("thread", "overdue", t.overdue);
  add("thread", "routed_at", t.routed_at);
  add("thread", "sla_due_at", t.sla_due_at);
  add("thread", "instances", t.instances);
  const win = obj(sig.window);
  add("thread", "window_from", str(win?.from));
  add("thread", "window_to", str(win?.to));

  const resp = obj(sig.response);
  if (resp) {
    add("response", "verb", t.doctor_response);
    add("response", "responded_at", str(resp.responded_at) ?? str(resp.at));
    if (includeText) add("response", "comment", str(resp.comment));
  }
  const ruling = obj(sig.ruling);
  if (ruling) {
    add("ruling", "action", str(ruling.action));
    add("ruling", "ruled_at", str(ruling.ruled_at));
    add("ruling", "gov_intervention_ref", str(ruling.gov_intervention_ref));
    if (includeText) {
      add("ruling", "actor", str(ruling.actor));
      add("ruling", "note", str(ruling.note));
    }
  }

  // Evidence: the audited note instances behind the finding (the representative when the list is empty).
  let instances = arr(root?.instances).map(obj).filter((i): i is Obj => i !== null);
  if (instances.length === 0) {
    const rep = obj(sig.representative);
    if (rep) instances = [rep];
  }
  add("evidence", "instance_count", instances.length);
  instances.slice(0, 50).forEach((i, k) => {
    const n = `evidence_${k + 1}`;
    add(n, "audit_id", str(i.audit_id));
    add(n, "finding_ref", str(i.finding_ref));
    add(n, "verdict", str(i.verdict));
    add(n, "note_date", str(i.note_date));
    const cites = arr(i.citations).map(obj).filter((c): c is Obj => c !== null);
    add(n, "citations", cites.map((c) => str(c.title)).filter(Boolean).slice(0, 12).join("; ") || null);
    if (includeText) {
      add(n, "subject", str(i.subject));
      add(n, "rationale", str(i.rationale));
    }
  });

  // Timeline: event, actor class and time. Actor is "cm:x", "doctor:x" or "gov:x"; the doctor id is dropped.
  const events = arr(root?.events).map(obj).filter((e): e is Obj => e !== null);
  events
    .sort((a, b) => (str(a.at) ?? "").localeCompare(str(b.at) ?? ""))
    .slice(0, 100)
    .forEach((e, k) => {
      const n = `event_${String(k + 1).padStart(2, "0")}`;
      const actor = str(e.actor);
      add(n, "event", str(e.event));
      add(n, "at", str(e.at));
      add(n, "actor", actor ? (actor.startsWith("doctor:") ? "doctor" : actor.startsWith("cm:") ? "care manager" : actor.startsWith("gov:") ? "governance" : "system") : "system");
      if (includeText) add(n, "note", str(obj(e.payload)?.note) ?? str(obj(e.payload)?.comment));
    });
  return makePayload(meta, DETAIL_COLUMNS, rows);
}
