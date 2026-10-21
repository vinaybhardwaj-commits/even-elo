"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { decideRunError, describeRunError, type ErrorEventLike } from "./run-error";

type Unsubscribable = { unsubscribe: () => void };
/** Hard client guard: at most MAX_RETRIES manual retries per failure streak, each one waiting longer (1 s, 2 s, 4 s). */
export const MAX_RETRIES = 3;
export const RETRY_BASE_MS = 1_000;
export const RETRY_EXHAUSTED_ERROR = "The answer failed several times. Wait a minute, then start a new chat.";

export type RetryState = { attempts: number; notBefore: number };
export const NO_RETRIES: RetryState = { attempts: 0, notBefore: 0 };

/** Pure decision: may a retry start at `now`? The returned state is the one to keep (unchanged when refused). */
export function decideRetry(state: RetryState, now: number): { allowed: boolean; state: RetryState } {
  if (state.attempts >= MAX_RETRIES || now < state.notBefore) return { allowed: false, state };
  const attempts = state.attempts + 1;
  return { allowed: true, state: { attempts, notBefore: now + RETRY_BASE_MS * 2 ** (attempts - 1) } };
}

export type RunErrorAgent = {
  subscribe: (subscriber: { onRunInitialized?: () => void; onRunFinishedEvent?: () => void }) => Unsubscribable;
};

/**
 * Banner state for a chat. The message is cleared when a run starts and again on any RUN_FINISHED, so a
 * banner from a failed run never outlives the next successful one. Used by the chat page and the side panel.
 */
export function useRunError(agent: RunErrorAgent) {
  const [error, setError] = useState<string | null>(null);
  // True once the current run delivered RUN_FINISHED; later errors (abort, closed stream) are noise.
  const runFinishedRef = useRef(false);
  // Retries since the last RUN_FINISHED; a finished run resets the streak.
  const retryRef = useRef<RetryState>(NO_RETRIES);

  useEffect(() => {
    const subscription = agent.subscribe({
      onRunInitialized: () => {
        runFinishedRef.current = false;
        setError(null);
      },
      onRunFinishedEvent: () => {
        runFinishedRef.current = true;
        retryRef.current = NO_RETRIES;
        setError(null);
      },
    });
    return () => subscription.unsubscribe();
  }, [agent]);

  const onError = useCallback((raw: unknown) => {
    const event = raw as ErrorEventLike;
    console.warn(describeRunError(event));
    const decision = decideRunError(event, runFinishedRef.current);
    if (decision.show) setError(decision.message);
  }, []);

  const clear = useCallback(() => {
    runFinishedRef.current = false;
    setError(null);
  }, []);

  /** Call before a retry run. False = refused (cap reached or still backing off); the banner then says so. */
  const beginRetry = useCallback((now: number = Date.now()) => {
    const decision = decideRetry(retryRef.current, now);
    retryRef.current = decision.state;
    if (!decision.allowed && decision.state.attempts >= MAX_RETRIES) setError(RETRY_EXHAUSTED_ERROR);
    return decision.allowed;
  }, []);

  return { error, setError, onError, clear, beginRetry };
}
