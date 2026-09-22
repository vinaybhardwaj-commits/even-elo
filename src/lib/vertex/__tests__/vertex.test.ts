import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  VERTEX_REQUIRED_ENV,
  isVertexSummariesEnabled,
  normalizePrivateKey,
  parseVertexConfig,
  safeVertexErrorMessage,
} from "../env";
import { sealHealthBody, vertexHealthBody } from "../health";
import { runVertexHealthCheck } from "../client";

const FAKE_EMAIL = "vertex-spike@example.test";
const FAKE_KEY_BODY = "FAKEKEYMATERIALNOTREAL12";
const FAKE_KEY = `-----BEGIN PRIVATE KEY-----\n${FAKE_KEY_BODY}\n-----END PRIVATE KEY-----`;

const { ctorArgs, generateContent } = vi.hoisted(() => ({
  ctorArgs: [] as unknown[],
  generateContent: vi.fn(async () => ({})),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    constructor(opts: unknown) {
      ctorArgs.push(opts);
    }
    models = { generateContent };
  },
}));

function configuredEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    GOOGLE_VERTEX_PROJECT: "clinical-infra",
    GOOGLE_VERTEX_LOCATION: "asia-northeast1",
    GOOGLE_VERTEX_MODEL: "gemini-3.8-flash",
    VERTEX_CLIENT_EMAIL: FAKE_EMAIL,
    VERTEX_PRIVATE_KEY: FAKE_KEY,
    FEATURE_VERTEX_SUMMARIES: "false",
    ...overrides,
  };
}

describe("vertex env contract", () => {
  it("keeps the feature flag off unless the value is exactly true", () => {
    expect(isVertexSummariesEnabled({})).toBe(false);
    expect(isVertexSummariesEnabled({ FEATURE_VERTEX_SUMMARIES: "false" })).toBe(false);
    expect(isVertexSummariesEnabled({ FEATURE_VERTEX_SUMMARIES: "1" })).toBe(false);
    expect(isVertexSummariesEnabled({ FEATURE_VERTEX_SUMMARIES: "TRUE" })).toBe(false);
    expect(isVertexSummariesEnabled({ FEATURE_VERTEX_SUMMARIES: " true " })).toBe(true);
  });

  it("normalizes quoted and escaped PEM newlines without dropping real newlines", () => {
    expect(normalizePrivateKey('"-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----"')).toBe(
      "-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----",
    );
    expect(normalizePrivateKey("-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----")).toBe(
      "-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----",
    );
    expect(normalizePrivateKey("   ")).toBe("");
  });

  it("reports not configured and omits secrets when the service account is absent", () => {
    const parsed = parseVertexConfig({
      GOOGLE_VERTEX_PROJECT: "clinical-infra",
      GOOGLE_VERTEX_LOCATION: "asia-northeast1",
      GOOGLE_VERTEX_MODEL: "gemini-3.8-flash",
      VERTEX_PRIVATE_KEY: FAKE_KEY,
    });
    expect(parsed.credentials).toBeNull();
    expect(parsed.publicConfig.configured).toBe(false);
    expect(parsed.publicConfig.missing).toEqual(["VERTEX_CLIENT_EMAIL"]);
    expect(parsed.publicConfig.project).toBe("clinical-infra");
    const body = vertexHealthBody({ publicConfig: parsed.publicConfig, reachable: null });
    expect(body.state).toBe("not_configured");
    expect(body.ok).toBe(false);
    expect(body.reachable).toBeNull();
    const serialized = JSON.stringify(parsed.publicConfig) + JSON.stringify(body);
    expect(serialized).not.toContain(FAKE_KEY_BODY);
    expect(serialized).not.toContain("PRIVATE KEY");
  });

  it("lists every missing name and does not call out a default project", () => {
    const parsed = parseVertexConfig({});
    expect(parsed.publicConfig.missing).toEqual([...VERTEX_REQUIRED_ENV]);
    expect(parsed.publicConfig.project).toBeNull();
    expect(parsed.publicConfig.featureEnabled).toBe(false);
    const body = vertexHealthBody({ publicConfig: parsed.publicConfig, reachable: null });
    expect(body.message.toLowerCase()).toContain("not configured");
    expect(body.message).toMatch(/Preview/);
  });

  it("scrubs PEM, email, and bearer material from error text", () => {
    const message = safeVertexErrorMessage(
      new Error(`auth failed ${FAKE_KEY} for ${FAKE_EMAIL} Bearer ya29.supersecrettokenvalue1234567890`),
    );
    expect(message).not.toContain(FAKE_KEY_BODY);
    expect(message).not.toContain(FAKE_EMAIL);
    expect(message).not.toContain("ya29");
    expect(message).not.toMatch(/PRIVATE KEY/);
  });

  it("drops a health message that still contains key material", () => {
    const parsed = parseVertexConfig(configuredEnv());
    const dirty = vertexHealthBody({
      publicConfig: parsed.publicConfig,
      reachable: false,
      errorMessage: `boom ${FAKE_KEY}`,
    });
    const sealed = sealHealthBody(dirty, [FAKE_KEY, FAKE_EMAIL]);
    expect(sealed.state).toBe("error");
    expect(sealed.message).toBe("Vertex request failed");
    expect(JSON.stringify(sealed)).not.toContain(FAKE_KEY_BODY);
  });
});

describe("vertex health check", () => {
  beforeEach(() => {
    ctorArgs.length = 0;
    generateContent.mockReset();
    generateContent.mockResolvedValue({});
  });

  it("does not construct a client when env is missing", async () => {
    const body = await runVertexHealthCheck({});
    expect(body.state).toBe("not_configured");
    expect(ctorArgs).toHaveLength(0);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("pings the configured model and reports flag_off without returning secrets", async () => {
    const body = await runVertexHealthCheck(configuredEnv());
    expect(body).toMatchObject({
      ok: true,
      state: "flag_off",
      feature_enabled: false,
      configured: true,
      reachable: true,
      project: "clinical-infra",
      location: "asia-northeast1",
      model: "gemini-3.8-flash",
      missing: [],
    });
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(generateContent).toHaveBeenCalledWith({
      model: "gemini-3.8-flash",
      contents: "Health check. Reply with the single word ok.",
      config: expect.objectContaining({ temperature: 0 }),
    });
    const opts = ctorArgs[0] as {
      vertexai: boolean;
      project: string;
      location: string;
      googleAuthOptions: { credentials: { client_email: string; private_key: string } };
    };
    expect(opts.vertexai).toBe(true);
    expect(opts.project).toBe("clinical-infra");
    expect(opts.location).toBe("asia-northeast1");
    expect(opts.googleAuthOptions.credentials.client_email).toBe(FAKE_EMAIL);
    expect(opts.googleAuthOptions.credentials.private_key).toContain("BEGIN PRIVATE KEY");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(FAKE_EMAIL);
    expect(serialized).not.toContain(FAKE_KEY_BODY);
    expect(serialized).not.toMatch(/PRIVATE KEY/);
  });

  it("reports ok only when the flag is on and the probe succeeds", async () => {
    const body = await runVertexHealthCheck(configuredEnv({ FEATURE_VERTEX_SUMMARIES: "true" }));
    expect(body.state).toBe("ok");
    expect(body.feature_enabled).toBe(true);
    expect(body.ok).toBe(true);
  });

  it("returns a safe error when the probe fails", async () => {
    generateContent.mockRejectedValue(
      new Error(`denied ${FAKE_KEY} ${FAKE_EMAIL} Bearer ya29.supersecrettokenvalue1234567890`),
    );
    const body = await runVertexHealthCheck(configuredEnv());
    expect(body.state).toBe("error");
    expect(body.ok).toBe(false);
    expect(body.reachable).toBe(false);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(FAKE_KEY_BODY);
    expect(serialized).not.toContain(FAKE_EMAIL);
    expect(serialized).not.toContain("ya29");
    expect(serialized).not.toMatch(/PRIVATE KEY/);
  });

  it("keeps the health route super-admin only and free of prompt input", () => {
    const route = readFileSync(
      join(__dirname, "../../../app/api/admin/vertex/health/route.ts"),
      "utf8",
    );
    expect(route).toContain("is_super_admin");
    expect(route).toContain("Super admin only");
    expect(route).not.toContain("searchParams");
    expect(route).not.toContain("VERTEX_PRIVATE_KEY");
    expect(route).not.toContain("console.log");
    const client = readFileSync(join(__dirname, "../client.ts"), "utf8");
    expect(client).toContain('import "server-only"');
    expect(client).not.toContain("console.log");
    expect(client).toContain("vertex_health");
  });
});
