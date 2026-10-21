import type { CopilotRuntime } from "@copilotkit/runtime";
import { runHttpTool } from "./run";

type RuntimeActions = Extract<NonNullable<ConstructorParameters<typeof CopilotRuntime>[0]>["actions"], unknown[]>;

// CopilotKit server-side actions for the HTTP read tools. Same handler as /api/screen/<tool>, so the chat gets
// the same role gate, audit row and typed table (columns, rows, source line) as a screen. The actor is the
// verified staff member of the request the runtime was built for (never taken from model output).
// A handler returns the SourceTablePayload as an object, or { ok: false, error } with a fixed code.

type Actor = { staffId: string; role: string };

// Free text (include_text) is screen-only: reporter-typed narrative can hold patient identifiers and must not reach
// the LLM provider. The chat path drops the key whatever the model sends, so the runner always sees it false.
const run = (tool: Parameters<typeof runHttpTool>[0], actor: Actor) => async (args: Record<string, unknown>) => {
  const { include_text: _dropped, ...safe } = args ?? {};
  return (await runHttpTool(tool, safe, actor)).body;
};

export function buildHttpToolActions(actor: Actor): RuntimeActions {
  const actions = [
    {
      name: "eiris_incidents",
      description:
        "e-IRIS incident register (safety/M&M). view=summary: open and closed counts by severity plus all-time totals and M&M case counts. " +
        "view=list: incidents with id, status, dates, severity, RCA flag. Read-only. No narratives. Present the result as a table with its source.",
      parameters: [
        { name: "view", type: "string" as const, description: "summary (default) or list", required: false, enum: ["summary", "list"] },
        { name: "status", type: "string" as const, description: "open or closed", required: false, enum: ["open", "closed"] },
        { name: "severity", type: "string" as const, description: "severity name, e.g. major", required: false },
        { name: "limit", type: "number" as const, description: "max rows, 1-200 (list view)", required: false },
      ],
      handler: run("eiris_incidents", actor),
    },
    {
      name: "eiris_incident_detail",
      description:
        "One e-IRIS incident by id (e.g. EHRC-INC-2026-0001): classification, dates, SLA state, RCA/CAPA structure. " +
        "No patient or reporter identity. No free text (narrative, root cause, CAPA actions); those are on the incident page only. Read-only.",
      parameters: [
        { name: "incident_id", type: "string" as const, description: "Incident id such as EHRC-INC-2026-0001", required: true },
      ],
      handler: run("eiris_incident_detail", actor),
    },
    {
      name: "opd_signals",
      description:
        "CDMSS OPD governance signals routed per doctor: thread counts (open, overdue, disagreed, awaiting ruling, awaiting doctor) and latest routed date. " +
        "Counts only, no comments. Read-only.",
      parameters: [
        { name: "doctor_uid", type: "string" as const, description: "CDMSS doctor uid, to narrow to one doctor", required: false },
        { name: "window_days", type: "number" as const, description: "look-back window, 1-365 (default 30)", required: false },
        { name: "limit", type: "number" as const, description: "max doctors, 1-200", required: false },
      ],
      handler: run("opd_signals", actor),
    },
  ];
  // The handler takes the runtime's loosely typed args; the runner validates them against the zod schema.
  return actions as unknown as RuntimeActions;
}
