// @vitest-environment node
// Boots the BUILT app with basePath /studio and talks to it over HTTP. A direct call to the route's
// POST() cannot catch a wrong CopilotKit endpoint, because Next strips basePath before the handler.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const APP_ROOT = resolve(__dirname, "../..");
const BUILT = existsSync(resolve(APP_ROOT, ".next/BUILD_ID"));
const SECRET = "integration-secret-not-real";
const STAFF = "33333333-3333-4333-8333-333333333333";

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
    s.on("error", fail);
  });
}

// Locally an unbuilt app skips this suite; with CI set it FAILS instead, so CI cannot pass without
// exercising the basePath/endpoint path. Build first: pnpm --filter @repo/app build.
describe.skipIf(!BUILT && !process.env.CI)("built studio app under basePath /studio", () => {
  let child: ChildProcess;
  let base = "";
  let cookie = "";

  beforeAll(async () => {
    if (!BUILT) throw new Error("the app is not built (CI is set): run `pnpm --filter @repo/app build` before the tests");
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    cookie = `epi_session=${await new SignJWT({ profileId: STAFF }).setProtectedHeader({ alg: "HS256" }).setAudience("staff").setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(SECRET))}`;
    child = spawn(process.execPath, [resolve(APP_ROOT, "node_modules/next/dist/bin/next"), "start", "-p", String(port), "-H", "127.0.0.1"], {
      cwd: APP_ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_ENV: "production",
        NODE_OPTIONS: `--require ${resolve(__dirname, "fixtures/mock-neon-fetch.cjs")}`,
        STAFF_JWT_SECRET: SECRET,
        GOV_RO_DATABASE_URL: "postgresql://ro:ro@db.invalid/gov",
        AGENT_URL: "http://127.0.0.1:9/agent",
        STUDIO_SERVICE_TOKEN: "svc-not-real",
        STUDIO_ACTOR_SECRET: "actor-not-real",
      },
      stdio: "ignore",
    });
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(`${base}/studio/api/health`);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw new Error("built app did not start");
  }, 60_000);

  afterAll(() => {
    child?.kill("SIGKILL");
  });

  const post = (path: string, headers: Record<string, string> = {}, body = "{}") =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: "https://governance.evenos.app", "x-forwarded-host": "governance.evenos.app", ...headers }, body });

  it("serves only under /studio and the zone answers 401 without a session", async () => {
    expect((await fetch(`${base}/studio/api/health`)).status).toBe(401);
    expect((await fetch(`${base}/api/health`)).status).toBe(404);
  });

  it("an authenticated super_admin gets 200 from the CopilotKit info call (not Hono's 404)", async () => {
    const res = await post("/studio/api/copilotkit", { cookie }, JSON.stringify({ method: "info" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("agents");
  });

  it("a malformed call reaches CopilotKit's own validation (400), proving the endpoint path matches", async () => {
    const res = await post("/studio/api/copilotkit", { cookie });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Missing method field");
  });

  it("a physician cookie next to the staff cookie is refused on the real server", async () => {
    const res = await post("/studio/api/copilotkit", { cookie: `${cookie}; epi_physician_session=x` }, JSON.stringify({ method: "info" }));
    expect(res.status).toBe(401);
  });
});
