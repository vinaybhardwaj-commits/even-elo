import { SURGICAL_READ_NAMES, SURGICAL_READ_PARAMS, type SurgicalReadName } from "@/lib/surgical/schema";
import { ONBOARDING_READ_NAMES, ONBOARDING_READ_PARAMS, type OnboardingReadName } from "@/lib/onboarding/schema";
import { callToolRoute } from "./client";

// Browser side of the Surgical and Onboarding read tools, the same frontend-tool pattern as client.ts: the agent does
// not know server-side CopilotKit actions, so the chat registers these as frontend tools and the browser calls the
// same-origin route. The route keeps the role gate, the studio_audit row and the typed table. Reads only: no write
// is ever offered to the model (changes are confirm cards on the screens).

export const SURGICAL_ROUTE = "/studio/api/surgical";
export const ONBOARDING_ROUTE = "/studio/api/onboarding";

const READ_ONLY = " Read-only. Present the result as a table with its source.";

const SURGICAL_DESCRIPTIONS: Record<SurgicalReadName, string> = {
  surgical_overview: "Surgical Governance (visiting consultants, ELO) counts: VCs by status, completed cases, current weights, tier spread.",
  surgical_leaderboard: "Latest ELO score snapshot per visiting consultant: composite, caseload/outcomes/adherence, tier.",
  surgical_vcs: "Visiting consultant roster: id, name, specialty, registration number, status.",
  surgical_vc_detail: "One visiting consultant by vc_id (uuid from surgical_vcs). section: summary, components, snapshots, cases or activity.",
  surgical_cases: "Surgical cases by case_ref (no patient identity): date, surgeon, procedure, status.",
  surgical_streams: "ELO stream catalogue: component, owner team, rule, direction, floor and target.",
  surgical_weights: "Weight version history (caseload/outcomes/adherence %), newest first, current flagged.",
  surgical_positions: "Surgical Governance positions and their descriptions.",
  surgical_audit_log: "even-elo audit log: when, who (position), action, entity. No before/after content.",
};

const ONBOARDING_DESCRIPTIONS: Record<OnboardingReadName, string> = {
  onboarding_overview: "VC onboarding counts: pre-screens by stage (prescreen, observation, decision, onboarded, rejected, terminated) and credentials pending verification.",
  onboarding_pipeline: "VC onboarding pipeline: one row per pre-screen with stage, decision, hospitals and who pre-screened. Use prescreen_id with onboarding_prescreen.",
  onboarding_prescreen: "One pre-screen by prescreen_id (uuid from onboarding_pipeline). section: summary (default) or observations (scored cases; narrative text is never returned).",
  onboarding_pending_credentials: "Qualifications awaiting verification across the network: physician, degree, institution, whether a file is attached.",
  onboarding_hospitals: "Active hospital codes, names and ids.",
};

export type FamilyChatTool = { name: string; description: string; parameters: import("zod").ZodTypeAny; route: string };

export const FAMILY_CHAT_TOOLS: readonly FamilyChatTool[] = [
  ...SURGICAL_READ_NAMES.map((name) => ({ name, description: SURGICAL_DESCRIPTIONS[name] + READ_ONLY, parameters: SURGICAL_READ_PARAMS[name], route: SURGICAL_ROUTE })),
  ...ONBOARDING_READ_NAMES.map((name) => ({ name, description: ONBOARDING_DESCRIPTIONS[name] + READ_ONLY, parameters: ONBOARDING_READ_PARAMS[name], route: ONBOARDING_ROUTE })),
];

export const callFamilyTool = (tool: FamilyChatTool, args: Record<string, unknown> | undefined, fetchImpl: typeof fetch = fetch) =>
  callToolRoute(tool.route, tool.name, args, fetchImpl);
