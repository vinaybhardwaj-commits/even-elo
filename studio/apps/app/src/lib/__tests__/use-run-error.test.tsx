import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GENERIC_RUN_ERROR } from "../run-error";
import { MAX_RETRIES, NO_RETRIES, RETRY_EXHAUSTED_ERROR, decideRetry, useRunError, type RunErrorAgent } from "../use-run-error";

function fakeAgent() {
  let sub: { onRunInitialized?: () => void; onRunFinishedEvent?: () => void } = {};
  const agent: RunErrorAgent = {
    subscribe: (s) => {
      sub = s;
      return { unsubscribe: () => {} };
    },
  };
  return { agent, start: () => sub.onRunInitialized?.(), finish: () => sub.onRunFinishedEvent?.() };
}

describe("useRunError", () => {
  it("shows the banner for a failed run and clears it when the next run starts", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { agent, start } = fakeAgent();
    const { result } = renderHook(() => useRunError(agent));
    act(() => result.current.onError({ code: "agent_run_failed", error: new Error("x") }));
    expect(result.current.error).toBe(GENERIC_RUN_ERROR);
    act(() => start());
    expect(result.current.error).toBeNull();
  });

  it("clears the banner on any RUN_FINISHED and ignores late errors after it", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { agent, finish } = fakeAgent();
    const { result } = renderHook(() => useRunError(agent));
    act(() => result.current.onError({ code: "agent_run_failed", error: new Error("x") }));
    expect(result.current.error).toBe(GENERIC_RUN_ERROR);
    act(() => finish());
    expect(result.current.error).toBeNull();
    act(() => result.current.onError({ code: "agent_run_failed", error: new Error("late") }));
    expect(result.current.error).toBeNull();
  });

  it("allows at most 3 retries per failure streak, backing off 1 s, 2 s, 4 s", () => {
    let state = NO_RETRIES;
    const at = (now: number) => {
      const d = decideRetry(state, now);
      state = d.state;
      return d.allowed;
    };
    expect(at(0)).toBe(true);
    expect(at(500)).toBe(false); // still inside the 1 s back-off
    expect(at(1_000)).toBe(true);
    expect(at(2_500)).toBe(false); // 2 s back-off from t=1 s
    expect(at(3_000)).toBe(true);
    expect(state.attempts).toBe(MAX_RETRIES);
    expect(at(60_000)).toBe(false); // capped, however long we wait
    expect(at(10_000_000)).toBe(false);
  });

  it("beginRetry refuses a 4th retry with a banner, and a finished run resets the streak", () => {
    const { agent, finish } = fakeAgent();
    const { result } = renderHook(() => useRunError(agent));
    const tries: boolean[] = [];
    for (const t of [0, 1_000, 3_000, 100_000]) act(() => void tries.push(result.current.beginRetry(t)));
    expect(tries).toEqual([true, true, true, false]);
    expect(result.current.error).toBe(RETRY_EXHAUSTED_ERROR);
    act(() => finish());
    act(() => void tries.push(result.current.beginRetry(200_000)));
    expect(tries.at(-1)).toBe(true);
  });
});
