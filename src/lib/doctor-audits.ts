/**
 * src/lib/doctor-audits.ts — WM2: the CDMSS per-doctor findings fetcher.
 *
 * ⚠️ THE READ PATH IS STILL READ-ONLY. This module fetches and strips; it writes nothing. WM2 v1
 * adds two write paths, and they live elsewhere on purpose: src/lib/findings-actions.ts holds the
 * two CDMSS calls. Private reactions use PORTAL_REACTIONS; workflow responses use the independent
 * PORTAL_FINDINGS_RESPOND flag. The one thing this module gained for reactions is `my_reaction`,
 * the doctor's OWN reaction read back so the card can render what they already recorded.
 *
 * ⚠️ WHAT IS STRIPPED, AND WHY IT IS STRIPPED HERE RATHER THAN AT RENDER ─────────────────────────
 *
 * The upstream payload carries three OPERATIONAL fields a physician must not be shown (the fourth
 * stripped item, the CDMSS uid, is an identifier and has its own contract below):
 *   · `metrics`  — the audit/operational scorecard. These findings are advisory; putting a metric
 *                  block beside them turns "here is something to look at" into "here is your score".
 *   · `overdue`  — a per-signal lateness boolean.
 *   · `sla_due_at` — the per-signal clock behind it.
 * The last two are governance's operational instruments, not the doctor's.
 *
 * `toPortalSignal` builds each signal by WHITELIST rather than by deleting keys. A delete-list
 * silently leaks whatever upstream adds next; a whitelist fails closed. `my_reaction` is grafted on
 * by this module from a SEPARATE call — it never rides in on the upstream signal, so widening the
 * whitelist was not necessary to carry it.
 *
 * ⚠️ STANDING PORTAL CONTRACT: `physicians.cdmss_doctor_uid` is NEVER exposed by a portal API. It
 * is dropped in BOTH places upstream carries it — the envelope's `doctor.uid` and every signal's
 * `doctor_uid` — and the omission is enforced by the type (`PortalAuditSignal`) as well as by the
 * whitelist, so re-adding it fails the typecheck rather than passing review. The uid is a join key
 * between two internal systems; a physician's browser has no use for it, and an identifier that is
 * never sent cannot leak from the client. The reaction endpoints keep the same contract: the uid is
 * looked up server-side per request and is never read from, nor returned to, the client.
 *
 * ⚠️ INFERRED NOTHING. The shape below is the §3 contract, verified live against CDMSS main on
 * 31 Aug 2026; the reactions shape is the B2a contract restated in the WM2 v1 kickoff. Any field
 * not named there is treated as absent rather than guessed.
 *
 * Fetch idioms (x-api-key, GOV_API_BASE default, cache:'no-store', the 8s abort) are the ones
 * src/lib/gov-signals.ts already uses. That file is NOT modified and NOT imported — this is a
 * separate reader of a separate endpoint, and coupling them would tie a physician-facing surface
 * to the governance snapshot store's lifecycle.
 */

const BASE = process.env.GOV_API_BASE || "https://even-cdmss.vercel.app";

/** The advisory framing, verbatim (§3). Used only as a fallback when upstream omits it — the
 *  panel must never render findings with no framing at all. */
export const ADVISORY_FALLBACK =
  "Advisory documentation & prescribing signals validated by a care manager — not a performance score.";

export interface AuditCitation { n: number; title: string; url: string }

export interface AuditRepresentative {
  audit_id: string;
  finding_ref: string;
  subject: string;
  verdict: string;
  rationale: string;
  note_date: string | null;
  citations: AuditCitation[];
}

export interface DoctorSafeTriage {
  rationale: string | null;
  policy_version: string | null;
}

export type AuditStatus = "routed" | "responded" | "escalated" | "ruled" | "closed";

/** One signal exactly as upstream sends it. */
export interface DoctorAuditSignal {
  reference: string;              // EHRC-AUD-YYYY-NNNN
  signal_id: string;
  doctor_uid: string;
  signal_type: string;
  label: string;
  importance: string;
  response_required: string;
  status: AuditStatus;
  overdue: boolean;               // STRIPPED before it reaches the portal
  instances: number;
  window: { from: string | null; to: string | null };
  representative: AuditRepresentative | null;
  routed_at: string | null;
  sla_due_at: string | null;      // STRIPPED before it reaches the portal
  response: unknown | null;
  ruling: unknown | null;
  triage?: DoctorSafeTriage | null;
}

/** The upstream envelope. `metrics` is typed so the strip is visible, never so it can be rendered. */
export interface DoctorAuditsUpstream {
  ok: boolean;
  doctor: { uid: string; name?: string; speciality?: string };
  window: { days: number };
  metrics: { audit: unknown; operational: unknown };
  signals: DoctorAuditSignal[];
  advisory: string;
}

/** The doctor's own reaction to one signal. Private: it notifies nobody and goes nowhere near the
 *  care-manager workflow. `at` is an ISO timestamp as CDMSS sends it. */
export interface PortalReaction { reaction: string; at: string }

/** signal_id → that doctor's reaction. The shape of the reactions GET's `reactions` object. */
export type ReactionMap = Record<string, PortalReaction | undefined>;

/** A signal as the portal is allowed to see it — the lateness instruments and the CDMSS join key
 *  removed, the doctor's own reaction added. Omitting the three in the TYPE is what makes the strip
 *  enforceable rather than habitual. */
export type PortalAuditSignal = Omit<DoctorAuditSignal, "overdue" | "sla_due_at" | "doctor_uid"> & {
  my_reaction: PortalReaction | null;
};

export interface PortalFindingsPayload {
  ok: true;
  mapped: true;
  doctor: { name?: string; speciality?: string };
  window: { days: number };
  signals: PortalAuditSignal[];
  advisory: string;
}

/**
 * Fetch one doctor's routed findings. THROWS on any failure — a missing key, a non-2xx, a timeout.
 * The route catches and converts that into the honest `upstream_unavailable` state; an outage must
 * never be allowed to render as "you have no findings".
 */
export async function fetchDoctorAudits(
  doctorUid: string,
  params: { window: number; status: string },
): Promise<DoctorAuditsUpstream> {
  const key = process.env.GOV_API_KEY;
  if (!key) throw new Error("GOV_API_KEY not configured");
  const qs = new URLSearchParams({
    doctor_uid: doctorUid,
    window: String(params.window),
    status: params.status,
  });
  const res = await fetch(`${BASE}/api/governance/doctor-audits?${qs.toString()}`, {
    headers: { "x-api-key": key },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`CDMSS doctor-audits API ${res.status}: ${body}`);
  }
  return (await res.json()) as DoctorAuditsUpstream;
}

/**
 * Fetch this doctor's own reactions, keyed by signal_id. THROWS on any failure, like the audits
 * fetch — but the findings route treats a throw here very differently: reactions are an ENHANCEMENT
 * to a panel that must still render. A doctor whose reactions could not be read sees their findings
 * with no reaction recorded, not an outage page. So the route catches this and sets null on every
 * signal while still answering ok:true.
 *
 * `physicianId` is the portal's own identifier and is sent so CDMSS can scope the read to one
 * person; it is taken from the session by the caller and never from a request body.
 */
export async function fetchDoctorReactions(
  doctorUid: string,
  physicianId: string,
): Promise<ReactionMap> {
  const key = process.env.GOV_API_KEY;
  if (!key) throw new Error("GOV_API_KEY not configured");
  const qs = new URLSearchParams({ doctor_uid: doctorUid, physician_id: physicianId });
  const res = await fetch(`${BASE}/api/governance/signal-reaction?${qs.toString()}`, {
    headers: { "x-api-key": key },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`CDMSS signal-reaction API ${res.status}: ${body}`);
  }
  const j = (await res.json()) as { reactions?: unknown };
  return normalizeReactions(j?.reactions);
}

/** PURE. Anything upstream calls a reactions map → a map this module will vouch for. A malformed
 *  entry is dropped rather than rendered, so a shape change degrades to "no reaction recorded". */
export function normalizeReactions(raw: unknown): ReactionMap {
  const out: ReactionMap = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [signalId, v] of Object.entries(raw as Record<string, unknown>)) {
    const r = toReaction(v);
    if (r) out[signalId] = r;
  }
  return out;
}

/** PURE. One reaction entry, whitelisted to the two fields the card renders. */
export function toReaction(v: unknown): PortalReaction | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.reaction !== "string" || !o.reaction) return null;
  return { reaction: o.reaction, at: typeof o.at === "string" ? o.at : "" };
}

/**
 * PURE. One upstream signal → the portal's view of it, built by whitelist.
 *
 * `overdue`, `sla_due_at` and `doctor_uid` never appear because they are never copied. `my_reaction`
 * is supplied by the caller — it comes from a different endpoint, so it is a parameter rather than
 * a field read off `s`.
 */
export function toPortalSignal(
  s: DoctorAuditSignal,
  myReaction: PortalReaction | null = null,
): PortalAuditSignal {
  return {
    reference: s.reference,
    signal_id: s.signal_id,
    signal_type: s.signal_type,
    label: s.label,
    importance: s.importance,
    response_required: s.response_required,
    status: s.status,
    instances: s.instances,
    window: s.window,
    representative: s.representative ?? null,
    routed_at: s.routed_at ?? null,
    response: s.response ?? null,
    ruling: s.ruling ?? null,
    triage: s.triage
      ? {
          rationale: typeof s.triage.rationale === "string" ? s.triage.rationale : null,
          policy_version:
            typeof s.triage.policy_version === "string" ? s.triage.policy_version : null,
        }
      : null,
    my_reaction: myReaction,
  };
}

/**
 * PURE. Upstream payload → the portal's response, built by whitelist.
 *
 * `metrics` never appears because it is never copied; likewise `overdue`, `sla_due_at`, and the
 * doctor's `uid`. Tolerant of a malformed payload (a non-array `signals`, a missing `doctor`) so a
 * shape change upstream degrades to an empty, honestly-framed panel rather than a crash.
 *
 * `reactions` is the merge the findings route performs after its second CDMSS call. Pass null (or
 * nothing) and every signal carries `my_reaction: null` — which is exactly what that route does
 * when the reactions call fails.
 */
export function toPortalPayload(
  up: DoctorAuditsUpstream,
  reactions?: ReactionMap | null,
): PortalFindingsPayload {
  const signals = Array.isArray(up?.signals) ? up.signals : [];
  return {
    ok: true,
    mapped: true,
    doctor: { name: up?.doctor?.name, speciality: up?.doctor?.speciality },
    window: { days: Number(up?.window?.days ?? 0) },
    signals: signals.map((s) => toPortalSignal(s, reactions?.[s.signal_id] ?? null)),
    advisory: typeof up?.advisory === "string" && up.advisory ? up.advisory : ADVISORY_FALLBACK,
  };
}
