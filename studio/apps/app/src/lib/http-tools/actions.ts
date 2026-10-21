import type { CopilotRuntime } from "@copilotkit/runtime";
import { runHttpTool } from "./run";

type RuntimeActions = Extract<NonNullable<ConstructorParameters<typeof CopilotRuntime>[0]>["actions"], unknown[]>;

// CopilotKit server-side actions for the HTTP read tools. Same handler as /api/screen/<tool>, so the chat gets
// the same role gate, audit row and typed table (columns, rows, source line) as a screen. The actor is the
// verified staff member of the request the runtime was built for (never taken from model output).
// A handler returns the SourceTablePayload as an object, or { ok: false, error } with a fixed code.

type Actor = { staffId: string; role: string };

// The chat gets the same rows as the screen, free text and identifiers included (V, 21 Oct: no doctor or PHI gating).
const run = (tool: Parameters<typeof runHttpTool>[0], actor: Actor) => async (args: Record<string, unknown>) => {
  return (await runHttpTool(tool, args ?? {}, actor)).body;
};

export function buildHttpToolActions(actor: Actor): RuntimeActions {
  const actions = [
    {
      name: "eiris_incidents",
      description:
        "e-IRIS incident register (safety/M&M). view=summary: open and closed counts by severity plus all-time totals and M&M case counts. " +
        "view=list: incidents with id, status, dates, severity, RCA flag. Read-only. Present the result as a table with its source.",
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
        "One e-IRIS incident by id (e.g. EHRC-INC-2026-0001): classification, dates, SLA state, patient and reporter details, narrative, immediate action, RCA root cause and CAPA actions. Read-only.",
      parameters: [
        { name: "incident_id", type: "string" as const, description: "Incident id such as EHRC-INC-2026-0001", required: true },
      ],
      handler: run("eiris_incident_detail", actor),
    },
    {
      name: "opd_signals",
      description:
        "CDMSS OPD governance signals routed per doctor: thread counts (open, overdue, disagreed, awaiting ruling, awaiting doctor) and latest routed date. " +
        "Counts only. Read-only.",
      parameters: [
        { name: "doctor_uid", type: "string" as const, description: "CDMSS doctor uid, to narrow to one doctor", required: false },
        { name: "window_days", type: "number" as const, description: "look-back window, 1-365 (default 30)", required: false },
        { name: "limit", type: "number" as const, description: "max doctors, 1-200", required: false },
      ],
      handler: run("opd_signals", actor),
    },
    {
      name: "audit_findings",
      description:
        "CDMSS audit findings routed to doctors: one row per thread with reference, hospital, doctor, finding, status, importance, doctor response verb, ruling action, overdue flag. " +
        "view=attention (default) shows overdue, disagreed and awaiting-ruling threads. Filter by doctor_uid, hospital code (reference prefix) and status. Read-only. Present the result as a table with its source.",
      parameters: [
        { name: "view", type: "string" as const, description: "attention (default), overdue, disagreed, awaiting_ruling, awaiting_doctor or all", required: false, enum: ["attention", "overdue", "disagreed", "awaiting_ruling", "awaiting_doctor", "all"] },
        { name: "status", type: "string" as const, description: "thread status", required: false, enum: ["routed", "responded", "escalated", "ruled", "closed"] },
        { name: "doctor_uid", type: "string" as const, description: "CDMSS doctor uid", required: false },
        { name: "hospital", type: "string" as const, description: "hospital code, e.g. EHRC", required: false },
        { name: "window_days", type: "number" as const, description: "look-back window, 1-365 (default 30)", required: false },
        { name: "limit", type: "number" as const, description: "max threads, 1-200", required: false },
      ],
      handler: run("audit_findings", actor),
    },
    {
      name: "audit_finding_detail",
      description:
        "One CDMSS audit thread by reference (e.g. EHRC-AUD-2026-0042): header, doctor response verb, ruling action, evidence instances (audit id, verdict, note date, citation titles) and timeline (event, time, actor class), plus doctor comment, ruling note and actor, and rationale. " +
        "Read-only. This tool cannot record a ruling.",
      parameters: [{ name: "reference", type: "string" as const, description: "Thread reference such as EHRC-AUD-2026-0042", required: true }],
      handler: run("audit_finding_detail", actor),
    },
  ];
  // The handler takes the runtime's loosely typed args; the runner validates them against the zod schema.
  return actions as unknown as RuntimeActions;
}
