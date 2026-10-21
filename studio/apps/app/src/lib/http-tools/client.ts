import { z } from "zod";
import type { HttpToolName } from "@/lib/screens/tool-schema";

// Browser side of the HTTP read tools. The chat agent (LangGraph) only knows its own tools and the frontend tools
// CopilotKit forwards with each run, so these three are registered as frontend tools (use-generative-ui-examples).
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
  // Free text (include_text) is screen-only: it can hold patient identifiers and must not reach the model.
  const { include_text: _dropped, ...safe } = args ?? {};
  let res: Response;
  try {
    res = await fetchImpl(`${SCREEN_ROUTE}/${tool}`, {
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
    "view=list: incidents with id, status, dates, severity, RCA flag. Read-only. No narratives. Present the result as a table with its source.",
  eiris_incident_detail:
    "One e-IRIS incident by id (e.g. EHRC-INC-2026-0001): classification, dates, SLA state, RCA/CAPA structure. " +
    "No patient or reporter identity. No free text (narrative, root cause, CAPA actions); those are on the incident page only. Read-only.",
  opd_signals:
    "CDMSS OPD governance signals routed per doctor: thread counts (open, overdue, disagreed, awaiting ruling, awaiting doctor) and latest routed date. " +
    "Counts only, no comments. Read-only.",
};

// What the model may send. include_text is not offered; callHttpTool drops it anyway.
export const HTTP_TOOL_CLIENT_PARAMS = {
  eiris_incidents: z.object({
    view: z.enum(["summary", "list"]).optional().describe("summary (default) or list"),
    status: z.enum(["open", "closed"]).optional(),
    severity: z.string().optional().describe("severity name, e.g. major"),
    limit: z.number().optional().describe("max incidents, 1-200"),
  }),
  eiris_incident_detail: z.object({ incident_id: z.string().describe("Incident id such as EHRC-INC-2026-0001") }),
  opd_signals: z.object({
    doctor_uid: z.string().optional().describe("CDMSS doctor uid, to narrow to one doctor"),
    window_days: z.number().optional().describe("look-back window, 1-365 (default 30)"),
    limit: z.number().optional().describe("max doctors, 1-200"),
  }),
} as const satisfies Record<HttpToolName, z.ZodTypeAny>;
