// Server-side POSTs to the agent (AGENT_URL, behind Tailscale Funnel). fetch keeps sockets alive between calls; a
// Vercel instance is frozen between invocations, so the socket the pool hands out first after an idle spell may
// already be closed at the other end. That request fails with a stale-socket error (ECONNRESET / "other side
// closed") and is sent once more on a fresh socket. The error can also arrive after the body was sent, so the agent
// may have run the first one: a screen read then runs twice (two audit rows for one view), and the http-tools audit
// re-send can write a duplicate studio_audit row. Both are accepted: a duplicate row overstates access, never hides
// it. Nothing else is retried: a refused connection, a redirect (redirect: "error") and a timeout are reported as
// they are, and a failed re-send is reported as AgentRetryError so no caller retries again.

const STALE_SOCKET_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CLOSED"]);

/** True when fetch failed because the connection was closed under it (a stale kept-alive socket). */
export function isStaleSocket(err: unknown): boolean {
  const code = err instanceof TypeError ? (err.cause as { code?: unknown } | undefined)?.code : undefined;
  return typeof code === "string" && STALE_SOCKET_CODES.has(code);
}

/** True when the request ran out of time (AbortSignal.timeout): the agent is slow, not down. */
export const isTimeout = (err: unknown): boolean => (err as { name?: unknown } | null)?.name === "TimeoutError";

/** The re-send after a stale socket failed too: the agent has had its two POSTs for this request. */
export class AgentRetryError extends Error {
  constructor(cause: unknown) {
    super("agent unreachable after one retry", { cause });
    this.name = "AgentRetryError";
  }
}

/** fetch with its own timeout per attempt, sent once more only when the first attempt hit a stale socket.
 *  At most two POSTs reach the agent. A timed-out re-send is still a timeout; any other failure of it is AgentRetryError. */
export async function fetchAgent(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (!isStaleSocket(err)) throw err;
  }
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw isTimeout(err) ? err : new AgentRetryError(err);
  }
}
