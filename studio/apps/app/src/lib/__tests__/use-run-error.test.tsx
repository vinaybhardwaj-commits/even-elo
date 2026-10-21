import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GENERIC_RUN_ERROR } from "../run-error";
import { useRunError, type RunErrorAgent } from "../use-run-error";

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
});
