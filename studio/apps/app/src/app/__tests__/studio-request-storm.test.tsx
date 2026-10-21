import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { z } from "zod";
import "@testing-library/jest-dom/vitest";

// The fetch the app sees is installed BEFORE providers.tsx is imported, exactly as in the browser, so whatever
// providers.tsx wraps around window.fetch at import time sits in front of this network stub.
const net = vi.hoisted(() => {
  const state = {
    calls: [] as Array<{ url: string; method: string; rpc: string; body: string }>,
    fail: false,
  };
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

const runtimePosts = (rpc?: string) => net.calls.filter((c) => c.url.includes("/studio/api/copilotkit") && c.method === "POST" && (!rpc || c.rpc === rpc));
const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

beforeEach(() => {
  net.calls.length = 0;
  net.fail = false;
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
});
