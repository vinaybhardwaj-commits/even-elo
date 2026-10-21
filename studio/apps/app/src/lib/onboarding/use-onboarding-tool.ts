"use client";

import { useCallback, useEffect, useState } from "react";
import { SourceTablePayload } from "@/lib/screens/tool-schema";
import type { ScreenToolState } from "@/lib/screens/use-screen-tool";
import type { OnboardingReadName, OnboardingReadParams, OnboardingWriteName } from "./schema";

export const ONBOARDING_API = "/studio/api/onboarding";

/** Loads ONE onboarding read tool through /studio/api/onboarding/<tool>. `params` is compared by value; null = do not load. */
export function useOnboardingTool<T extends OnboardingReadName>(tool: T, params: OnboardingReadParams<T> | null): ScreenToolState & { retry: () => void; params: OnboardingReadParams<T> | null } {
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
        const res = await fetch(`${ONBOARDING_API}/${tool}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: key, signal: controller.signal, cache: "no-store" });
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) return done({ status: "error", code: body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "tool_failed" });
        const parsed = SourceTablePayload.safeParse(body);
        // A result without its source line, or from another tool, is never shown.
        done(parsed.success && parsed.data.source.tool === tool ? { status: "ok", data: parsed.data } : { status: "error", code: "bad_payload" });
      } catch {
        done({ status: "error", code: "unreachable" });
      }
    })();
    return () => controller.abort();
  }, [tool, key, attempt, requestId]);

  const state: ScreenToolState = settled && settled.id === requestId ? settled.result : { status: "loading" };
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry, params };
}

const WRITE_ERRORS: Record<string, string> = {
  needs_second_factor: "Needs the second factor (G3), which is not available yet. Nothing was changed.",
  forbidden: "Your role cannot make this change.",
  unauthorized: "Your session is no longer valid. Sign in again.",
  rejected: "even-elo rejected this change. Check the values.",
  bad_params: "These values are not accepted.",
  audit_unavailable: "The audit record could not be written, so nothing was changed.",
  rate_limited: "Too many requests. Wait a moment, then retry.",
  upstream_denied: "even-elo refused the request for this session.",
  not_found: "That record no longer exists.",
  conflict: "even-elo refused because of the record state (stage, cooldown or case limit). Nothing was changed.",
  live_reads_off: "Live access is switched off.",
};
export const describeWriteError = (code: string) => WRITE_ERRORS[code] ?? "The change was not applied. Retry, or check the audit log.";

/** POSTs one confirmed write. Resolves to null on success or a fixed error code. */
export async function postOnboardingWrite(action: OnboardingWriteName, params: unknown): Promise<string | null> {
  try {
    const res = await fetch(`${ONBOARDING_API}/write/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params), cache: "no-store" });
    if (res.ok) return null;
    const body: unknown = await res.json().catch(() => null);
    return body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "failed";
  } catch {
    return "unreachable";
  }
}
