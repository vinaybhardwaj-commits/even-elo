import type { CopilotRuntime } from "@copilotkit/runtime";
import { runOnboardingRead, type OnboardingActor } from "./run";
import type { OnboardingReadName } from "./schema";

type RuntimeActions = Extract<NonNullable<ConstructorParameters<typeof CopilotRuntime>[0]>["actions"], unknown[]>;

// CopilotKit server-side actions for the VC onboarding READ tools. Same handler as /api/onboarding/<tool>, so the
// chat gets the same role gate, studio_audit row and typed table (columns, rows, source line) as a screen. There are
// NO write actions: the agent never changes data; writes are confirm cards on the screens (fable ruling D).

const run = (tool: OnboardingReadName, actor: OnboardingActor) => async (args: Record<string, unknown>) => (await runOnboardingRead(tool, args ?? {}, actor)).body;

const s = (name: string, description: string, required = false, en?: string[]) => ({ name, type: "string" as const, description, required, ...(en ? { enum: en } : {}) });
const n = (name: string, description: string) => ({ name, type: "number" as const, description, required: false });

export function buildOnboardingActions(actor: OnboardingActor): RuntimeActions {
  const tool = (name: OnboardingReadName, description: string, parameters: object[] = []) => ({ name, description: `${description} Read-only. Present the result as a table with its source.`, parameters, handler: run(name, actor) });
  const actions = [
    tool("onboarding_overview", "VC onboarding counts: pre-screens by stage (prescreen, observation, decision, onboarded, rejected, terminated) and credentials pending verification."),
    tool("onboarding_pipeline", "VC onboarding pipeline: one row per pre-screen with stage, decision, hospitals and who pre-screened. Use prescreen_id with onboarding_prescreen.", [
      s("stage", "stage filter", false, ["prescreen", "observation", "decision", "onboarded", "rejected", "terminated"]),
      n("limit", "max rows, 1-500"),
    ]),
    tool("onboarding_prescreen", "One pre-screen by prescreen_id (uuid from onboarding_pipeline). section: summary (default) or observations (scored observation cases; narrative text is never returned).", [
      s("prescreen_id", "pre-screen uuid", true),
      s("section", "summary (default) or observations", false, ["summary", "observations"]),
    ]),
    tool("onboarding_pending_credentials", "Qualifications awaiting verification across the network: physician, degree, institution, whether a file is attached.", [n("limit", "max rows")]),
    tool("onboarding_hospitals", "Active hospital codes, names and ids."),
  ];
  return actions as unknown as RuntimeActions;
}
