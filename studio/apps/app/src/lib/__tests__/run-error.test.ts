import { describe, expect, it } from "vitest";
import {
  DATA_UNAVAILABLE_ERROR,
  GENERIC_RUN_ERROR,
  decideRunError,
  describeRunError,
} from "../run-error";

const coded = (code: string, context = {}) => ({
  error: Object.assign(new Error("body that must not be logged"), { code }),
  code: "agent_run_error_event",
  context,
});

describe("decideRunError", () => {
  it("ignores abort codes and AbortError", () => {
    expect(decideRunError(coded("abort"), false)).toEqual({ show: false, reason: "abort" });
    expect(decideRunError({ error: Object.assign(new Error("x"), { name: "AbortError" }) }, false)).toEqual({
      show: false,
      reason: "abort",
    });
    expect(decideRunError({ error: new Error("x"), context: { runtimeErrorCode: "abort" } }, false).show).toBe(false);
  });

  it("ignores any error after RUN_FINISHED", () => {
    expect(decideRunError({ error: new Error("stream broke"), code: "agent_run_failed" }, true)).toEqual({
      show: false,
      reason: "after-finish",
    });
  });

  it("shows the generic banner for genuine failures before RUN_FINISHED", () => {
    expect(decideRunError({ error: new Error("boom"), code: "agent_run_failed" }, false)).toEqual({
      show: true,
      message: GENERIC_RUN_ERROR,
    });
    expect(decideRunError(coded("agent_error"), false)).toEqual({ show: true, message: GENERIC_RUN_ERROR });
  });

  it("shows the data copy for data_unavailable", () => {
    expect(decideRunError(coded("data_unavailable"), false)).toEqual({ show: true, message: DATA_UNAVAILABLE_ERROR });
    expect(decideRunError({ error: new Error("x"), context: { runtimeErrorCode: "data_unavailable" } }, false)).toEqual({
      show: true,
      message: DATA_UNAVAILABLE_ERROR,
    });
  });
});

describe("describeRunError", () => {
  it("logs codes and source only", () => {
    const line = describeRunError(coded("data_unavailable", { source: "onRunErrorEvent", event: { message: "secret" } }));
    expect(line).toContain("code=agent_run_error_event");
    expect(line).toContain("agent=data_unavailable");
    expect(line).toContain("source=onRunErrorEvent");
    expect(line).not.toContain("secret");
    expect(line).not.toContain("must not be logged");
  });
});
