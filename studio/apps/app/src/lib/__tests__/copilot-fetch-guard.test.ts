import { describe, expect, it, vi } from "vitest";
import {
  BACKOFF_BASE_MS,
  COOLDOWN_MS,
  FALLBACK_INFO,
  MAX_TOOL_FOLLOW_UPS,
  TOOL_LOOP_STOP_MESSAGE,
  WINDOW_MS,
  createCopilotFetchGuard,
} from "../copilot-fetch-guard";
import { CLIENT_BACKOFF_ERROR, decideRunError } from "../run-error";

const URL_ = "/studio/api/copilotkit";
const post = (rpc: string, threadId?: string) => ({ method: "POST", body: JSON.stringify({ method: rpc, params: { agentId: "default" }, ...(threadId ? { body: { threadId } } : {}) }) });

function setup(behaviour: () => Response | Promise<Response>) {
  let t = 0;
  const real = vi.fn(async () => behaviour());
  const guarded = createCopilotFetchGuard(real as unknown as typeof fetch, () => t);
  const tryRun = async (rpc = "agent/run", threadId = "t1") => {
    try {
      await guarded(URL_, post(rpc, threadId));
      return "sent";
    } catch (e) {
      return (e as { code?: string }).code === "client_backoff" ? "refused" : "failed";
    }
  };
  return { real, guarded, tryRun, at: (ms: number) => (t = ms) };
}

describe("copilot fetch guard", () => {
  it("never connects a thread that has not run, and connects once it has", async () => {
    const { real, guarded } = setup(() => new Response("", { status: 200 }));
    const res = await guarded(URL_, post("agent/connect", "fresh"));
    expect(res.status).toBe(200);
    expect(real).not.toHaveBeenCalled();
    await guarded(URL_, post("agent/run", "fresh"));
    await guarded(URL_, post("agent/connect", "fresh"));
    expect(real).toHaveBeenCalledTimes(2);
  });

  it("re-issues a network-failed call at most 3 times, 1 s / 2 s / 4 s apart, then cools down", async () => {
    const { real, tryRun, at } = setup(() => {
      throw new TypeError("network error");
    });
    const log: string[] = [];
    for (let ms = 0; ms <= 8_000; ms += 250) {
      at(ms);
      log.push(await tryRun());
    }
    // Network hits at 0, 1 s, 3 s, 7 s: 1 call + 3 re-issues.
    expect(real).toHaveBeenCalledTimes(4);
    expect(log.filter((x) => x === "failed")).toHaveLength(4);
    at(7_000 + COOLDOWN_MS - 1);
    expect(await tryRun()).toBe("refused");
    at(7_000 + COOLDOWN_MS);
    expect(await tryRun()).toBe("failed");
    expect(BACKOFF_BASE_MS).toBe(1_000);
  });

  it("counts a body that dies mid-stream as a failure", async () => {
    const { real, guarded, tryRun, at } = setup(
      () =>
        new Response(
          new ReadableStream({
            pull(c) {
              c.error(new TypeError("network error"));
            },
          }),
          { status: 200 },
        ),
    );
    const res = await guarded(URL_, post("agent/run"));
    await expect(res.text()).rejects.toThrow("network error");
    at(500);
    expect(await tryRun()).toBe("refused");
    at(1_000);
    expect(await tryRun()).toBe("sent");
    expect(real).toHaveBeenCalledTimes(2);
  });

  it("caps a loop of successful calls per method per window", async () => {
    const { real, tryRun, at } = setup(() => new Response("{}", { status: 200 }));
    const results: string[] = [];
    // (info is capped the same way but never refused to the caller; see the info tests below.)
    for (let i = 0; i < 50; i++) results.push(await tryRun("agent/run"));
    expect(real).toHaveBeenCalledTimes(6);
    expect(results.filter((r) => r === "refused")).toHaveLength(44);
    at(WINDOW_MS);
    expect(await tryRun("agent/run")).toBe("sent");
  });

  it("leaves other requests alone", async () => {
    const { real, guarded } = setup(() => new Response("{}", { status: 200 }));
    for (let i = 0; i < 10; i++) await guarded("/studio/api/screen/overview_counts", { method: "POST", body: "{}" });
    expect(real).toHaveBeenCalledTimes(10);
  });

  it("a refused call shows the back-off banner", () => {
    const decision = decideRunError({ error: Object.assign(new TypeError("x"), { code: "client_backoff" }) }, false);
    expect(decision).toEqual({ show: true, message: CLIENT_BACKOFF_ERROR });
  });

  it("ends a frontend-tool follow-up chain after 8 in a row with a local assistant message; a new user message resets it", async () => {
    const { real, guarded, at } = setup(() => new Response("", { status: 200 }));
    const run = (lastRole: string, runId: string) =>
      guarded(URL_, {
        method: "POST",
        body: JSON.stringify({ method: "agent/run", params: { agentId: "default" }, body: { threadId: "t1", runId, messages: [{ role: "user" }, { role: lastRole }] } }),
      });
    await run("user", "r0");
    for (let i = 1; i <= MAX_TOOL_FOLLOW_UPS; i++) {
      at(i * WINDOW_MS); // spread out so the rate window never refuses
      await run("tool", `r${i}`);
    }
    expect(real).toHaveBeenCalledTimes(1 + MAX_TOOL_FOLLOW_UPS);
    at(100 * WINDOW_MS);
    const stopped = await run("tool", "r9");
    const text = await stopped.text();
    expect(real).toHaveBeenCalledTimes(1 + MAX_TOOL_FOLLOW_UPS);
    expect(text).toContain('"type":"RUN_FINISHED"');
    expect(text).toContain(TOOL_LOOP_STOP_MESSAGE);
    // A reconnect replaying the dangling tool call later is still a follow-up: still stopped locally.
    at(200 * WINDOW_MS);
    await run("tool", "r10");
    expect(real).toHaveBeenCalledTimes(1 + MAX_TOOL_FOLLOW_UPS);
    await run("user", "r11");
    expect(real).toHaveBeenCalledTimes(2 + MAX_TOOL_FOLLOW_UPS);
  });

  it("never fails an info call: refused or failed info is answered with the last successful info response", async () => {
    const INFO = JSON.stringify({ version: "x", agents: { default: { name: "default" } } });
    let fail = false;
    const { real, guarded, at } = setup(() => {
      if (fail) throw new TypeError("network error");
      return new Response(INFO, { status: 200, headers: { "Content-Type": "application/json", "X-Runtime": "1" } });
    });
    const info = () => guarded(URL_, post("info"));
    expect(await (await info()).text()).toBe(INFO);
    // A burst far past the window limit: 10 reach the network, the rest are served locally, none throws.
    const burst = await Promise.all(Array.from({ length: 140 }, info));
    expect(real).toHaveBeenCalledTimes(10);
    for (const res of burst) {
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(INFO);
    }
    expect(burst.at(-1)!.headers.get("X-Runtime")).toBe("1");
    // A network failure of an admitted info is answered from the cache as well.
    at(WINDOW_MS + COOLDOWN_MS);
    fail = true;
    expect(await (await info()).text()).toBe(INFO);
  });

  it("before any info succeeded, a refused info waits for the one in flight; with none, it gets the fallback naming the default agent", async () => {
    const INFO = JSON.stringify({ version: "x", agents: { default: { name: "default" } } });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { real, guarded } = setup(async () => {
      await gate;
      return new Response(INFO, { status: 200 });
    });
    const pending = Array.from({ length: 15 }, () => guarded(URL_, post("info")));
    release();
    for (const res of await Promise.all(pending)) expect(await res.text()).toBe(INFO);
    expect(real).toHaveBeenCalledTimes(10);

    const down = setup(() => {
      throw new TypeError("network error");
    });
    const res = await down.guarded(URL_, post("info"));
    expect(await res.json()).toEqual(FALLBACK_INFO);
  });

  it("traces calls per method, with the stacks of repeated calls only", async () => {
    const { guarded, tryRun } = setup(() => new Response("{}", { status: 200 }));
    for (let i = 0; i < 12; i++) await tryRun("info");
    const { trace } = guarded as unknown as { trace: Record<string, { calls: number; refused: number; stacks: string[] }> };
    expect(trace.info.calls).toBe(12);
    expect(trace.info.refused).toBe(2);
    expect(trace.info.stacks).toHaveLength(3);
    expect(trace.info.stacks[0]).toContain("info call 2");
  });
});
