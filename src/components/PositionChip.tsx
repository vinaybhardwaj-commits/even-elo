"use client";

import { useEffect, useState } from "react";
import { getCurrentPosition, setCurrentPosition, STORAGE_KEY } from "@/lib/position";
import { PositionPicker } from "./PositionPicker";

/**
 * Top-right chip showing the current logged-in position. Self-contained:
 * - On mount, reads localStorage. If empty, opens the picker (non-closable).
 * - Click chip → re-opens picker (closable).
 * - On pick → writes localStorage, fires a `storage` event so other tabs sync.
 */
export function PositionChip() {
  const [position, setPosition] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const saved = getCurrentPosition();
    setPosition(saved);
    setHydrated(true);
    if (!saved) setOpen(true);

    // Sync across tabs.
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) setPosition(e.newValue);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  function handlePick(name: string) {
    setCurrentPosition(name);
    setPosition(name);
    setOpen(false);
  }

  // Avoid SSR/CSR mismatch — render a placeholder until hydrated.
  if (!hydrated) {
    return (
      <span className="flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-lg border border-stone-200 text-stone-400">
        <span className="w-2 h-2 rounded-full bg-stone-300" />
        <span>Loading…</span>
      </span>
    );
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-lg border border-stone-200 hover:border-stone-300 transition bg-white"
        type="button"
      >
        <span className={`w-2 h-2 rounded-full ${position ? "bg-emerald-500" : "bg-amber-500"}`} />
        <span>
          {position ? (
            <>
              Logged in as: <span className="font-semibold">{position}</span>
            </>
          ) : (
            <>Sign in →</>
          )}
        </span>
        <svg className="w-3 h-3 text-stone-400" fill="none" viewBox="0 0 20 20">
          <path stroke="currentColor" strokeWidth="1.5" d="M5 7l5 5 5-5" />
        </svg>
      </button>
      {open && (
        <PositionPicker
          onPick={handlePick}
          onClose={() => position && setOpen(false)}
          closable={!!position}
        />
      )}
    </>
  );
}
