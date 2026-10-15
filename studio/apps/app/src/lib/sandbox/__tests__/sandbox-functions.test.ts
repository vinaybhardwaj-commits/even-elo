import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  sendPromptFunction,
  SANDBOX_FUNCTIONS,
  SEND_PROMPT_EVENT,
  type SendPromptRequest,
} from "@/lib/sandbox/sandbox-functions";

describe("sendPromptFunction", () => {
  let received: string[];
  const listener = (e: Event) => {
    const request = (e as CustomEvent<SendPromptRequest>).detail;
    if (request.claim()) {
      received.push(request.text);
      request.resolve();
    }
  };

  beforeEach(() => {
    received = [];
    window.addEventListener(SEND_PROMPT_EVENT, listener);
  });

  afterEach(() => {
    window.removeEventListener(SEND_PROMPT_EVENT, listener);
  });

  it("has the sendPrompt name", () => {
    expect(sendPromptFunction.name).toBe("sendPrompt");
  });

  it("dispatches exactly one CustomEvent with the text for valid args", async () => {
    await expect(
      sendPromptFunction.handler({ text: "draw a chart" }),
    ).resolves.toEqual({ ok: true });
    expect(received).toEqual(["draw a chart"]);
  });

  it.each([
    ["missing text", {}],
    ["empty string", { text: "" }],
    ["whitespace only", { text: " \n\t " }],
    ["number", { text: 42 }],
    ["over 4000 chars", { text: "a".repeat(4001) }],
    ["extra junk only", { junk: "x" }],
  ])("throws and dispatches nothing for %s", async (_label, args) => {
    await expect(sendPromptFunction.handler(args)).rejects.toThrow();
    expect(received).toEqual([]);
  });

  it("accepts text at exactly 4000 chars", async () => {
    await expect(
      sendPromptFunction.handler({ text: "a".repeat(4000) }),
    ).resolves.toEqual({ ok: true });
    expect(received).toHaveLength(1);
  });
});

describe("SANDBOX_FUNCTIONS", () => {
  it("exposes only sendPrompt (no openLink bridge)", () => {
    // (No re-import identity assertion here: ES module caching makes it
    // tautological — referential stability is guaranteed by the const export.)
    expect(SANDBOX_FUNCTIONS.map((f) => f.name)).toEqual(["sendPrompt"]);
  });
});
