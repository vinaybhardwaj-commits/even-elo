import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lazy, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { z } from "zod";
import "@testing-library/jest-dom/vitest";

// The fetch the app sees is installed BEFORE providers.tsx is imported, exactly as in the browser, so whatever
// providers.tsx wraps around window.fetch at import time sits in front of this network stub.
const net = vi.hoisted(() => {
  const state = {
    calls: [] as Array<{ url: string; method: string; rpc: string; body: string }>,
    fail: false,
    // "loop": an agent that answers every run with text plus a generateSandboxedUi call, ignoring "UI generated".
    loop: false,
    history: new Map<string, object[]>(),
  };
  const sse = (events: object[]) =>
    new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : "";
    const rpc = (body.match(/"method":"([^"]+)"/) ?? [])[1] ?? "";
    state.calls.push({ url, method: init?.method ?? "GET", rpc, body });
    if (url.includes("/studio/api/copilotkit")) {
      if (rpc === "info") {
        return new Response(
          JSON.stringify({
            version: "1.55.2-next.1",
            agents: { default: { name: "default", description: "", className: "NoRedirectLangGraphAgent" } },
            audioFileTranscriptionEnabled: false,
            mode: "sse",
            a2uiEnabled: true,
            openGenerativeUIEnabled: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Live capture: the browser reports "TypeError: network error" for the runtime POSTs.
      if (state.fail) throw new TypeError("network error");
      if (state.loop) {
        const { body: input = {} } = JSON.parse(body) as { body?: { threadId?: string; runId?: string; messages?: unknown[] } };
        const threadId = input.threadId ?? "";
        const runId = input.runId ?? "run";
        // Like the runtime, connect replays every recorded run of the thread. The server only has what reached it, so
        // the last tool call's result (sent with the follow-up that never went out) is missing.
        if (rpc === "agent/connect") return sse(state.history.get(threadId) ?? []);
        const n = state.calls.length;
        const messageId = `a-${n}`;
        const toolCallId = `call-${n}`;
        const args = JSON.stringify({ initialHeight: 200, placeholderMessages: ["Drawing bar chart..."], css: "", html: "<div>chart</div>" });
        const assistant = { id: messageId, role: "assistant", content: "42 incidents.", toolCalls: [{ id: toolCallId, type: "function", function: { name: "generateSandboxedUi", arguments: args } }] };
        const events = [
          { type: "RUN_STARTED", threadId, runId },
          { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
          { type: "TEXT_MESSAGE_CONTENT", messageId, delta: "42 incidents." },
          { type: "TEXT_MESSAGE_END", messageId },
          { type: "TOOL_CALL_START", toolCallId, toolCallName: "generateSandboxedUi", parentMessageId: messageId },
          { type: "TOOL_CALL_ARGS", toolCallId, delta: args },
          { type: "TOOL_CALL_END", toolCallId },
          { type: "MESSAGES_SNAPSHOT", messages: [...(input.messages ?? []), assistant] },
          { type: "RUN_FINISHED", threadId, runId },
        ];
        state.history.set(threadId, [...(state.history.get(threadId) ?? []), ...events]);
        return sse(events);
      }
      return new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    const tool = url.split("/").pop() ?? "";
    return new Response(
      JSON.stringify({ source: { tool, query_hash: "0123456789ab" }, mode: "live", synthetic: false, columns: ["metric", "value"], rows: [{ metric: "physicians_active", value: 265 }], row_count: 1 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return state;
});

vi.mock("@/components/generative-ui/charts/bar-chart", () => ({ BarChart: () => null, BarChartProps: z.object({}) }));
vi.mock("@/components/generative-ui/charts/pie-chart", () => ({ PieChart: () => null, PieChartProps: z.object({}) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/overview", useRouter: () => ({ push: () => {} }) }));

import { Providers } from "../providers";
import { OverviewScreen } from "@/components/screens/overview-screen";
import { RmoInboxScreen } from "@/components/screens/rmo-inbox-screen";
import { FeedbackScreen } from "@/components/screens/feedback-screen";
import { AdminUsersScreen } from "@/components/screens/admin-users-screen";
import { AdminResignationsScreen } from "@/components/screens/admin-resignations-screen";

const runtimePosts = (rpc?: string) => net.calls.filter((c) => c.url.includes("/studio/api/copilotkit") && c.method === "POST" && (!rpc || c.rpc === rpc));
const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

beforeEach(() => {
  net.calls.length = 0;
  net.fail = false;
  net.loop = false;
  // Wide screen: the side chat panel is open, as on the live overview.
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }),
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Studio overview: copilotkit request storm", () => {
  it("a remounting side panel (20 open/close cycles) never storms the runtime: <= 3 POSTs in 2 s", async () => {
    render(
      <Providers>
        <OverviewScreen />
      </Providers>,
    );
    await wait(300);
    for (let i = 0; i < 20; i++) {
      fireEvent.click(screen.getByRole("button", { name: /hide assistant|ask the assistant/i }));
      await wait(10);
    }
    await wait(1500);
    // A fresh panel thread has never run, so there is nothing to connect to: only `info` may reach the network.
    expect(runtimePosts().length).toBeLessThanOrEqual(3);
    expect(net.calls.some((c) => c.url.includes("/studio/api/screen/overview_counts"))).toBe(true);
  }, 15000);

  it("runs that fail with a network error are re-issued at most 3 times, with back-off, and the panel shows the banner", async () => {
    render(
      <Providers>
        <OverviewScreen />
      </Providers>,
    );
    await wait(300);
    net.fail = true;
    const input = () => screen.getByPlaceholderText("Ask about anything on this screen…");
    for (let i = 0; i < 10; i++) {
      fireEvent.change(input(), { target: { value: `question ${i}` } });
      fireEvent.keyDown(input(), { key: "Enter", code: "Enter" });
      await wait(100);
    }
    await wait(1000);
    // 10 run attempts within ~2 s: the first goes out, then the 1 s back-off refuses the rest without a request.
    expect(runtimePosts("agent/run").length).toBeGreaterThanOrEqual(1);
    expect(runtimePosts("agent/run").length).toBeLessThanOrEqual(1 + 3);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  }, 15000);

  it("an agent that re-calls a frontend tool on every follow-up stops after 8 follow-ups with a message, and reopening the panel never restarts it", async () => {
    // Live CHAT loop: each "UI generated" result starts a follow-up run; each reconnect replays the tool call whose result
    // never reached the agent and starts the chain again. Date.now jumps past the guard's rate windows between reopens
    // (and, first, past the cool-down the network-failure test above leaves on the shared guard).
    const realNow = Date.now.bind(Date);
    let offset = 120_000;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    render(
      <Providers>
        <OverviewScreen />
      </Providers>,
    );
    await wait(300);
    net.loop = true;
    const input = screen.getByPlaceholderText("Ask about anything on this screen…");
    fireEvent.change(input, { target: { value: "How many e-IRIS incidents in the last 30 days, top categories?" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await wait(1500);
    // Every agent/run attempt, including those the guard answers locally.
    const guardTrace = (window as unknown as { __studioCopilotGuard: Record<string, { calls: number }> }).__studioCopilotGuard;
    const attempts: number[] = [];
    for (let i = 0; i < 6; i++) {
      offset += 11_000;
      fireEvent.click(screen.getByRole("button", { name: /hide assistant/i }));
      await wait(20);
      fireEvent.click(screen.getByRole("button", { name: /ask the assistant/i }));
      await wait(1000);
      attempts.push(guardTrace["agent/run"].calls);
    }
    // 1 question + at most 8 follow-ups ever reach the network; the 9th is answered locally with the stop message.
    expect(runtimePosts("agent/run").length).toBeLessThanOrEqual(1 + 8);
    expect(screen.getByText(/stopped this answer after 8 automatic tool steps/i)).toBeInTheDocument();
    // Once stopped, a reopen replays the thread with the dangling tool call answered locally: nothing re-executes it.
    expect(attempts.at(-1)).toBe(attempts[1]);
  }, 30000);

  // Live (bef701b): rmo-inbox, feedback, admin/users and admin/resignations each showed 10 runtime POSTs on load.
  const SCREENS = [
    ["overview", OverviewScreen],
    ["rmo-inbox", RmoInboxScreen],
    ["feedback", FeedbackScreen],
    ["admin/users", AdminUsersScreen],
    ["admin/resignations", AdminResignationsScreen],
  ] as const;
  it.each(SCREENS.map(([name, Screen], i) => ({ name, Screen, i })))("$name mounts with exactly 1 runtime info and nothing else", async ({ Screen, i }) => {
    // A fresh rate window per screen, so a refused info cannot hide a repeat.
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 300_000 + i * 11_000);
    render(
      <Providers>
        <Screen />
      </Providers>,
    );
    await wait(1500);
    expect(runtimePosts().map((c) => c.rpc)).toEqual(["info"]);
  });

  it("overview, panel closed, whose client chunks arrive one by one fetches runtime info once", async () => {
    // Live 1cc01fe: ~140 info calls in one burst on overview. Root cause (prod build, slow chunks): while a chunk below
    // the providers suspends the first render, React re-renders the uncommitted root on every retry; each attempt
    // builds a new CopilotKit core in a fresh ref, and each core fetches info (870 renders, 1 commit, 870 infos).
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 400_000);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }),
    });
    const chunk = (ms: number) =>
      lazy(() => new Promise<{ default: (p: { children: ReactNode }) => ReactNode }>((r) => setTimeout(() => r({ default: ({ children }) => children }), ms)));
    const [C1, C2, C3, C4, C5] = [30, 30, 30, 30, 30].map(chunk);
    const trace = (window as unknown as { __studioCopilotGuard: Record<string, { calls: number }> }).__studioCopilotGuard;
    const infoCallsBefore = trace.info?.calls ?? 0;
    render(
      <Providers>
        <C1>
          <C2>
            <C3>
              <C4>
                <C5>
                  <OverviewScreen />
                </C5>
              </C4>
            </C3>
          </C2>
        </C1>
      </Providers>,
    );
    // Each chunk resolves inside its own act() so React retries the render after every one.
    for (let i = 0; i < 10; i++) await wait(100);
    expect(screen.getByRole("heading", { name: "Programme overview" })).toBeInTheDocument();
    expect(runtimePosts("info")).toHaveLength(1);
    expect(trace.info.calls - infoCallsBefore).toBe(1);
  });

  it("a refused runtime info never leaves the chat without its agent: no 'Agent not found', the question runs", async () => {
    // Live: refused infos left CopilotKit with no agents ("Agent default not found" x5), and the first question threw
    // "Agent not found" through React render, taking the page down.
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 500_000);
    // Fill the info window: the info this page makes next is refused by the guard.
    for (let i = 0; i < 10; i++) await window.fetch("/studio/api/copilotkit", { method: "POST", body: JSON.stringify({ method: "info" }) });
    net.calls.length = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(
      <Providers>
        <OverviewScreen />
      </Providers>,
    );
    await wait(300);
    expect(runtimePosts("info")).toHaveLength(0);
    const input = screen.getByPlaceholderText("Ask about anything on this screen…");
    fireEvent.change(input, { target: { value: "How many open patient feedback records?" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await wait(500);
    expect(runtimePosts("agent/run")).toHaveLength(1);
    expect(screen.getByText("How many open patient feedback records?")).toBeInTheDocument();
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/Agent default not found/);
  });
});
