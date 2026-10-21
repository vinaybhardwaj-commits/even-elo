"use client";

import { useCallback, useEffect, useState } from "react";
import { SourceTablePayload, type HttpToolName, type HttpToolParams } from "./tool-schema";
import { SCREEN_API, type ScreenToolState } from "./use-screen-tool";

/**
 * Loads ONE HTTP read tool (eiris_incidents, eiris_incident_detail) through /studio/api/screen/<tool>.
 * `params` is compared by value; null = do not load. No client cache: these reads are audited each time.
 */
export function useHttpTool<T extends HttpToolName>(tool: T, params: HttpToolParams<T> | null): ScreenToolState & { retry: () => void } {
  const key = params === null ? null : JSON.stringify(params);
  const [attempt, setAttempt] = useState(0);
  const requestId = `${tool}|${key}|${attempt}`;
  const [settled, setSettled] = useState<{ id: string; result: ScreenToolState } | null>(null);

  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    const done = (result: ScreenToolState) => {
      if (!controller.signal.aborted) setSettled({ id: requestId, result });
    };
    (async () => {
      try {
        const res = await fetch(`${SCREEN_API}/${tool}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: key, signal: controller.signal, cache: "no-store" });
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          const code = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "tool_failed";
          return done({ status: "error", code });
        }
        const parsed = SourceTablePayload.safeParse(body);
        done(parsed.success ? { status: "ok", data: parsed.data } : { status: "error", code: "bad_payload" });
      } catch {
        done({ status: "error", code: "agent_unreachable" });
      }
    })();
    return () => controller.abort();
  }, [tool, key, requestId]);

  const state: ScreenToolState = key === null ? { status: "loading" } : settled && settled.id === requestId ? settled.result : { status: "loading" };
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}
