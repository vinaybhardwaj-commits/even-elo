"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useAgentContext, type JsonSerializable } from "@copilotkit/react-core/v2";
import type { ScreenToolState } from "@/lib/screens/use-screen-tool";
import { describeWriteError, postSurgicalWrite } from "@/lib/surgical/use-surgical-tool";
import { SECOND_FACTOR_AVAILABLE, WRITE_LABELS, type SurgicalReadName, type SurgicalWriteName } from "@/lib/surgical/schema";

export const SURGICAL_LINKS = [
  { href: "/surgical", label: "Overview" },
  { href: "/surgical/vcs", label: "Visiting consultants" },
  { href: "/surgical/cases", label: "Cases" },
  { href: "/surgical/streams", label: "Streams" },
  { href: "/surgical/weights", label: "Weights" },
  { href: "/surgical/positions", label: "Positions" },
  { href: "/surgical/audit", label: "Audit log" },
] as const;

export function SurgicalSubnav({ current }: { current: string }) {
  return (
    <nav className="scr-pager" aria-label="Surgical governance sections">
      {SURGICAL_LINKS.map((l) => (
        <Link key={l.href} href={l.href} aria-current={l.href === current ? "page" : undefined} style={l.href === current ? { fontWeight: 600 } : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}

const toJson = (v: unknown): JsonSerializable => JSON.parse(JSON.stringify(v ?? null));

export type SurgicalRead = { tool: SurgicalReadName; params: unknown; state: ScreenToolState };

/** Tells the side-panel agent which surgical screen this is: ids, filters and the reads that filled it. No row content. */
export function useSurgicalContext(screen: string, selected: Record<string, string>, filters: Record<string, unknown>, reads: SurgicalRead[]) {
  useAgentContext({
    description:
      "The Even Studio Surgical Governance screen the user is looking at: screen id, selected record ids, active filters and the surgical_* read-tool calls that filled it. Answer about this screen first. You cannot change data; changes are confirm cards on the screen.",
    value: {
      screen,
      selected,
      filters: toJson(filters),
      reads: reads.map((r) => ({
        tool: r.tool,
        params: toJson(r.params),
        status: r.state.status,
        row_count: r.state.status === "ok" ? r.state.data.row_count : null,
        query_hash: r.state.status === "ok" ? r.state.data.source.query_hash : null,
      })),
    },
  });
}

/**
 * Typed confirm card for ONE write. Shows exactly what will be sent (field, value) and what it does, then waits
 * for an explicit click. There is no autosave and no delete. Without the G3 second factor the button stays disabled.
 */
export function ConfirmCard({
  action,
  params,
  summary,
  onClose,
  onDone,
  secondFactor = SECOND_FACTOR_AVAILABLE,
}: {
  action: SurgicalWriteName;
  params: unknown;
  summary: Array<[string, ReactNode]>;
  onClose: () => void;
  onDone: () => void;
  secondFactor?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = WRITE_LABELS[action];
  return (
    <section className="scr-card" aria-label={`Confirm: ${label.title}`} data-testid="confirm-card">
      <header className="scr-card-head">
        <h2>Confirm: {label.title}</h2>
        <p>{label.effect}</p>
      </header>
      <dl className="scr-dl">
        {summary.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v === null || v === "" ? "–" : v}</dd>
          </div>
        ))}
      </dl>
      {!secondFactor && (
        <p className="scr-muted" role="note" data-testid="second-factor-note">
          Needs second factor: writers must pass the G3 second factor, which is not available yet. This change cannot be applied from Studio.
        </p>
      )}
      {error && (
        <p className="scr-error" role="alert">
          {describeWriteError(error)}
        </p>
      )}
      <div className="scr-pager">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          disabled={!secondFactor || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const err = await postSurgicalWrite(action, params);
            setBusy(false);
            if (err) setError(err);
            else onDone();
          }}
        >
          {busy ? "Applying…" : "Confirm and apply"}
        </button>
      </div>
    </section>
  );
}
