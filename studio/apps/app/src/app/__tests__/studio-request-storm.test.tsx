import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { z } from "zod";

vi.mock("@/components/generative-ui/charts/bar-chart", () => ({ BarChart: () => null, BarChartProps: z.object({}) }));
vi.mock("@/components/generative-ui/charts/pie-chart", () => ({ PieChart: () => null, PieChartProps: z.object({}) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/overview", useRouter: () => ({ push: () => {} }) }));

import { Providers } from "../providers";
import { OverviewScreen } from "@/components/screens/overview-screen";

// Verbatim `info` reply of this app's runtime (buildRuntimeOptions: a2ui + openGenerativeUI on).
const RUNTIME_INFO = {
  version: "1.55.2-next.1",
  agents: { default: { name: "default", description: "", className: "NoRedirectLangGraphAgent" } },
  audioFileTranscriptionEnabled: false,
  mode: "sse",
  a2uiEnabled: true,
  openGenerativeUIEnabled: true,
};
const COPILOT = "/studio/api/copilotkit";
const calls: Array<{ url: string; method: string; body: string }> = [];

beforeEach(() => {
  calls.length = 0;
  // Wide screen: the side chat panel is open, as on the live overview.
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }),
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, method: init?.method ?? "GET", body });
    if (url.includes(COPILOT)) {
      if (body.includes('"info"')) return new Response(JSON.stringify(RUNTIME_INFO), { status: 200, headers: { "Content-Type": "application/json" } });
      // agent/connect on a new thread: the runtime answers 200 with an empty stream.
      return new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    const tool = url.split("/").pop() ?? "";
    return new Response(
      JSON.stringify({ source: { tool, query_hash: "0123456789ab" }, mode: "live", synthetic: false, columns: ["metric", "value"], rows: [{ metric: "physicians_active", value: 265 }], row_count: 1 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Studio overview: copilotkit request bound", () => {
  it("mounting Providers + OverviewScreen (side panel open) posts to the copilotkit runtime at most 3 times in 2 s", async () => {
    render(
      <Providers>
        <OverviewScreen />
      </Providers>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2000));
    });
    const posts = calls.filter((c) => c.url.includes(COPILOT) && c.method === "POST");
    // info + agent/connect (provisional agent, then the thread clone once info lands).
    expect(posts.length).toBeLessThanOrEqual(3);
    expect(calls.some((c) => c.url.includes("/studio/api/screen/overview_counts"))).toBe(true);
  }, 15000);
});
