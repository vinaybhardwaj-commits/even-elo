// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

const call = (headers: Record<string, string> = {}) =>
  POST(new NextRequest("https://governance.evenos.app/studio/api/copilotkit", { method: "POST", headers }));

describe("/studio/api/copilotkit", () => {
  afterEach(() => {
    delete process.env.AGENT_URL;
    delete process.env.STUDIO_SERVICE_TOKEN;
    delete process.env.STUDIO_ACTOR_SECRET;
  });

  it("401 without the actor headers the middleware sets", async () => {
    expect((await call()).status).toBe(401);
  });
  it("503 when the agent or its secrets are not configured", async () => {
    const h = { "x-studio-staff-id": "s", "x-studio-staff-role": "super_admin" };
    expect((await call(h)).status).toBe(503);
    process.env.AGENT_URL = "https://agent.invalid/agent";
    expect((await call(h)).status).toBe(503);
  });
});
