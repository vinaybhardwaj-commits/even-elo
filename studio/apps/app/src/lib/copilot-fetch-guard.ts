// Hard client guard for the CopilotKit runtime (/studio/api/copilotkit). Whatever re-issues the POST (our handlers,
// CopilotKit internals, a remounting panel), the network sees at most:
// - no agent/connect for a thread that never ran (the runtime answers those with an empty stream without asking the
//   agent, so there is nothing to restore; a fresh panel therefore makes no connect call at all);
// - per method, 1 call plus MAX_REISSUES re-issues after network failures, spaced 1 s, 2 s, 4 s, then a cool-down;
// - per method, at most WINDOW_LIMIT calls per WINDOW_MS even when every call answers 200.
// A refused call fails fast with code "client_backoff" (no request), so the chat shows its banner instead of looping.

export const RUNTIME_PATH = "/studio/api/copilotkit";
export const MAX_REISSUES = 3;
export const BACKOFF_BASE_MS = 1_000;
export const COOLDOWN_MS = 60_000;
export const WINDOW_MS = 10_000;
export const WINDOW_LIMIT: Record<string, number> = { info: 3, "agent/connect": 3, "agent/run": 6 };
const DEFAULT_LIMIT = 3;

type Streak = { failures: number; notBefore: number };
type Clock = () => number;

export class ClientBackoffError extends TypeError {
  readonly code = "client_backoff";
  constructor(method: string) {
    super(`client_backoff: ${method} refused by the client guard`);
    this.name = "ClientBackoffError";
  }
}

export function createCopilotFetchGuard(realFetch: typeof fetch, now: Clock = Date.now) {
  const ranThreads = new Set<string>();
  const streaks = new Map<string, Streak>();
  const recent = new Map<string, number[]>();

  const failed = (method: string) => {
    const s = streaks.get(method) ?? { failures: 0, notBefore: 0 };
    const failures = s.failures + 1;
    // failures 1..3 -> wait 1/2/4 s before the next try; the 4th failure ends the streak with a cool-down.
    const wait = failures > MAX_REISSUES ? COOLDOWN_MS : BACKOFF_BASE_MS * 2 ** (failures - 1);
    streaks.set(method, { failures: failures > MAX_REISSUES ? 0 : failures, notBefore: now() + wait });
  };
  const succeeded = (method: string) => streaks.delete(method);

  const admit = (method: string): boolean => {
    const t = now();
    if (t < (streaks.get(method)?.notBefore ?? 0)) return false;
    const limit = WINDOW_LIMIT[method] ?? DEFAULT_LIMIT;
    const times = (recent.get(method) ?? []).filter((x) => t - x < WINDOW_MS);
    if (times.length >= limit) {
      recent.set(method, times);
      return false;
    }
    times.push(t);
    recent.set(method, times);
    return true;
  };

  // A body that dies mid-stream (socket closed, network change) counts as a failure too.
  const watchBody = (res: Response, method: string): Response => {
    if (!res.body) return res;
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          failed(method);
          controller.error(error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };

  return async function guardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    if (method !== "POST" || !new URL(url, "http://local").pathname.startsWith(RUNTIME_PATH)) return realFetch(input, init);

    let rpc = "?";
    let threadId: string | undefined;
    if (typeof init?.body === "string") {
      try {
        const parsed = JSON.parse(init.body) as { method?: unknown; body?: { threadId?: unknown } };
        if (typeof parsed.method === "string") rpc = parsed.method;
        if (typeof parsed.body?.threadId === "string") threadId = parsed.body.threadId;
      } catch {
        // Not JSON: guard it under "?".
      }
    }

    if (rpc === "agent/connect" && (!threadId || !ranThreads.has(threadId))) {
      return new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    if (!admit(rpc)) throw new ClientBackoffError(rpc);
    if (rpc === "agent/run" && threadId) ranThreads.add(threadId);

    let res: Response;
    try {
      res = await realFetch(input, init);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) failed(rpc);
      throw error;
    }
    if (!res.ok) {
      failed(rpc);
      return res;
    }
    succeeded(rpc);
    return watchBody(res, rpc);
  };
}

const INSTALLED = Symbol.for("studio.copilotFetchGuard");

/** Wraps window.fetch once. Safe to call repeatedly (HMR, remounts). */
export function installCopilotFetchGuard(win: (Window & typeof globalThis) | undefined = typeof window === "undefined" ? undefined : window) {
  if (!win) return;
  const current = win.fetch as typeof fetch & { [INSTALLED]?: true };
  if (current[INSTALLED]) return;
  const guarded = createCopilotFetchGuard(current.bind(win)) as typeof fetch & { [INSTALLED]?: true };
  guarded[INSTALLED] = true;
  win.fetch = guarded;
}
