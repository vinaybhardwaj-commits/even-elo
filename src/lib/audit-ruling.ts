/**
 * src/lib/audit-ruling.ts — a governance ruling on a routed thread (Round 2 / F3).
 *
 * Order of work, and why:
 *
 *   1. Read the thread from CDMSS (label, doctor). Unknown reference -> 404, nothing written.
 *   2. Record ONE gov_interventions row, keyed by `${reference}|${action}` (unique index). A retry,
 *      a double click and a network replay all find that row and reuse its id: there is never a
 *      second row for the same thread + action. This is EPI's system of record for the decision.
 *   3. POST /signal-action with gov_intervention_ref = that row's id. CDMSS treats a repeat of
 *      (ref, action) as a 200 no-op, so step 3 is safe to repeat as often as step 2 is.
 *
 * Outcomes:
 *   200 (fresh or replayed)  success; the row is marked synced.
 *   409                      the thread moved or the transition is illegal. The row for this attempt is
 *                            removed (it never took effect), and the caller is told the CURRENT status
 *                            so the screen can refresh instead of showing a stale button.
 *   400 / 404                refused upstream; same clean-up, a plain message.
 *   anything else            CDMSS unreachable or erroring. The row STAYS pending, so pressing the
 *                            button again is a retry of the same decision, not a second one.
 *
 * The note is required: a ruling without a reason is not a ruling.
 */

import { sql } from "@/lib/db";
import { actionLabel, isSignalAction, toFindingRow, type FindingRow, type SignalAction } from "@/lib/audit-findings";
import { fetchAuditSignal, isAuditReference, postSignalAction, upstreamError } from "@/lib/cdmss-governance";
import { loadDoctorLookup } from "@/lib/audit-findings-server";

export const NOTE_MIN = 3;
export const NOTE_MAX = 2000;

export type RulingBody =
  | { ok: true; action: SignalAction; note: string }
  | { ok: false; message: string };

/** PURE. The request body of a ruling, or why it is refused. Extra keys are refused, not ignored. */
export function parseRulingBody(raw: unknown): RulingBody {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "body must be a JSON object" };
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "action" && k !== "note")) return { ok: false, message: "unexpected field in body" };
  if (!isSignalAction(o.action)) {
    return { ok: false, message: "action must be acknowledged_by_governance, privilege_action, dismissed or closed" };
  }
  const note = typeof o.note === "string" ? o.note.trim() : "";
  if (note.length < NOTE_MIN) return { ok: false, message: "A note is required: say why you are making this ruling." };
  return { ok: true, action: o.action, note: note.slice(0, NOTE_MAX) };
}

/** The idempotency key: one decision per thread + action. */
export function rulingKey(reference: string, action: string): string {
  return `${reference}|${action}`;
}

export interface RulingActor {
  profileId: string;
  email: string;
}

export type RulingResult =
  | { ok: true; replayed: boolean; status: string | null; intervention_id: string; row: FindingRow | null }
  | {
      ok: false;
      http: 400 | 404 | 409 | 502;
      error: "not_found" | "invalid" | "conflict" | "unavailable";
      message: string;
      current_status?: string | null;
    };

interface InterventionRow {
  id: string;
  cdmss_sync_state: string | null;
}

async function audit(
  actor: RulingActor,
  action: string,
  reference: string,
  after: Record<string, unknown>,
): Promise<void> {
  try {
    await sql`INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
              VALUES (${actor.profileId}::uuid, ${action}, 'audit_thread', ${reference}, ${JSON.stringify(after)}::jsonb)`;
  } catch {
    // The decision is already recorded in gov_interventions; a missing log row costs nothing else.
  }
}

async function currentStatusOf(reference: string): Promise<string | null> {
  const o = await fetchAuditSignal(reference);
  if (o.kind !== "http" || o.status !== 200) return null;
  const sig = (o.body as { signal?: { status?: unknown } } | null)?.signal;
  return typeof sig?.status === "string" ? sig.status : null;
}

export async function recordRuling(input: {
  reference: string;
  action: SignalAction;
  note: string;
  actor: RulingActor;
}): Promise<RulingResult> {
  const { reference, action, note, actor } = input;
  if (!isAuditReference(reference)) {
    return { ok: false, http: 400, error: "invalid", message: "That is not a thread reference." };
  }

  // 1. The thread, from CDMSS.
  const thread = await fetchAuditSignal(reference);
  if (thread.kind === "http" && thread.status === 404) {
    return { ok: false, http: 404, error: "not_found", message: "CDMSS does not know this thread." };
  }
  if (thread.kind !== "http" || thread.status !== 200) {
    return { ok: false, http: 502, error: "unavailable", message: "CDMSS did not answer. Nothing was recorded; try again." };
  }
  const lookup = await loadDoctorLookup();
  const before = toFindingRow((thread.body as { signal?: unknown } | null)?.signal, lookup);
  if (!before) {
    return { ok: false, http: 502, error: "unavailable", message: "CDMSS sent a thread this screen cannot read. Nothing was recorded." };
  }

  // 2. One decision row per thread + action.
  const key = rulingKey(reference, action);
  const kindNote = `${actionLabel(action)}: ${note}`;
  let interventionId: string | null = null;
  try {
    const inserted = (await sql`
      INSERT INTO gov_interventions
        (signal_key, signal_label, kind, note, physician_id, actor_email, action, idempotency_key, cdmss_sync_state)
      VALUES
        (${reference}, ${before.finding_type}, 'other', ${kindNote}, ${before.physician_id}::uuid,
         ${actor.email}, ${action}, ${key}, 'pending')
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id::text AS id`) as unknown as Array<{ id: string }>;
    interventionId = inserted[0]?.id ?? null;
    if (!interventionId) {
      const found = (await sql`
        SELECT id::text AS id, cdmss_sync_state FROM gov_interventions WHERE idempotency_key = ${key} LIMIT 1`) as unknown as InterventionRow[];
      interventionId = found[0]?.id ?? null;
    }
  } catch {
    return { ok: false, http: 502, error: "unavailable", message: "The decision could not be recorded. Nothing was sent to CDMSS; try again." };
  }
  if (!interventionId) {
    return { ok: false, http: 502, error: "unavailable", message: "The decision could not be recorded. Nothing was sent to CDMSS; try again." };
  }

  // 3. The CDMSS ruling.
  const out = await postSignalAction({
    reference,
    action,
    note,
    actor: `gov:${actor.email}`.slice(0, 64),
    govInterventionRef: interventionId,
  });

  if (out.kind === "http" && out.status === 200 && (out.body as { ok?: boolean } | null)?.ok !== false) {
    const body = (out.body ?? {}) as { replayed?: unknown; status?: unknown; signal?: unknown };
    const replayed = body.replayed === true;
    try {
      await sql`UPDATE gov_interventions SET cdmss_sync_state = 'synced', cdmss_sync_error = NULL WHERE id = ${interventionId}::uuid`;
    } catch {
      // The ruling is applied upstream; the next identical press re-marks it.
    }
    if (!replayed) await audit(actor, "audit_ruling", reference, { action, intervention_id: interventionId });
    return {
      ok: true,
      replayed,
      status: typeof body.status === "string" ? body.status : null,
      intervention_id: interventionId,
      row: toFindingRow(body.signal, lookup),
    };
  }

  if (out.kind === "http" && (out.status === 409 || out.status === 400 || out.status === 404)) {
    const text = upstreamError(out.body);
    // The attempt never took effect: remove its row (never a row CDMSS already confirmed).
    try {
      await sql`DELETE FROM gov_interventions WHERE id = ${interventionId}::uuid AND cdmss_sync_state IS DISTINCT FROM 'synced'`;
    } catch {
      // Left pending; the next press reuses it.
    }
    if (out.status === 409) {
      const current = await currentStatusOf(reference);
      await audit(actor, "audit_ruling_refused", reference, { action, status: 409, current_status: current, error: text });
      return {
        ok: false,
        http: 409,
        error: "conflict",
        message: "This thread has changed since you opened it, so the ruling was not applied. The current status is shown.",
        current_status: current,
      };
    }
    return {
      ok: false,
      http: out.status === 404 ? 404 : 400,
      error: out.status === 404 ? "not_found" : "invalid",
      message: text || "CDMSS refused the ruling.",
    };
  }

  // Transport failure, 401 (key), 5xx: unknown outcome. The row stays pending so a retry is the same decision.
  try {
    const why = out.kind === "http" ? `status ${out.status} ${upstreamError(out.body)}`.trim() : "transport";
    await sql`UPDATE gov_interventions SET cdmss_sync_error = ${why.slice(0, 300)} WHERE id = ${interventionId}::uuid`;
  } catch {
    // Best effort.
  }
  return {
    ok: false,
    http: 502,
    error: "unavailable",
    message: "The decision is saved here but CDMSS did not confirm it. Press the button again to retry; it will not be recorded twice.",
  };
}
