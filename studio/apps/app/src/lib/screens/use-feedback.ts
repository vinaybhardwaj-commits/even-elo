"use client";

import { useCallback, useEffect, useState } from "react";
import { FeedbackPayload, type FeedbackListParams } from "./feedback-schema";

export const FEEDBACK_API = "/studio/api/feedback";

export type FeedbackState = { status: "loading" } | { status: "ok"; data: FeedbackPayload } | { status: "error"; code: string };

const errCode = (body: unknown) => (body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "tool_failed");

/** Loads patient feedback through /studio/api/feedback/list. `params` is compared by value. */
export function useFeedback(params: FeedbackListParams): FeedbackState & { retry: () => void } {
  const key = JSON.stringify(params);
  const [attempt, setAttempt] = useState(0);
  const id = `${key}|${attempt}`;
  const [settled, setSettled] = useState<{ id: string; result: FeedbackState } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const done = (result: FeedbackState) => {
      if (!controller.signal.aborted) setSettled({ id, result });
    };
    (async () => {
      try {
        const res = await fetch(`${FEEDBACK_API}/list`, { method: "POST", headers: { "Content-Type": "application/json" }, body: key, signal: controller.signal, cache: "no-store" });
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) return done({ status: "error", code: errCode(body) });
        const parsed = FeedbackPayload.safeParse(body);
        done(parsed.success ? { status: "ok", data: parsed.data } : { status: "error", code: "bad_payload" });
      } catch {
        done({ status: "error", code: "agent_unreachable" });
      }
    })();
    return () => controller.abort();
  }, [key, id]);

  const state: FeedbackState = settled && settled.id === id ? settled.result : { status: "loading" };
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}

/** One confirmed retraction. Resolves to an error code, or null on success. */
export async function postFeedbackRetract(body: { feedback_id: string; retraction_reason: string }): Promise<string | null> {
  try {
    const res = await fetch(`${FEEDBACK_API}/retract`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
    if (res.ok) return null;
    return errCode(await res.json().catch(() => null));
  } catch {
    return "upstream_unreachable";
  }
}
