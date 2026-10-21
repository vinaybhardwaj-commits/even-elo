"use client";

import { useState } from "react";
import { NOTE_MAX, NOTE_MIN, RULING_CHOICE, SECOND_FACTOR_READY, allowedRulingActions, type RulingAction } from "@/lib/rulings/model";

const ERROR_TEXT: Record<string, string> = {
  second_factor_required: "A second factor is required before a ruling can be recorded.",
  conflict: "The thread moved while you were looking. Reload it and rule again.",
  forbidden: "Your account cannot rule on this thread.",
  unauthorized: "Your session is no longer valid. Sign in again.",
  not_found: "CDMSS does not know this thread.",
  cdmss_unconfirmed: "The ruling is saved but CDMSS has not confirmed it. Press confirm again to retry the same decision.",
  bad_params: "The ruling was not accepted. Check the action and the note.",
};

/**
 * Typed confirm card for a ruling. Nothing is sent until the person picks an action, writes the note and presses
 * Confirm. The agent cannot press it. The server forwards to the existing even-elo ruling route with this
 * person's own session. Disabled while the second factor (G3) does not exist.
 */
export function RulingCard({ reference, status }: { reference: string; status: string }) {
  const actions = allowedRulingActions(status);
  const [action, setAction] = useState<RulingAction | "">("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const noteOk = note.trim().length >= NOTE_MIN && note.trim().length <= NOTE_MAX;
  const canConfirm = SECOND_FACTOR_READY && !!action && noteOk && !busy;

  async function confirm() {
    if (!canConfirm) return;
    setBusy(true);
    try {
      const res = await fetch(`/studio/api/audit-findings/${encodeURIComponent(reference)}/ruling`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, note: note.trim() }),
        cache: "no-store",
      });
      const body: { ok?: boolean; error?: string; replayed?: boolean } | null = await res.json().catch(() => null);
      setResult(res.ok && body?.ok ? (body.replayed ? "Already recorded." : "Ruling recorded. Reload to see the new status.") : (ERROR_TEXT[body?.error ?? ""] ?? "The ruling was not recorded."));
    } catch {
      setResult("The ruling was not recorded. Retry.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="scr-card" aria-label="Record a ruling" data-testid="ruling-card">
      <header className="scr-card-head">
        <h2>Record a ruling</h2>
        <p>Posts to the existing governance ruling route, which relays it to CDMSS. Nothing is saved until you confirm.</p>
      </header>
      {actions.length === 0 ? (
        <p className="scr-muted">{status ? "This thread is closed; no ruling can be recorded." : "Rulings are available once the thread has loaded."}</p>
      ) : (
        <form className="scr-form" onSubmit={(e) => { e.preventDefault(); void confirm(); }}>
          <fieldset>
            <legend>Action</legend>
            {actions.map((a) => (
              <label key={a}>
                <input type="radio" name="ruling-action" value={a} checked={action === a} onChange={() => setAction(a)} /> {RULING_CHOICE[a].button}
                <span className="scr-muted"> — {RULING_CHOICE[a].help}</span>
              </label>
            ))}
          </fieldset>
          <label>
            Reason (required, {NOTE_MIN}–{NOTE_MAX} characters)
            <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={NOTE_MAX} rows={4} />
          </label>
          {action && noteOk && (
            <p data-testid="ruling-summary">
              You are about to record “{RULING_CHOICE[action].button}” on {reference}.
            </p>
          )}
          {!SECOND_FACTOR_READY && (
            <p className="scr-muted" role="note" data-testid="ruling-second-factor">
              Needs second factor: rulings are switched off until the second-factor check is in place.
            </p>
          )}
          <button type="submit" disabled={!canConfirm}>
            Confirm ruling
          </button>
          {result && <p role="status">{result}</p>}
        </form>
      )}
    </section>
  );
}
