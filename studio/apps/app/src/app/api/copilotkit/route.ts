import { disableTelemetry } from "@/lib/no-telemetry";
import {
  CopilotRuntime,
  ExperimentalEmptyAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";
import { NextRequest } from "next/server";
import { buildRuntimeOptions } from "@/lib/copilotkit-runtime-options";
import { buildHttpToolActions } from "@/lib/http-tools/actions";
import { buildSurgicalActions } from "@/lib/surgical/actions";
import { agentHeaders } from "@/lib/zone/actor-token";
import { ACTOR_ID_HEADER, ACTOR_ROLE_HEADER } from "@/lib/zone/authorize";

disableTelemetry();

// The middleware (src/proxy.ts) has already authenticated the staff member and overwritten
// the actor headers read here. Rate limiting is enforced by the agent, per staff id.
// Upstream reads (10 s each) plus the audit call can exceed the default function time.
export const maxDuration = 60;

export const POST = async (req: NextRequest) => {
  const staffId = req.headers.get(ACTOR_ID_HEADER);
  const role = req.headers.get(ACTOR_ROLE_HEADER);
  const agentUrl = process.env.AGENT_URL;
  if (!staffId || !role) return new Response("Unauthorized", { status: 401 });
  if (!agentUrl) return new Response("Agent not configured", { status: 503 });

  let headers: Record<string, string>;
  try {
    headers = await agentHeaders(staffId, role, {
      STUDIO_SERVICE_TOKEN: process.env.STUDIO_SERVICE_TOKEN,
      STUDIO_ACTOR_SECRET: process.env.STUDIO_ACTOR_SECRET,
    });
  } catch {
    return new Response("Agent not configured", { status: 503 });
  }

  const runtimeOptions = buildRuntimeOptions({ langgraphUrl: agentUrl, headers, actions: [...buildHttpToolActions({ staffId, role }), ...buildSurgicalActions({ staffId, role, session: req.cookies.get("epi_session")?.value ?? null, position: null })] });
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    // Next strips basePath before the handler sees the URL, so the endpoint is WITHOUT /studio.
    endpoint: "/api/copilotkit",
    serviceAdapter: new ExperimentalEmptyAdapter(),
    runtime: new CopilotRuntime(runtimeOptions),
  });

  return handleRequest(req);
};
