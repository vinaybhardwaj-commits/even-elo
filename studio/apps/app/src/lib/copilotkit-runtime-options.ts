import { LangGraphHttpAgent } from "@copilotkit/runtime/langgraph";
import { buildHttpToolActions } from "@/lib/http-tools/actions";

class NoRedirectLangGraphAgent extends LangGraphHttpAgent {
  protected override requestInit(input: Parameters<LangGraphHttpAgent["requestInit"]>[0]): RequestInit {
    // Never follow redirects from the agent service. Fail closed.
    return { ...super.requestInit(input), redirect: "error" };
  }
}

export interface RuntimeOptionsEnv {
  /** Server-side CopilotKit actions (the HTTP read tools), built per request with the verified actor. */
  actions?: ReturnType<typeof buildHttpToolActions>;
  langgraphUrl?: string;
  /** Per-request headers for the agent call (service token + actor JWT). Never cookies. */
  headers?: Record<string, string>;
}

// Normalize Render's fromService hostport (bare host:port) into a full URL
export function normalizeLanggraphUrl(raw?: string): string {
  if (!raw) return "http://localhost:8123";
  return raw.startsWith("http") ? raw : `http://${raw}`;
}

export function buildRuntimeOptions(env: RuntimeOptionsEnv) {
  return {
    agents: {
      default: new NoRedirectLangGraphAgent({
        url: normalizeLanggraphUrl(env.langgraphUrl),
        headers: env.headers ?? {},
      }),
    },
    ...(env.actions ? { actions: env.actions } : {}),
    a2ui: { injectA2UITool: true },
    openGenerativeUI: true as const,
  };
}
