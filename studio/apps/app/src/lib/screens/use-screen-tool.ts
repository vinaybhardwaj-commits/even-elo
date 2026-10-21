"use client";

import { useCallback, useEffect, useState } from "react";
import { SourceTablePayload, type GovernanceToolName, type ScreenToolParams } from "./tool-schema";

export type ScreenToolState =
  | { status: "loading" }
  | { status: "ok"; data: SourceTablePayload }
  | { status: "error"; code: string };

export const SCREEN_API = "/studio/api/screen";

// Back-nav and re-mounts reuse a recent successful read instead of spending the agent's screen budget again.
export const SCREEN_CACHE_TTL_MS = 30_000;
const screenCache = new Map<string, { at: number; data: SourceTablePayload }>();
export const clearScreenCache = () => screenCache.clear();
const cachedRead = (cacheKey: string, now = Date.now()) => {
  const hit = screenCache.get(cacheKey);
  if (!hit) return null;
  if (now - hit.at >= SCREEN_CACHE_TTL_MS) {
    screenCache.delete(cacheKey);
    return null;
  }
  return hit.data;
};

const ERROR_TEXT: Record<string, string> = {
  rate_limited: "Too many reads in the last minute. Wait a moment, then retry.",
  agent_unreachable: "The agent is unreachable. Retry in a moment.",
  agent_not_configured: "The agent is not configured.",
  unauthorized: "Your session is no longer valid. Sign in again.",
  bad_params: "This view asked for something the read tool does not accept.",
};
export const describeScreenError = (code: string) => ERROR_TEXT[code] ?? "This read failed. Retry, or ask the agent in the panel.";

/** Loads ONE governance read tool through /studio/api/screen/<tool>. `params` is compared by value. */
export function useScreenTool<T extends GovernanceToolName>(
  tool: T,
  params: ScreenToolParams<T> | null,
): ScreenToolState & { retry: () => void; params: ScreenToolParams<T> | null } {
  const key = params === null ? null : JSON.stringify(params);
  const [attempt, setAttempt] = useState(0);
  // The result is tagged with the request that produced it; a different request means "loading".
  const requestId = `${tool}|${key}|${attempt}`;
  const [settled, setSettled] = useState<{ id: string; result: ScreenToolState } | null>(null);

  useEffect(() => {
    if (key === null) return;
    const cacheKey = `${tool}|${key}`;
    const hit = attempt === 0 ? cachedRead(cacheKey) : null;
    if (hit) {
      setSettled({ id: requestId, result: { status: "ok", data: hit } });
      return;
    }
    const controller = new AbortController();
    const done = (result: ScreenToolState) => {
      if (!controller.signal.aborted) setSettled({ id: requestId, result });
    };
    (async () => {
      try {
        const res = await fetch(`${SCREEN_API}/${tool}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: key,
          signal: controller.signal,
          cache: "no-store",
        });
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          const code = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "tool_failed";
          return done({ status: "error", code });
        }
        const parsed = SourceTablePayload.safeParse(body);
        if (parsed.success) screenCache.set(cacheKey, { at: Date.now(), data: parsed.data });
        done(parsed.success ? { status: "ok", data: parsed.data } : { status: "error", code: "bad_payload" });
      } catch {
        done({ status: "error", code: "agent_unreachable" });
      }
    })();
    return () => controller.abort();
  }, [tool, key, attempt, requestId]);

  const state: ScreenToolState = settled && settled.id === requestId ? settled.result : { status: "loading" };
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry, params };
}
