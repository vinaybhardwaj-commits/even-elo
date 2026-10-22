import type { CopilotRuntime } from "@copilotkit/runtime";
import { canUseTool } from "@/lib/zone/access";
import { runSurgicalRead, type SurgicalActor } from "./run";
import type { SurgicalReadName } from "./schema";

type RuntimeActions = Extract<NonNullable<ConstructorParameters<typeof CopilotRuntime>[0]>["actions"], unknown[]>;

// CopilotKit server-side actions for the Surgical Governance READ tools. Same handler as /api/surgical/<tool>, so the
// chat gets the same role gate, studio_audit row and typed table (columns, rows, source line) as a screen. There are
// NO write actions: the agent never changes data; writes are confirm cards on the screens (fable ruling D).

const run = (tool: SurgicalReadName, actor: SurgicalActor) => async (args: Record<string, unknown>) => (await runSurgicalRead(tool, args ?? {}, actor)).body;

const s = (name: string, description: string, required = false, en?: string[]) => ({ name, type: "string" as const, description, required, ...(en ? { enum: en } : {}) });
const n = (name: string, description: string) => ({ name, type: "number" as const, description, required: false });

export function buildSurgicalActions(actor: SurgicalActor): RuntimeActions {
  const tool = (name: SurgicalReadName, description: string, parameters: object[] = []) => ({ name, description: `${description} Read-only. Present the result as a table with its source.`, parameters, handler: run(name, actor) });
  const actions = [
    tool("surgical_overview", "Surgical Governance (visiting consultants, ELO) counts: VCs by status, completed cases, current weights, tier spread."),
    tool("surgical_leaderboard", "Latest ELO score snapshot per visiting consultant: composite, caseload/outcomes/adherence, tier.", [s("status", "active (default) or all", false, ["active", "all"]), n("limit", "max rows, 1-500")]),
    tool("surgical_vcs", "Visiting consultant roster: id, name, specialty, registration number, status.", [s("status", "active (default) or all", false, ["active", "all"]), n("limit", "max rows")]),
    tool("surgical_vc_detail", "One visiting consultant by vc_id (uuid from surgical_vcs). section: summary, components (per-stream sub-scores), snapshots (90-day history), cases, activity.", [
      s("vc_id", "VC uuid", true),
      s("section", "summary (default), components, snapshots, cases, activity", false, ["summary", "components", "snapshots", "cases", "activity"]),
      n("limit", "max rows"),
    ]),
    tool("surgical_cases", "Surgical cases by case_ref (no patient identity): date, surgeon, procedure, status.", [s("vc_id", "VC uuid to narrow to one surgeon"), s("status", "completed (default) or all", false, ["completed", "all"]), s("from", "YYYY-MM-DD"), s("to", "YYYY-MM-DD"), n("limit", "max rows")]),
    tool("surgical_streams", "ELO stream catalogue: component, owner team, rule, direction, floor and target.", [s("component", "caseload, outcomes or adherence", false, ["caseload", "outcomes", "adherence"]), s("team", "owning team"), { name: "active_only", type: "boolean" as const, description: "only active streams", required: false }]),
    tool("surgical_weights", "Weight version history (caseload/outcomes/adherence %), newest first, current flagged.", [n("limit", "max rows")]),
    tool("surgical_positions", "Surgical Governance positions and their descriptions."),
    tool("surgical_audit_log", "even-elo audit log: when, who (position), action, entity. No before/after content.", [s("action", "action filter"), s("entity_type", "entity type filter"), s("actor", "actor position substring"), n("limit", "max rows"), n("offset", "paging offset")]),
  ];
  return actions.filter((a) => canUseTool(actor.role, a.name)) as unknown as RuntimeActions;
}
