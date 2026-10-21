// Client-safe model of an audit-thread ruling: the action vocabulary and which actions a status allows.
// Mirrors even-elo src/lib/audit-findings.ts (SIGNAL_ACTIONS, ACTION_CHOICE, allowedActions); CDMSS stays the authority.

export const RULING_ACTIONS = ["acknowledged_by_governance", "privilege_action", "dismissed", "closed"] as const;
export type RulingAction = (typeof RULING_ACTIONS)[number];

export const RULING_CHOICE: Record<RulingAction, { button: string; help: string }> = {
  acknowledged_by_governance: { button: "Acknowledge", help: "Governance has reviewed this and needs nothing further. The thread stays visible to the doctor." },
  privilege_action: { button: "Record privilege review", help: "Records that governance referred this for a privilege review. It does not change any privilege." },
  dismissed: { button: "Dismiss", help: "Not applicable. The thread closes and disappears from the doctor's list." },
  closed: { button: "Close", help: "Resolved. The thread closes; the doctor's response stays on record." },
};

export const NOTE_MIN = 3;
export const NOTE_MAX = 2000;

export function allowedRulingActions(status: string): RulingAction[] {
  if (status === "closed") return [];
  if (status === "ruled") return ["privilege_action", "closed", "dismissed"];
  return [...RULING_ACTIONS];
}

/**
 * Rulings need the G3 second factor. None exists yet, so the confirm card stays disabled and the server route
 * refuses every ruling (second_factor_required). Flip only together with a real verifier in lib/rulings/forward.ts.
 */
export const SECOND_FACTOR_READY = false;

export const isRulingAction = (v: unknown): v is RulingAction => typeof v === "string" && (RULING_ACTIONS as readonly string[]).includes(v);

export type RulingBody = { ok: true; action: RulingAction; note: string } | { ok: false };

/** Strict: exactly { action, note }; the note is required (3-2000 chars after trimming). */
export function parseRulingBody(raw: unknown): RulingBody {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "action" && k !== "note")) return { ok: false };
  if (!isRulingAction(o.action) || typeof o.note !== "string") return { ok: false };
  const note = o.note.trim();
  if (note.length < NOTE_MIN || note.length > NOTE_MAX) return { ok: false };
  return { ok: true, action: o.action, note };
}
