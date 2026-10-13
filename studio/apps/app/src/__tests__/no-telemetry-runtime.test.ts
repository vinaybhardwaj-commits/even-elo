// @vitest-environment node
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const PROBE = resolve(__dirname, "fixtures/telemetry-probe.mjs");
const APP_ROOT = resolve(__dirname, "../..");

// No COPILOTKIT_TELEMETRY_DISABLED / DO_NOT_TRACK / SCARF_ANALYTICS here on purpose,
// and sampling forced to 100%: the patched packages must be inert on their own.
function run(mode: string): string[] {
  const env = {
    NODE_ENV: "production" as const,
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    COPILOTKIT_TELEMETRY_SAMPLE_RATE: "1",
  };
  const out: string = execFileSync(process.execPath, [PROBE, mode], { cwd: APP_ROOT, env, encoding: "utf8", timeout: 60_000 }) as string;
  return JSON.parse(out.trim().split("\n").pop() ?? "[]");
}

describe("runtime telemetry is inert without any kill-switch env", () => {
  it("the probe's hooks do see outbound attempts (positive control)", () => {
    expect(run("control").join(",")).toContain("example.invalid");
  });

  it("loading @copilotkit/shared and @copilotkit/runtime opens no non-localhost sockets", () => {
    expect(run("load")).toEqual([]);
  });
});
