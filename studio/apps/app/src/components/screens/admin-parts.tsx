"use client";

import { useState, type ReactNode } from "react";
import type { AdminState } from "@/lib/screens/use-admin";
import type { ScreenToolState } from "@/lib/screens/use-screen-tool";

export const asScreenState = (s: AdminState): ScreenToolState => (s.status === "ok" ? { status: "ok", data: s.data.table } : s.status === "error" ? s : { status: "loading" });

export const WRITE_ERRORS: Record<string, string> = {
  second_factor_required: "This action needs the second factor, which is not available yet.",
  forbidden: "Only a super_admin can do this.",
  not_found: "That record no longer exists.",
  already_processed: "That request was already processed.",
  last_super_admin: "The last active super_admin cannot be changed.",
  unauthorized: "Your session is no longer valid. Sign in again.",
  bad_params: "The request was not accepted.",
};

/**
 * Two steps, never automatic: Review shows the effect, Confirm sends it. Disabled while there is no second factor
 * or the viewer is not a super_admin. The effect text names exactly what the existing even-elo route will do.
 */
export function ConfirmCard({
  title,
  effect,
  enabled,
  disabledNote,
  canConfirm = true,
  submit,
  onDone,
  children,
}: {
  title: string;
  effect: string;
  enabled: boolean;
  disabledNote?: string;
  canConfirm?: boolean;
  submit: () => Promise<string | null>;
  onDone: () => void;
  children?: ReactNode;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  return (
    <div className="scr-card" role="group" aria-label={title}>
      <h3 className="scr-sub">{title}</h3>
      <p className="scr-muted">{effect}</p>
      {children}
      {!enabled && (
        <p className="scr-muted" data-testid="second-factor-note">
          {disabledNote ?? "Needs second factor. This action is disabled until it is available."}
        </p>
      )}
      {result && (
        <p className="scr-error" role="alert">
          {result}
        </p>
      )}
      {!armed ? (
        <button type="button" disabled={!enabled || !canConfirm} onClick={() => setArmed(true)}>
          Review
        </button>
      ) : (
        <>
          <p role="status">Confirm to apply this change now. Nothing is deleted.</p>
          <button
            type="button"
            disabled={!enabled || busy}
            onClick={async () => {
              setBusy(true);
              const err = await submit();
              setBusy(false);
              if (err) setResult(WRITE_ERRORS[err] ?? "The change failed. Nothing was saved.");
              else {
                setArmed(false);
                setResult(null);
                onDone();
              }
            }}
          >
            Confirm
          </button>
          <button type="button" disabled={busy} onClick={() => setArmed(false)}>
            Cancel
          </button>
        </>
      )}
    </div>
  );
}
