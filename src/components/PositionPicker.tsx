"use client";

import { POSITION_SEEDS } from "@/lib/position";

interface PositionPickerProps {
  onPick: (name: string) => void;
  onClose: () => void;
  /**
   * Whether the picker can be closed without picking. False on first-load
   * (when no position is set yet) so the user MUST select before continuing.
   */
  closable?: boolean;
}

/**
 * Modal — locked from EVEN-ELO-MOCKUPS.html position picker screen.
 * Renders a 3×3 grid of the 9 seeded positions. Click a card → onPick(name).
 */
export function PositionPicker({ onPick, onClose, closable = true }: PositionPickerProps) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full overflow-hidden">
        <div className="px-8 py-6 border-b border-stone-100">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-xl bg-brand flex items-center justify-center">
              <span className="text-white text-base font-bold">E</span>
            </div>
            <div>
              <h2 className="text-xl font-semibold">Welcome to Even-ELO</h2>
              <p className="text-sm text-stone-500">Surgical Governance Committee — EHRC</p>
            </div>
          </div>
          <p className="text-sm text-stone-600 mt-3">
            Select your <span className="font-medium">position</span>. Every entry today will be
            stamped with this role for audit defensibility. Switch positions later from the chip
            in the top-right.
          </p>
        </div>
        <div className="px-8 py-6">
          <div className="grid grid-cols-3 gap-3">
            {POSITION_SEEDS.map((p) => (
              <button
                key={p.name}
                onClick={() => onPick(p.name)}
                className="text-left border border-stone-200 rounded-[10px] p-4 bg-white hover:border-brand hover:bg-brand-softer transition cursor-pointer"
              >
                <div className="font-medium text-sm">{p.name}</div>
                <div className="text-xs text-stone-500 mt-1 leading-tight">{p.description}</div>
              </button>
            ))}
          </div>
        </div>
        <div className="px-8 py-4 bg-stone-50 border-t border-stone-100 flex items-center justify-between text-xs text-stone-500">
          <span>Audit by position, not by individual person. Stable across staff turnover.</span>
          {closable && (
            <button onClick={onClose} className="text-stone-500 hover:text-stone-900">
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
