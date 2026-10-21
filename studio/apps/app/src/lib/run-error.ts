export const GENERIC_RUN_ERROR = "Something interrupted the answer. Try again or send another message.";
export const DATA_UNAVAILABLE_ERROR = "Live data is unavailable right now. Try again in a minute.";
export const CLIENT_BACKOFF_ERROR = "The assistant connection keeps failing. Waiting before trying again; try again in a minute.";

export type ErrorEventLike = {
  error?: unknown;
  code?: unknown;
  context?: Record<string, unknown> | null;
};

export type RunErrorDecision =
  | { show: false; reason: "abort" | "after-finish" }
  | { show: true; message: string };

function agentCode(event: ErrorEventLike): string | undefined {
  const fromError = (event.error as { code?: unknown } | null | undefined)?.code;
  const fromContext = event.context?.runtimeErrorCode;
  for (const value of [fromError, fromContext]) {
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/** Decide whether a CopilotKit error should surface as the banner. Reads codes only, never message text. */
export function decideRunError(event: ErrorEventLike, runFinished: boolean): RunErrorDecision {
  const code = agentCode(event);
  const name = (event.error as { name?: unknown } | null | undefined)?.name;
  if (code === "abort" || name === "AbortError") return { show: false, reason: "abort" };
  if (runFinished) return { show: false, reason: "after-finish" };
  if (code === "client_backoff") return { show: true, message: CLIENT_BACKOFF_ERROR };
  return { show: true, message: code === "data_unavailable" ? DATA_UNAVAILABLE_ERROR : GENERIC_RUN_ERROR };
}

/** One short log line: error source and codes only (no message bodies, no user text). */
export function describeRunError(event: ErrorEventLike): string {
  const source = event.context?.source;
  return `[studio] chat error code=${String(event.code ?? "?")} agent=${agentCode(event) ?? "-"} source=${typeof source === "string" ? source : "-"}`;
}
