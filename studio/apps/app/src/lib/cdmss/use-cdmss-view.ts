"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { VIEW_SCHEMAS, paramsFor, type ViewId, type ViewParams, type ViewPayload } from "./contract";

export const CDMSS_API = "/studio/api/cdmss";
export const CDMSS_CACHE_TTL_MS = 30_000;
export const CDMSS_RETRY_MS = 800;

export type CdmssState<V extends ViewId> = { status: "loading" } | { status: "ok"; data: ViewPayload<V> } | { status: "error"; code: string };

const cache = new Map<string, { at: number; data: unknown }>();
export const clearCdmssCache = () => cache.clear();

export const CDMSS_ERROR_TEXT: Record<string, string> = {
  rate_limited: "Too many reads in the last minute. Wait a moment, then retry.",
  agent_unreachable: "The agent is unreachable. Retry in a moment.",
  agent_timeout: "The agent took too long to answer. Retry in a moment.",
  forbidden: "Your role cannot open this module.",
  unauthorized: "Your session is no longer valid. Sign in again.",
  bad_params: "This view asked for something the read tool does not accept.",
  bad_payload: "The agent answered in a shape this view does not understand.",
};
export const describeCdmssError = (code: string) => CDMSS_ERROR_TEXT[code] ?? "This read failed. Retry, or ask the assistant.";

/**
 * Loads ONE view payload through /studio/api/cdmss/<view>. One POST per (view, params) per mount: params compare by
 * value, successful reads are reused for 30 s, an abort cancels the request, and only a fetch that never got an answer
 * is retried (once). `null` params = idle (no request). A route error is never retried. No polling, no interval, no refetch on focus.
 */
export function useCdmssView<V extends ViewId>(view: V, requested: ViewParams | null): CdmssState<V> & { retry: () => void } {
  // Only keys the tool accepts ever leave the hook: the agent refuses any other.
  const params = requested === null ? null : paramsFor(view, requested);
  const key = JSON.stringify(params);
  const [attempt, setAttempt] = useState(0);
  const id = `${view}|${key}|${attempt}`;
  const [settled, setSettled] = useState<{ id: string; result: CdmssState<V> } | null>(null);

  useEffect(() => {
    if (params === null) return; // idle: the view waits for a parameter it cannot guess (e.g. V4 needs a site)
    const ck = `${view}|${key}`;
    const hit = attempt === 0 ? cache.get(ck) : undefined;
    if (hit && Date.now() - hit.at < CDMSS_CACHE_TTL_MS) {
      setSettled({ id, result: { status: "ok", data: hit.data as ViewPayload<V> } });
      return;
    }
    const controller = new AbortController();
    let thrown = false;
    const once = async (): Promise<CdmssState<V>> => {
      thrown = false;
      try {
        const res = await fetch(`${CDMSS_API}/${view}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: key, signal: controller.signal, cache: "no-store" });
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) return { status: "error", code: body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "tool_failed" };
        const parsed = VIEW_SCHEMAS[view].safeParse(body);
        if (!parsed.success) return { status: "error", code: "bad_payload" };
        cache.set(ck, { at: Date.now(), data: parsed.data });
        return { status: "ok", data: parsed.data as ViewPayload<V> };
      } catch {
        thrown = true;
        return { status: "error", code: "agent_unreachable" };
      }
    };
    (async () => {
      let result = await once();
      if (thrown && !controller.signal.aborted) {
        await new Promise((r) => setTimeout(r, CDMSS_RETRY_MS));
        if (!controller.signal.aborted) result = await once();
      }
      if (!controller.signal.aborted) setSettled({ id, result });
    })();
    return () => controller.abort();
  }, [view, key, attempt, id, params === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const state: CdmssState<V> = settled && settled.id === id ? settled.result : { status: "loading" };
  // A retry never starts a second request while one is in flight (a double click, or a stale button, must not stack agent runs).
  const loading = state.status === "loading";
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const retry = useCallback(() => {
    if (!loadingRef.current) setAttempt((n) => n + 1);
  }, []);
  return { ...state, retry };
}
