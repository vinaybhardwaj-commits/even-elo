import { describe, it, expect } from "vitest";
import { buildHostCsp, agentOrigin } from "../csp";

describe("buildHostCsp", () => {
  it("is same-origin by default with no third-party host", () => {
    const csp = buildHostCsp();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/https?:\/\//);
    expect(csp).not.toContain("*");
  });

  it("adds only the configured agent origin to connect-src", () => {
    expect(buildHostCsp("https://agent.internal:8123/path")).toContain("connect-src 'self' https://agent.internal:8123;");
    expect(buildHostCsp("agent-host:8123")).toContain("connect-src 'self' http://agent-host:8123;");
  });

  it("ignores an unparsable agent url", () => {
    expect(agentOrigin("http://")).toBeNull();
    expect(buildHostCsp("http://")).toContain("connect-src 'self';");
  });
});
