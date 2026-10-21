"use client";

// Typed result of the governance read tools (apps/agent/src/studio_tools.py). The schema lives in
// lib/screens/tool-schema.ts (shared with the screen route). A payload without `source` is REFUSED.
import { GOVERNANCE_TOOL_NAMES, SourceTablePayload } from "@/lib/screens/tool-schema";
export { GOVERNANCE_TOOL_NAMES, SourceTablePayload };

export function parseSourceTable(raw: unknown): { ok: true; value: SourceTablePayload } | { ok: false; reason: string } {
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "not valid JSON" };
    }
  }
  const parsed = SourceTablePayload.safeParse(data);
  if (!parsed.success) {
    const missingSource = !(data && typeof data === "object" && "source" in data);
    return { ok: false, reason: missingSource ? "missing source" : "unexpected shape" };
  }
  return { ok: true, value: parsed.data };
}

function label(column: string): string {
  return column.replace(/_/g, " ");
}

// Cells are rendered as React text nodes only: nothing from a tool result is ever interpreted as HTML.
export function SourceTable({ result }: { result: unknown }) {
  const parsed = parseSourceTable(result);
  if (!parsed.ok) {
    return (
      <div role="alert" className="my-2 text-xs text-red-600">
        Governance result not shown: {parsed.reason}.
      </div>
    );
  }
  const { source, mode, synthetic, columns, rows, row_count } = parsed.value;
  return (
    <figure className="my-2 text-xs" data-testid="source-table">
      <div className="overflow-x-auto rounded border border-gray-200 dark:border-zinc-700">
        <table className="min-w-full text-left">
          <thead className="bg-gray-50 dark:bg-zinc-800">
            <tr>
              {columns.map((c) => (
                <th key={c} scope="col" className="px-2 py-1 font-medium capitalize">
                  {label(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t border-gray-100 dark:border-zinc-800">
                {columns.map((c) => (
                  <td key={c} className="px-2 py-1">
                    {row[c] === null || row[c] === undefined ? "–" : String(row[c])}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="px-2 py-1 text-gray-500" colSpan={Math.max(1, columns.length)}>
                  No rows.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <figcaption className="mt-1 text-gray-500">
        Source: {source.tool} · query {source.query_hash} · {row_count} row{row_count === 1 ? "" : "s"}
        {mode === "fixture" || synthetic ? " · SAMPLE DATA (live reads are off)" : " · live, read-only"}
      </figcaption>
    </figure>
  );
}
