/**
 * src/lib/doctor-audits.ts — WM2 v0: the read-only CDMSS per-doctor findings fetcher.
 *
 * ⚠️ READ-ONLY, AND THE PORTAL IS A DESTINATION — NOT A PARTICIPANT. v0 shows a physician the
 * governance findings routed to them. It offers no way to answer one. There is deliberately no
 * response path, no mutation, and no button anywhere downstream of this module: until in-portal
 * responses ship, a doctor responds through their care manager. Anything here that looked like a
 * reply affordance would be a promise the system cannot keep.
 *
 * ⚠️ WHAT IS STRIPPED, AND WHY IT IS STRIPPED HERE RATHER THAN AT RENDER ─────────────────────────
 *
 * The upstream payload carries three things a physician must not be shown:
 *   · `metrics`  — the audit/operational scorecard. These findings are advisory; putting a metric
 *                  block beside them turns "here is something to look at" into "here is your score".
 *   · `overdue`  — a per-signal lateness boolean.
 *   · `sla_due_at` — the per-signal clock behind it.
 * The last two are governance's operational instruments, not the doctor's. Showing a clock to
 * someone who has no in-portal way to stop it is the worst of both worlds.
 *
 * `toPortalPayload` builds the response by WHITELIST rather than by deleting keys. A delete-list
 * silently leaks whatever upstream adds next; a whitelist fails closed. That is also why the
 * doctor's own `uid` does not survive: the client never needs the CDMSS identifier, so it never
 * receives it.
 *
 * ⚠️ INFERRED NOTHING. The shape below is the §3 contract, verified live against CDMSS main on
 * 31 Aug 2026. Any field not named there is treated as absent rather than guessed.
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

/** A signal as the portal is allowed to see it — the lateness instruments removed. */
export type PortalAuditSignal = Omit<DoctorAuditSignal, "overdue" | "sla_due_at">;

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
 * PURE. Upstream payload → the portal's response, built by whitelist.
 *
 * `metrics` never appears because it is never copied; likewise `overdue`, `sla_due_at`, and the
 * doctor's `uid`. Tolerant of a malformed payload (a non-array `signals`, a missing `doctor`) so a
 * shape change upstream degrades to an empty, honestly-framed panel rather than a crash.
 */
export function toPortalPayload(up: DoctorAuditsUpstream): PortalFindingsPayload {
  const signals = Array.isArray(up?.signals) ? up.signals : [];
  return {
    ok: true,
    mapped: true,
    doctor: { name: up?.doctor?.name, speciality: up?.doctor?.speciality },
    window: { days: Number(up?.window?.days ?? 0) },
    signals: signals.map((s) => ({
      reference: s.reference,
      signal_id: s.signal_id,
      doctor_uid: s.doctor_uid,
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
    })),
    advisory: typeof up?.advisory === "string" && up.advisory ? up.advisory : ADVISORY_FALLBACK,
  };
}
