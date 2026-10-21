"use client";

import type { ReactNode } from "react";
import { describeScreenError, type ScreenToolState } from "@/lib/screens/use-screen-tool";
import type { SourceTablePayload } from "@/lib/screens/tool-schema";

// Typed building blocks for governance screens. Facts render as React text nodes only (never HTML),
// and every block states its source: tool, query hash, row count, live/sample.

export function sourceLabel(data: SourceTablePayload): string {
  const { source, row_count, mode, synthetic } = data;
  const sample = mode === "fixture" || synthetic ? " · SAMPLE DATA (live reads are off)" : " · live, read-only";
  return `Source: ${source.tool} · query ${source.query_hash} · ${row_count} row${row_count === 1 ? "" : "s"}${sample}`;
}

export function SourceLine({ data }: { data: SourceTablePayload }) {
  return (
    <p className="scr-source" data-testid="source-line">
      {sourceLabel(data)}
    </p>
  );
}

/** Wraps one tool read: loading, error with retry, or the typed children. */
export function ToolSection({
  title,
  note,
  state,
  retry,
  children,
}: {
  title: string;
  note?: string;
  state: ScreenToolState;
  retry: () => void;
  children: (data: SourceTablePayload) => ReactNode;
}) {
  return (
    <section className="scr-card" aria-label={title}>
      <header className="scr-card-head">
        <h2>{title}</h2>
        {note && <p>{note}</p>}
      </header>
      {state.status === "loading" && (
        <p className="scr-muted" role="status">
          Loading…
        </p>
      )}
      {state.status === "error" && (
        <div className="scr-error" role="alert">
          <p>{describeScreenError(state.code)}</p>
          <button type="button" onClick={retry}>
            Retry
          </button>
        </div>
      )}
      {state.status === "ok" && children(state.data)}
    </section>
  );
}

export function StatTile({ label, value, data }: { label: string; value: number | string | null; data: SourceTablePayload }) {
  return (
    <div className="scr-tile" data-testid="stat-tile">
      <div className="scr-tile-label">{label}</div>
      <div className="scr-tile-value">{value === null ? "–" : value}</div>
      <div className="scr-source">
        {data.source.tool} · {data.source.query_hash}
        {data.mode === "fixture" || data.synthetic ? " · SAMPLE" : ""}
      </div>
    </div>
  );
}

const titleCase = (column: string) => column.replace(/_/g, " ");

export function DataTable({
  data,
  columns,
  labels,
  renderCell,
  empty = "No rows.",
}: {
  data: SourceTablePayload;
  columns?: string[];
  labels?: Record<string, string>;
  renderCell?: Partial<Record<string, (value: string | number | boolean | null, row: SourceTablePayload["rows"][number]) => ReactNode>>;
  empty?: string;
}) {
  const cols = columns ?? data.columns;
  return (
    <figure className="scr-figure">
      <div className="scr-table-scroll" tabIndex={0}>
        <table className="scr-table">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c} scope="col">
                  {labels?.[c] ?? titleCase(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, i) => (
              <tr key={i}>
                {cols.map((c) => {
                  const v = row[c] ?? null;
                  const custom = renderCell?.[c];
                  return <td key={c}>{custom ? custom(v, row) : v === null ? "–" : String(v)}</td>;
                })}
              </tr>
            ))}
            {data.rows.length === 0 && (
              <tr>
                <td className="scr-muted" colSpan={Math.max(1, cols.length)}>
                  {empty}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <figcaption>
        <SourceLine data={data} />
      </figcaption>
    </figure>
  );
}
