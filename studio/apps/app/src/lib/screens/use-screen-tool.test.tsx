import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { SCREEN_CACHE_TTL_MS, clearScreenCache, describeScreenError, useScreenTool } from "./use-screen-tool";

const ok = () =>
  new Response(
    JSON.stringify({
      source: { tool: "overview_counts", query_hash: "0123456789ab" },
      mode: "live",
      synthetic: false,
      columns: ["metric", "value"],
      rows: [{ metric: "physicians_active", value: 3 }],
      row_count: 1,
    }),
    { status: 200 },
  );

describe("useScreenTool cache", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    clearScreenCache();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("serves a remount inside 30 s from the cache, with no second fetch", async () => {
    const first = renderHook(() => useScreenTool("overview_counts", {}));
    await waitFor(() => expect(first.result.current.status).toBe("ok"));
    first.unmount();
    const second = renderHook(() => useScreenTool("overview_counts", {}));
    await waitFor(() => expect(second.result.current.status).toBe("ok"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keys on tool and params, so different params fetch again", async () => {
    const a = renderHook(() => useScreenTool("incident_summary", { window_days: 7 }));
    await waitFor(() => expect(a.result.current.status).toBe("ok"));
    const b = renderHook(() => useScreenTool("incident_summary", { window_days: 30 }));
    await waitFor(() => expect(b.result.current.status).toBe("ok"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refetches once the entry is 30 s old, and never caches an error", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    const first = renderHook(() => useScreenTool("overview_counts", {}));
    await waitFor(() => expect(first.result.current.status).toBe("ok"));
    first.unmount();
    now.mockReturnValue(1_000_000 + SCREEN_CACHE_TTL_MS);
    const second = renderHook(() => useScreenTool("overview_counts", {}));
    await waitFor(() => expect(second.result.current.status).toBe("ok"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    second.unmount();
    now.mockRestore();

    clearScreenCache();
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: "rate_limited" }), { status: 429 }));
    fetchMock.mockImplementation(async () => ok());
    const failing = renderHook(() => useScreenTool("overview_counts", {}));
    await waitFor(() => expect(failing.result.current.status).toBe("error"));
    failing.unmount();
    const retried = renderHook(() => useScreenTool("overview_counts", {}));
    await waitFor(() => expect(retried.result.current.status).toBe("ok"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("only a browser-level fetch failure is retried, once; a route error never is (at most 2 agent POSTs per view)", async () => {
    // Live: first load of Physicians / Physician 360 showed "The agent is unreachable"; a manual Retry fixed it.
    const err = (code: string, status = 502) => new Response(JSON.stringify({ ok: false, error: code }), { status });
    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockImplementation(async () => ok());
    const healed = renderHook(() => useScreenTool("overview_counts", {}));
    await waitFor(() => expect(healed.result.current.status).toBe("ok"), { timeout: 3000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    healed.unmount();

    clearScreenCache();
    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const down = renderHook(() => useScreenTool("overview_counts", {}));
    await waitFor(() => expect(down.result.current).toMatchObject({ status: "error", code: "agent_unreachable" }), { timeout: 3000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    down.unmount();

    // The route already re-sent a stale-socket POST (or the agent is down, slow or limiting): shown at once.
    for (const [code, status] of [["agent_unreachable_after_retry", 502], ["agent_unreachable", 502], ["agent_timeout", 504], ["rate_limited", 429]] as const) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(err(code, status)).mockImplementation(async () => ok());
      const shown = renderHook(() => useScreenTool("overview_counts", {}));
      await waitFor(() => expect(shown.result.current).toMatchObject({ status: "error", code }));
      await new Promise((r) => setTimeout(r, 1000)); // past TRANSIENT_RETRY_MS: still no second request
      expect(fetchMock, code).toHaveBeenCalledTimes(1);
      shown.unmount();
    }
    expect(describeScreenError("agent_timeout")).toBe("The agent took too long to answer. Retry in a moment.");
    expect(describeScreenError("agent_unreachable_after_retry")).toBe("The agent is unreachable. Retry in a moment.");
  }, 10_000);
});
