import { describe, expect, it, vi } from "vitest";
import { BACKOFF_BASE_MS, COOLDOWN_MS, WINDOW_MS, createCopilotFetchGuard } from "../copilot-fetch-guard";
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
    for (let i = 0; i < 50; i++) results.push(await tryRun("info"));
    expect(real).toHaveBeenCalledTimes(3);
    expect(results.filter((r) => r === "refused")).toHaveLength(47);
    at(WINDOW_MS);
    expect(await tryRun("info")).toBe("sent");
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
});
