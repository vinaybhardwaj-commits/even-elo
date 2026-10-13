import { describe, it, expect } from "vitest";
import { LangGraphHttpAgent } from "@copilotkit/runtime/langgraph";
import { buildRuntimeOptions } from "../copilotkit-runtime-options";

describe("buildRuntimeOptions", () => {
  it("enables openGenerativeUI", () => {
    expect(buildRuntimeOptions({}).openGenerativeUI).toBe(true);
  });

  it("defines a default LangGraph agent", () => {
    const options = buildRuntimeOptions({});
    expect(options.agents.default).toBeInstanceOf(LangGraphHttpAgent);
  });

  it("defaults the agent url to http://localhost:8123", () => {
    const options = buildRuntimeOptions({});
    expect(options.agents.default.url).toBe("http://localhost:8123");
  });

  it("prefixes bare host:port urls with http://", () => {
    const options = buildRuntimeOptions({ langgraphUrl: "agent-host:8123" });
    expect(options.agents.default.url).toBe("http://agent-host:8123");
  });

  it("preserves full urls as-is", () => {
    const options = buildRuntimeOptions({ langgraphUrl: "https://agent.example.com" });
    expect(options.agents.default.url).toBe("https://agent.example.com");
  });

  it("preserves the a2ui config", () => {
    expect(buildRuntimeOptions({}).a2ui).toEqual({ injectA2UITool: true });
  });

  it("has no mcpApps branch", () => {
    expect(buildRuntimeOptions({})).not.toHaveProperty("mcpApps");
  });
});

describe("agent headers", () => {
  it("passes per-request headers to the agent and defaults to none", () => {
    const h = { "X-Studio-Service-Token": "t" };
    expect(buildRuntimeOptions({ headers: h }).agents.default.headers).toEqual(h);
    expect(buildRuntimeOptions({}).agents.default.headers).toEqual({});
  });
});
