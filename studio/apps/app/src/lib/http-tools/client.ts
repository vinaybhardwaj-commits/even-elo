import { z } from "zod";
import type { HttpToolName } from "@/lib/screens/tool-schema";

// Browser side of the HTTP read tools. The chat agent (LangGraph) only knows its own tools and the frontend tools
// CopilotKit forwards with each run, so these tools are registered as frontend tools (use-generative-ui-examples).
// The handler calls the same-origin /studio/api/screen/<tool> route: the session cookie authenticates the staff
// member there, and the role gate, audit row and typed table stay in that server route. Nothing here decides access.

const SCREEN_ROUTE = "/studio/api/screen";
const TIMEOUT_MS = 55_000;

/** Result handed back to the model: the typed table JSON, or { ok: false, error } with a fixed code. */
export async function callHttpTool(
  tool: HttpToolName,
  args: Record<string, unknown> | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  return callToolRoute(SCREEN_ROUTE, tool, args, fetchImpl);
}

/** Same call for any tool family: `base` is the same-origin route that runs the tool (screen, surgical, onboarding). */
export async function callToolRoute(
  base: string,
  tool: string,
  args: Record<string, unknown> | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const safe = args ?? {};
  let res: Response;
  try {
    res = await fetchImpl(`${base}/${tool}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(safe),
      cache: "no-store",
      redirect: "error",
      credentials: "same-origin",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return JSON.stringify({ ok: false, error: "unreachable" });
  }
  try {
    return JSON.stringify(await res.json());
  } catch {
    return JSON.stringify({ ok: false, error: "bad_payload" });
  }
}

export const HTTP_TOOL_DESCRIPTIONS: Record<HttpToolName, string> = {
  eiris_incidents:
    "e-IRIS incident register (safety/M&M). view=summary: open and closed counts by severity plus all-time totals and M&M case counts. " +
    "view=list: incidents with id, status, dates, severity, RCA flag. since/until filter by reported date; a summary with a range counts only those incidents, by severity and by type (category); a range_incomplete row means e-IRIS did not return the whole range, so say the counts are partial. Read-only. Present the result as a table with its source.",
  eiris_incident_detail:
    "One e-IRIS incident by id (e.g. EHRC-INC-2026-0001): classification, dates, SLA state, patient and reporter details, narrative, immediate action, RCA root cause and CAPA actions. Read-only.",
  opd_signals:
    "CDMSS OPD governance signals routed per doctor: thread counts (open, overdue, disagreed, awaiting ruling, awaiting doctor) and latest routed date. " +
    "Counts only. Read-only.",
  audit_findings:
    "CDMSS audit findings routed to doctors: one row per thread with reference, hospital, doctor, finding, status, importance, doctor response verb, ruling action, overdue flag. " +
    "view=attention (default) shows overdue, disagreed and awaiting-ruling threads. Read-only. Present the result as a table with its source.",
  audit_finding_detail:
    "One CDMSS audit thread by reference (e.g. EHRC-AUD-2026-0042): header, doctor response verb, ruling action, evidence instances, timeline, doctor comment, ruling note and rationale. " +
    "Read-only. This tool cannot record a ruling.",
};

// What the model may send.
export const HTTP_TOOL_CLIENT_PARAMS = {
  eiris_incidents: z.object({
    view: z.enum(["summary", "list"]).optional().describe("summary (default) or list"),
    status: z.enum(["open", "closed"]).optional(),
    severity: z.string().optional().describe("severity name, e.g. major"),
    since: z.string().optional().describe("reported on or after this date: YYYY-MM-DD (Asia/Kolkata day) or ISO date-time"),
    until: z.string().optional().describe("reported on or before this date: YYYY-MM-DD (whole day) or ISO date-time"),
    limit: z.number().optional().describe("max incidents, 1-200"),
  }),
  eiris_incident_detail: z.object({ incident_id: z.string().describe("Incident id such as EHRC-INC-2026-0001") }),
  opd_signals: z.object({
    doctor_uid: z.string().optional().describe("CDMSS doctor uid, to narrow to one doctor"),
    window_days: z.number().optional().describe("look-back window, 1-365 (default 30)"),
    limit: z.number().optional().describe("max doctors, 1-200"),
  }),
  audit_findings: z.object({
    view: z.enum(["attention", "overdue", "disagreed", "awaiting_ruling", "awaiting_doctor", "all"]).optional().describe("attention (default), overdue, disagreed, awaiting_ruling, awaiting_doctor or all"),
    status: z.enum(["routed", "responded", "escalated", "ruled", "closed"]).optional().describe("thread status"),
    doctor_uid: z.string().optional().describe("CDMSS doctor uid"),
    hospital: z.string().optional().describe("hospital code, e.g. EHRC"),
    window_days: z.number().optional().describe("look-back window, 1-365 (default 30)"),
    since: z.string().optional().describe("routed on or after this date: YYYY-MM-DD (Asia/Kolkata day) or ISO date-time"),
    until: z.string().optional().describe("routed on or before this date: YYYY-MM-DD (whole day) or ISO date-time"),
    limit: z.number().optional().describe("max threads, 1-200"),
  }),
  audit_finding_detail: z.object({ reference: z.string().describe("Thread reference such as EHRC-AUD-2026-0042") }),
} as const satisfies Record<HttpToolName, z.ZodTypeAny>;
