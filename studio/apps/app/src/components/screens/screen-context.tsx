"use client";

import { useAgentContext, type JsonSerializable } from "@copilotkit/react-core/v2";
import type { ScreenToolState } from "@/lib/screens/use-screen-tool";
import type { AnyScreenToolName } from "@/lib/screens/tool-schema";

const toJson = (v: unknown): JsonSerializable => JSON.parse(JSON.stringify(v ?? null));

export type LoadedRead = { tool: AnyScreenToolName; params: unknown; state: ScreenToolState };

/**
 * Tells the side-panel agent what the user is looking at: the screen id, the selected record ids, the active
 * filters and the exact tool calls that filled the screen (tool, params, row count, query hash). It carries no
 * row content: the agent re-reads through the same audited tools when it needs rows.
 */
export function useScreenContext(screen: string, selected: Record<string, string>, filters: Record<string, unknown>, reads: LoadedRead[]) {
  useAgentContext({
    description:
      "The Even Studio governance screen the user is looking at right now: screen id, selected record ids, active filters, and the read-tool calls that filled it. Answer about this screen first.",
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
        mode: r.state.status === "ok" ? r.state.data.mode : null,
      })),
    },
  });
}
