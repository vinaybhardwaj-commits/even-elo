"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { decideRunError, describeRunError, type ErrorEventLike } from "./run-error";

type Unsubscribable = { unsubscribe: () => void };
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

  useEffect(() => {
    const subscription = agent.subscribe({
      onRunInitialized: () => {
        runFinishedRef.current = false;
        setError(null);
      },
      onRunFinishedEvent: () => {
        runFinishedRef.current = true;
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

  return { error, setError, onError, clear };
}
