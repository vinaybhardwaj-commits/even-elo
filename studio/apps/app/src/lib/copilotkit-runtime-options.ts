import { LangGraphHttpAgent } from "@copilotkit/runtime/langgraph";

class NoRedirectLangGraphAgent extends LangGraphHttpAgent {
  protected override requestInit(input: Parameters<LangGraphHttpAgent["requestInit"]>[0]): RequestInit {
    // Never follow redirects from the agent service. Fail closed.
    return { ...super.requestInit(input), redirect: "error" };
  }
}

export interface RuntimeOptionsEnv {
  langgraphUrl?: string;
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
      }),
    },
    a2ui: { injectA2UITool: true },
    openGenerativeUI: true as const,
  };
}
