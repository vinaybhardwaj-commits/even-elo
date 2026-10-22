import { NextRequest, NextResponse } from "next/server";
import { normalizeLanggraphUrl } from "@/lib/copilotkit-runtime-options";
import { agentHeaders } from "@/lib/zone/actor-token";
import { ACTOR_ID_HEADER, ACTOR_ROLE_HEADER } from "@/lib/zone/authorize";
import { SCREEN_TOOL_PARAMS, SourceTablePayload, isGovernanceTool, isHttpTool } from "@/lib/screens/tool-schema";
import { runHttpTool } from "@/lib/http-tools/run";
import { fetchAgent, isTimeout } from "@/lib/agent-fetch";

// Screen reads (M1). A fixed Studio layout asks for ONE named governance read tool with typed params; this
// route forwards it to the agent's POST /agent/tools/<name> with the same service token and actor JWT the
// chat route uses. The agent runs the same audited tool (studio_audit row, source line, query hash). There is
// no database access here. Error bodies carry fixed codes only, never upstream text.

// Upstream reads (10 s each) plus the audit call can exceed the default function time.
export const maxDuration = 60;

const MAX_BODY_BYTES = 4096;
const AGENT_TIMEOUT_MS = 20_000;
const NO_STORE = { "Cache-Control": "no-store" };

const fail = (status: number, error: string, extra?: Record<string, string>) =>
  NextResponse.json({ ok: false, error }, { status, headers: { ...NO_STORE, ...extra } });

// eiris_incidents, eiris_incident_detail, opd_signals: read over HTTP from this app (the agent has no egress to
// those hosts), audited through the agent's POST /agent/audit. See lib/http-tools/run.ts.
async function httpTool(req: NextRequest, tool: Parameters<typeof runHttpTool>[0], staffId: string, role: string) {
  let params: unknown;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return fail(422, "bad_params");
    params = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return fail(422, "bad_params");
  }
  const result = await runHttpTool(tool, params, { staffId, role });
  const extra = "headers" in result ? result.headers : undefined;
  return NextResponse.json(result.body, { status: result.status, headers: { ...NO_STORE, ...extra } });
}

export const POST = async (req: NextRequest, ctx: { params: Promise<{ tool: string }> }) => {
  // src/proxy.ts has already authenticated the staff member and overwritten these headers.
  const staffId = req.headers.get(ACTOR_ID_HEADER);
  const role = req.headers.get(ACTOR_ROLE_HEADER);
  if (!staffId || !role) return fail(401, "unauthorized");

  const { tool } = await ctx.params;
  if (isHttpTool(tool)) return httpTool(req, tool, staffId, role);
  if (!isGovernanceTool(tool)) return fail(404, "unknown_tool");

  let params: unknown;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return fail(422, "bad_params");
    params = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return fail(422, "bad_params");
  }
  const parsed = SCREEN_TOOL_PARAMS[tool].safeParse(params);
  if (!parsed.success) return fail(422, "bad_params");

  const agentUrl = process.env.AGENT_URL;
  if (!agentUrl) return fail(503, "agent_not_configured");
  let headers: Record<string, string>;
  try {
    headers = await agentHeaders(staffId, role, {
      STUDIO_SERVICE_TOKEN: process.env.STUDIO_SERVICE_TOKEN,
      STUDIO_ACTOR_SECRET: process.env.STUDIO_ACTOR_SECRET,
    });
  } catch {
    return fail(503, "agent_not_configured");
  }

  let res: Response;
  try {
    // A stale kept-alive socket is retried once inside fetchAgent (the first read after an idle spell).
    res = await fetchAgent(
      `${normalizeLanggraphUrl(agentUrl).replace(/\/+$/, "")}/tools/${tool}`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
        cache: "no-store",
        // Never follow redirects from the agent service (same as the chat route). Fail closed.
        redirect: "error",
      },
      AGENT_TIMEOUT_MS,
    );
  } catch (err) {
    // Slow is not down: a timeout says so, so the screen does not report a running agent as unreachable.
    return isTimeout(err) ? fail(504, "agent_timeout") : fail(502, "agent_unreachable");
  }

  if (res.status === 429) return fail(429, "rate_limited", { "Retry-After": "60" });
  if (!res.ok) return fail(502, "tool_failed");

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return fail(502, "bad_payload");
  }
  const payload = SourceTablePayload.safeParse(body);
  // Same refusal as the chat table: a result without its source line is never passed on.
  if (!payload.success || payload.data.source.tool !== tool) return fail(502, "bad_payload");
  return NextResponse.json(payload.data, { headers: NO_STORE });
};
