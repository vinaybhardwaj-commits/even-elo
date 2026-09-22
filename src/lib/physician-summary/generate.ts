import "server-only";
import { createVertexClient } from "@/lib/vertex/client";
import { parseVertexConfig, type EnvSource } from "@/lib/vertex/env";
import { aggregateFeedback, type SafeFeedbackRow } from "./aggregate";
import { acceptSummaryBody, buildSummaryPrompt } from "./prompt";

const TIMEOUT_MS = 20_000;

export type GenerateSummaryResult =
  | { ok: true; text: string; model: string; location: string; project: string }
  | { ok: false; code: "flag_off" | "not_configured" | "refused" | "upstream" };

function leaksSecret(text: string, secrets: string[]): boolean {
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i.test(text)) return true;
  return secrets.some((secret) => {
    const trimmed = secret.trim();
    return trimmed.length >= 16 && text.includes(trimmed);
  });
}

/**
 * On-demand theme summary. Refuses unless the feature flag is exactly "true".
 * The prompt is built from aggregates only. Model text that fails the
 * theme-level check is not returned.
 */
export async function generateThemeSummary(
  rows: readonly SafeFeedbackRow[],
  specialty: string | null,
  env: EnvSource = process.env,
): Promise<GenerateSummaryResult> {
  const parsed = parseVertexConfig(env);
  if (!parsed.publicConfig.featureEnabled) return { ok: false, code: "flag_off" };
  if (!parsed.credentials) return { ok: false, code: "not_configured" };

  const aggregate = aggregateFeedback(rows);
  if (aggregate.feedback_count < 1) return { ok: false, code: "refused" };

  let prompt: { system: string; user: string };
  try {
    prompt = buildSummaryPrompt(aggregate, specialty);
  } catch {
    return { ok: false, code: "refused" };
  }

  const secrets = [parsed.credentials.privateKey, parsed.credentials.clientEmail];
  try {
    const ai = createVertexClient(parsed.credentials);
    const response = await ai.models.generateContent({
      model: parsed.credentials.model,
      contents: prompt.user,
      config: {
        systemInstruction: prompt.system,
        temperature: 0.2,
        maxOutputTokens: 1024,
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      },
    });
    const raw = typeof response.text === "string" ? response.text : "";
    if (leaksSecret(raw, secrets)) return { ok: false, code: "refused" };
    const text = acceptSummaryBody(raw);
    if (!text || leaksSecret(text, secrets)) return { ok: false, code: "refused" };
    return {
      ok: true,
      text,
      model: parsed.credentials.model,
      location: parsed.credentials.location,
      project: parsed.credentials.project,
    };
  } catch {
    console.error(JSON.stringify({ physician_summary: "upstream" }));
    return { ok: false, code: "upstream" };
  }
}
