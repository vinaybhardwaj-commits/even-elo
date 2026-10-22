// Hard client guard for the CopilotKit runtime (/studio/api/copilotkit). Whatever re-issues the POST (our handlers,
// CopilotKit internals, a remounting panel), the network sees at most:
// - no agent/connect for a thread that never ran (the runtime answers those with an empty stream without asking the
//   agent, so there is nothing to restore; a fresh panel therefore makes no connect call at all);
// - per method, 1 call plus MAX_REISSUES re-issues after network failures, spaced 1 s, 2 s, 4 s, then a cool-down;
// - per method, at most WINDOW_LIMIT calls per WINDOW_MS even when every call answers 200.
// - per thread, at most MAX_TOOL_FOLLOW_UPS agent/run follow-ups in a row (runs whose last message is a tool result,
//   which CopilotKit issues after every frontend tool, and again when a reconnect replays a tool call whose result never
//   reached the agent). Only admitted runs count, and only a new user message resets the count. The next follow-up is
//   answered here with a short assistant message that ends the chain (no request). The server never saw that follow-up,
//   so its history still ends in an unanswered tool call: every later agent/connect replay of a stopped thread gets a
//   local result for each unanswered tool call plus the stop message appended, so a reopen does not re-execute it.
// A refused call fails fast with code "client_backoff" (no request), so the chat shows its banner instead of looping.
// Except info: an info call never fails here. A refused or failed info is answered with the last successful info
// response (waiting for one in flight if needed), or, before any succeeded, with FALLBACK_INFO naming the default agent.
// A failed info empties CopilotKit's agent registry, and the chat then throws "Agent not found" during render, which
// takes the whole page down; the agent list does not change during a page's life.
// Diagnostics: window.__studioCopilotGuard counts every runtime call per method and keeps the call stacks (50 frames)
// of the 2nd to 4th call of each method (stacks only, never bodies), so a live capture can name whatever re-issues a call.

export const RUNTIME_PATH = "/studio/api/copilotkit";
export const MAX_REISSUES = 3;
export const BACKOFF_BASE_MS = 1_000;
export const COOLDOWN_MS = 60_000;
export const WINDOW_MS = 10_000;
export const WINDOW_LIMIT: Record<string, number> = { info: 10, "agent/connect": 3, "agent/run": 6 };
const DEFAULT_LIMIT = 3;
export const MAX_TOOL_FOLLOW_UPS = 8;
export const TOOL_LOOP_STOP_MESSAGE = `I stopped this answer after ${MAX_TOOL_FOLLOW_UPS} automatic tool steps in a row because it kept repeating. Ask again to continue.`;

type Streak = { failures: number; notBefore: number };
export type GuardTrace = Record<string, { calls: number; refused: number; stacks: string[] }>;
const TRACE_STACKS = 3;
const TRACE_FRAMES = 50;
export const FALLBACK_INFO = { version: "client-fallback", agents: { default: { name: "default", description: "" } }, mode: "sse", a2uiEnabled: true, openGenerativeUIEnabled: true };
type CachedInfo = { status: number; headers: [string, string][]; body: string };
type Clock = () => number;

export class ClientBackoffError extends TypeError {
  readonly code = "client_backoff";
  constructor(method: string) {
    super(`client_backoff: ${method} refused by the client guard`);
    this.name = "ClientBackoffError";
  }
}

const sseFrames = (events: object[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

/** A complete AG-UI run, served locally: a result for each pending tool call, one assistant message, then RUN_FINISHED,
 * so no follow-up is issued. */
function stopEvents(threadId: string, runId: string, pendingToolCalls: Iterable<string> = []): object[] {
  const messageId = `tool-loop-stop-${runId}`;
  return [
    { type: "RUN_STARTED", threadId, runId },
    ...[...pendingToolCalls].map((toolCallId) => ({
      type: "TOOL_CALL_RESULT",
      messageId: `tool-loop-stop-${toolCallId}`,
      toolCallId,
      role: "tool",
      content: TOOL_LOOP_STOP_MESSAGE,
    })),
    { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId, delta: TOOL_LOOP_STOP_MESSAGE },
    { type: "TEXT_MESSAGE_END", messageId },
    { type: "RUN_FINISHED", threadId, runId },
  ];
}

function stoppedRun(threadId: string, runId: string): Response {
  return new Response(sseFrames(stopEvents(threadId, runId)), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

type ReplayMessage = { role?: string; toolCallId?: string; toolCalls?: Array<{ id?: string }> };
type ReplayEvent = { type?: string; toolCallId?: string; messages?: ReplayMessage[] };

/** Passes a connect replay through unchanged, tracking which tool calls it leaves unanswered, then appends the stop run
 * answering them. A replay that fails mid-stream gets nothing appended. */
function answerPendingToolCalls(res: Response, threadId: string, runId: string): Response {
  if (!res.body) return res;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const pending = new Set<string>();
  let buffered = "";
  const track = (frame: string) => {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      let event: ReplayEvent;
      try {
        event = JSON.parse(line.slice(5)) as ReplayEvent;
      } catch {
        continue;
      }
      if (event.type === "TOOL_CALL_START" && event.toolCallId) pending.add(event.toolCallId);
      if (event.type === "TOOL_CALL_RESULT" && event.toolCallId) pending.delete(event.toolCallId);
      if (event.type === "MESSAGES_SNAPSHOT" && Array.isArray(event.messages)) {
        pending.clear();
        for (const m of event.messages) for (const c of m.toolCalls ?? []) if (c.id) pending.add(c.id);
        for (const m of event.messages) if (m.role === "tool" && m.toolCallId) pending.delete(m.toolCallId);
      }
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        track(buffered + decoder.decode());
        controller.enqueue(encoder.encode(sseFrames(stopEvents(threadId, runId, pending))));
        controller.close();
        return;
      }
      const frames = (buffered + decoder.decode(value, { stream: true })).split("\n\n");
      buffered = frames.pop() ?? "";
      frames.forEach(track);
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

export function createCopilotFetchGuard(realFetch: typeof fetch, now: Clock = () => Date.now()) {
  const trace: GuardTrace = {};
  const ranThreads = new Set<string>();
  const followUps = new Map<string, number>();
  // Threads whose tool chain the guard ended, with the runId of the local stop run.
  const stopped = new Map<string, string>();
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
          if (!(error instanceof DOMException && error.name === "AbortError")) failed(method);
          controller.error(error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };

  const record = (method: string) => {
    const t = (trace[method] ??= { calls: 0, refused: 0, stacks: [] });
    t.calls += 1;
    if (t.calls > 1 && t.stacks.length < TRACE_STACKS) {
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = TRACE_FRAMES;
      t.stacks.push(new Error(`${method} call ${t.calls}`).stack ?? "");
      Error.stackTraceLimit = limit;
    }
    return t;
  };

  let cachedInfo: CachedInfo | undefined;
  let infoInFlight: Promise<unknown> | undefined;
  const localInfo = async (): Promise<Response> => {
    if (!cachedInfo && infoInFlight) await infoInFlight.catch(() => undefined);
    const { status, headers, body } = cachedInfo ?? { status: 200, headers: [["Content-Type", "application/json"]], body: JSON.stringify(FALLBACK_INFO) };
    return new Response(body, { status, headers });
  };
  const fetchInfo = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = (async () => {
      const res = await realFetch(input, init);
      if (!res.ok) return res;
      const body = await res.text();
      cachedInfo = { status: res.status, headers: [...res.headers.entries()], body };
      return new Response(body, { status: res.status, headers: res.headers });
    })();
    infoInFlight = request;
    let res: Response;
    try {
      res = await request;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) failed("info");
      return localInfo();
    } finally {
      if (infoInFlight === request) infoInFlight = undefined;
    }
    if (!res.ok) {
      failed("info");
      return localInfo();
    }
    succeeded("info");
    return res;
  };

  async function guardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    if (method !== "POST" || !new URL(url, "http://local").pathname.startsWith(RUNTIME_PATH)) return realFetch(input, init);

    let rpc = "?";
    let threadId: string | undefined;
    let runId = "";
    let lastRole: unknown;
    if (typeof init?.body === "string") {
      try {
        const parsed = JSON.parse(init.body) as {
          method?: unknown;
          body?: { threadId?: unknown; runId?: unknown; messages?: Array<{ role?: unknown }> };
        };
        if (typeof parsed.method === "string") rpc = parsed.method;
        if (typeof parsed.body?.threadId === "string") threadId = parsed.body.threadId;
        if (typeof parsed.body?.runId === "string") runId = parsed.body.runId;
        if (Array.isArray(parsed.body?.messages)) lastRole = parsed.body.messages.at(-1)?.role;
      } catch {
        // Not JSON: guard it under "?".
      }
    }

    const traced = record(rpc);
    if (rpc === "agent/connect" && (!threadId || !ranThreads.has(threadId))) {
      return new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    const followUp = rpc === "agent/run" && threadId ? (lastRole === "tool" ? (followUps.get(threadId) ?? 0) + 1 : 0) : 0;
    if (threadId && followUp > MAX_TOOL_FOLLOW_UPS) {
      stopped.set(threadId, runId);
      return stoppedRun(threadId, runId);
    }
    if (!admit(rpc)) {
      traced.refused += 1;
      if (rpc === "info") return localInfo();
      throw new ClientBackoffError(rpc);
    }
    if (rpc === "info") return fetchInfo(input, init);
    if (rpc === "agent/run" && threadId) {
      ranThreads.add(threadId);
      followUps.set(threadId, followUp);
      if (followUp === 0) stopped.delete(threadId);
    }

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
    const stopRunId = rpc === "agent/connect" && threadId ? stopped.get(threadId) : undefined;
    const watched = watchBody(res, rpc);
    return stopRunId !== undefined && threadId ? answerPendingToolCalls(watched, threadId, stopRunId) : watched;
  }
  return Object.assign(guardedFetch, { trace });
}

const INSTALLED = Symbol.for("studio.copilotFetchGuard");

/** Wraps window.fetch once. Safe to call repeatedly (HMR, remounts). */
export function installCopilotFetchGuard(win: (Window & typeof globalThis) | undefined = typeof window === "undefined" ? undefined : window) {
  if (!win) return;
  const current = win.fetch as typeof fetch & { [INSTALLED]?: true };
  if (current[INSTALLED]) return;
  const guarded = createCopilotFetchGuard(current.bind(win)) as ReturnType<typeof createCopilotFetchGuard> & { [INSTALLED]?: true };
  guarded[INSTALLED] = true;
  win.fetch = guarded;
  (win as unknown as { __studioCopilotGuard?: GuardTrace }).__studioCopilotGuard = guarded.trace;
}
