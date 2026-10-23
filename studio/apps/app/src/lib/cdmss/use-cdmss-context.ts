"use client";

import { useAgentContext, type JsonSerializable } from "@copilotkit/react-core/v2";
import type { ViewId, ViewParams } from "./contract";

/** Tells the side-panel agent which CDMSS view is open and with which filters. No row content: the agent re-reads
 * through its own audited tools. */
export function useCdmssContext(view: ViewId, filters: ViewParams | null, status: string, queryHash?: string | null) {
  useAgentContext({
    description: "The CDMSS module view the user is looking at right now: view id, active filters (family, site, metric, list, window) and load status. Answer about this view first, using the cdmss_* metric tools.",
    value: JSON.parse(JSON.stringify({ screen: `cdmss/${view}`, view, filters, status, query_hash: queryHash ?? null })) as JsonSerializable,
  });
}
