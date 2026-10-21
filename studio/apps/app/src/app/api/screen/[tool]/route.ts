import { NextRequest, NextResponse } from "next/server";
import { agentHeaders } from "@/lib/zone/actor-token";
import { ACTOR_ID_HEADER, ACTOR_ROLE_HEADER } from "@/lib/zone/authorize";
import { SCREEN_TOOL_PARAMS, SourceTablePayload, isGovernanceTool } from "@/lib/screens/tool-schema";

// Screen reads (M1). A fixed Studio layout asks for ONE named governance read tool with typed params; this
// route forwards it to the agent's POST /agent/tools/<name> with the same service token and actor JWT the
// chat route uses. The agent runs the same audited tool (studio_audit row, source line, query hash). There is
// no database access here. Error bodies carry fixed codes only, never upstream text.

const MAX_BODY_BYTES = 4096;
const AGENT_TIMEOUT_MS = 20_000;
const NO_STORE = { "Cache-Control": "no-store" };

const fail = (status: number, error: string, extra?: Record<string, string>) =>
  NextResponse.json({ ok: false, error }, { status, headers: { ...NO_STORE, ...extra } });

export const POST = async (req: NextRequest, ctx: { params: Promise<{ tool: string }> }) => {
  // src/proxy.ts has already authenticated the staff member and overwritten these headers.
  const staffId = req.headers.get(ACTOR_ID_HEADER);
  const role = req.headers.get(ACTOR_ROLE_HEADER);
  if (!staffId || !role) return fail(401, "unauthorized");

  const { tool } = await ctx.params;
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
    res = await fetch(`${agentUrl.replace(/\/+$/, "")}/tools/${tool}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(parsed.data),
      cache: "no-store",
      signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
    });
  } catch {
    return fail(502, "agent_unreachable");
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
