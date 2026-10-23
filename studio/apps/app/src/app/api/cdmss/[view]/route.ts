import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { normalizeLanggraphUrl } from "@/lib/copilotkit-runtime-options";
import { agentHeaders } from "@/lib/zone/actor-token";
import { canAccessScreen } from "@/lib/zone/access";
import { ACTOR_ID_HEADER, ACTOR_ROLE_HEADER } from "@/lib/zone/authorize";
import { AgentRetryError, fetchAgent, isTimeout } from "@/lib/agent-fetch";
import { FAMILIES, VIEW_IDS, VIEW_SCHEMAS, type ViewId } from "@/lib/cdmss/contract";

// CDMSS module view reads. READ ONLY: one POST forwards the typed params to the agent's /tools/cdmss_view_<view> with
// the same service token and actor JWT the screen route uses; the agent runs the audited query. No database here and
// no write verb. Error bodies carry fixed codes only. TOOL NAME is PROVISIONAL until builder A's CONTRACT.md lands.

export const maxDuration = 60;
const MAX_BODY_BYTES = 2048;
const AGENT_TIMEOUT_MS = 20_000;
const NO_STORE = { "Cache-Control": "no-store" };
const fail = (status: number, error: string, extra?: Record<string, string>) => NextResponse.json({ ok: false, error }, { status, headers: { ...NO_STORE, ...extra } });

const PARAMS = z
  .object({
    family: z.enum(FAMILIES).optional(),
    site: z.string().regex(/^[A-Z]{2,6}$/).optional(),
    metric_id: z.string().regex(/^M-[A-Z]{2,5}-\d{2}$/).optional(),
    weeks: z.number().int().min(1).max(26).optional(),
  })
  .strict();

const toolFor = (view: ViewId) => `cdmss_view_${view}`;

export const POST = async (req: NextRequest, ctx: { params: Promise<{ view: string }> }) => {
  const staffId = req.headers.get(ACTOR_ID_HEADER);
  const role = req.headers.get(ACTOR_ROLE_HEADER);
  if (!staffId || !role) return fail(401, "unauthorized");
  if (!canAccessScreen(role, "cdmss")) return fail(403, "forbidden");

  const { view } = await ctx.params;
  if (!(VIEW_IDS as readonly string[]).includes(view)) return fail(404, "unknown_view");

  let params: unknown;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return fail(422, "bad_params");
    params = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return fail(422, "bad_params");
  }
  const parsed = PARAMS.safeParse(params);
  if (!parsed.success) return fail(422, "bad_params");

  const agentUrl = process.env.AGENT_URL;
  if (!agentUrl) return fail(503, "agent_not_configured");
  let headers: Record<string, string>;
  try {
    headers = await agentHeaders(staffId, role, { STUDIO_SERVICE_TOKEN: process.env.STUDIO_SERVICE_TOKEN, STUDIO_ACTOR_SECRET: process.env.STUDIO_ACTOR_SECRET });
  } catch {
    return fail(503, "agent_not_configured");
  }

  let res: Response;
  try {
    res = await fetchAgent(
      `${normalizeLanggraphUrl(agentUrl).replace(/\/+$/, "")}/tools/${toolFor(view as ViewId)}`,
      { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(parsed.data), cache: "no-store", redirect: "error" },
      AGENT_TIMEOUT_MS,
    );
  } catch (err) {
    if (isTimeout(err)) return fail(504, "agent_timeout");
    return fail(502, err instanceof AgentRetryError ? "agent_unreachable_after_retry" : "agent_unreachable");
  }
  if (res.status === 429) return fail(429, "rate_limited", { "Retry-After": "60" });
  if (!res.ok) return fail(502, "tool_failed");

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return fail(502, "bad_payload");
  }
  // A result without its envelope (provenance, headline, caveats, action) is never passed on.
  const payload = VIEW_SCHEMAS[view as ViewId].safeParse(body);
  if (!payload.success) return fail(502, "bad_payload");
  return NextResponse.json(payload.data, { headers: NO_STORE });
};
