// Server-side POSTs to the agent (AGENT_URL, behind Tailscale Funnel). fetch keeps sockets alive between calls; a
// Vercel instance is frozen between invocations, so the socket the pool hands out first after an idle spell may
// already be closed at the other end. That request dies before any response (ECONNRESET / "other side closed")
// and never reaches the agent: it is sent again once on a fresh socket. Nothing else is retried: a refused
// connection, a redirect (redirect: "error") and a timeout are reported as they are.

const STALE_SOCKET_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CLOSED"]);

/** True when fetch failed because the connection was closed under it (a stale kept-alive socket). */
export function isStaleSocket(err: unknown): boolean {
  const code = err instanceof TypeError ? (err.cause as { code?: unknown } | undefined)?.code : undefined;
  return typeof code === "string" && STALE_SOCKET_CODES.has(code);
}

/** True when the request ran out of time (AbortSignal.timeout): the agent is slow, not down. */
export const isTimeout = (err: unknown): boolean => (err as { name?: unknown } | null)?.name === "TimeoutError";

/** fetch with its own timeout per attempt, sent once more only when the first attempt hit a stale socket. */
export async function fetchAgent(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (!isStaleSocket(err)) throw err;
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  }
}
