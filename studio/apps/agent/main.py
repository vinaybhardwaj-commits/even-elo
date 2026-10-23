"""
This is the main entry point for the agent.
It defines the workflow graph, state, tools, nodes and edges.
"""

import json
import logging
import os
import warnings

# Never report to third parties, regardless of the host environment.
for _name, _value in (
    ("LANGSMITH_TRACING", "false"),
    ("LANGSMITH_TRACING_V2", "false"),
    ("LANGCHAIN_TRACING_V2", "false"),
    ("LANGCHAIN_TRACING", "false"),
    ("COPILOTKIT_TELEMETRY_DISABLED", "1"),
    ("DO_NOT_TRACK", "1"),
    ("SCARF_ANALYTICS", "false"),
):
    os.environ[_name] = _value

# Credential-bearing HTTP libraries log request/response details at DEBUG.
# Pin them here, before anything imports them, so a root DEBUG level cannot
# lower them.
for _logger in ("botocore", "boto3", "urllib3", "google.auth", "httpx"):
    logging.getLogger(_logger).setLevel(logging.WARNING)

from dotenv import load_dotenv
from contextlib import asynccontextmanager

from ag_ui.core import EventType, RunAgentInput
from ag_ui.encoder import EventEncoder
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from copilotkit import CopilotKitMiddleware, LangGraphAGUIAgent
from deepagents import create_deep_agent

from src.anthropic_compat import ConsecutiveSystemMessagesMiddleware
from src.clock import CurrentTimeMiddleware
from src.studio_auth import (
    STATE_KEY,
    LayeredNonceStore,
    MemoryNonceStore,
    PostgresNonceStore,
    StudioAuthMiddleware,
)
from src.run_errors import classify, run_error_event
from src.studio_checkpoint import dev_checkpointer, postgres_checkpointer
from src.studio_db import connect_studio, studio_db_configured
from src.studio_logging import configure_logging
from src.studio_screen import MAX_AUDIT_BODY_BYTES, MAX_BODY_BYTES, record_http_audit, run_screen_tool
from src.studio_cdmss_tools import CDMSS_TOOLS
from src.studio_docaudit_tools import DOCAUDIT_TOOLS
from src.studio_tools import GOVERNANCE_TOOLS, ROLES_KEY, STAFF_KEY, RoleToolGate, ToolErrorToResult
from src.model import build_model
from src.visualization_router import JevVisualizationMiddleware
from src.skill_backend import SKILL_SOURCES, build_agent_backend
from src.plan import plan_visualization
from src.prompt import SYSTEM_PROMPT

load_dotenv()
configure_logging()

# Read-only governance tools (M0-S2). No write tools exist.
TOOLS = [plan_visualization, *GOVERNANCE_TOOLS, *DOCAUDIT_TOOLS, *CDMSS_TOOLS]


def build_agent(checkpointer):
    return create_deep_agent(
        model=build_model(name="sonnet", allow_unconfigured=True),
        tools=TOOLS,
        middleware=[
            CopilotKitMiddleware(),
            RoleToolGate(),
            ToolErrorToResult(),
            JevVisualizationMiddleware(),
            CurrentTimeMiddleware(),
            ConsecutiveSystemMessagesMiddleware(),
        ],
        skills=SKILL_SOURCES,
        backend=build_agent_backend,
        checkpointer=checkpointer,
        system_prompt=SYSTEM_PROMPT,
    )


def build_ag_ui_agent(graph) -> LangGraphAGUIAgent:
    return LangGraphAGUIAgent(
        name="sample_agent",
        description="Even Healthcare governance studio: answers you can interact with",
        graph=graph,
    )


# Development graph (in-memory checkpoints). With STUDIO_DATABASE_URL set, the lifespan below
# replaces it with a Postgres-checkpointed graph before the first request.
agent = build_agent(dev_checkpointer())


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not studio_db_configured():
        yield
        return
    async with postgres_checkpointer() as saver:
        app.state.studio_agent = build_ag_ui_agent(build_agent(saver))
        yield


# No docs/openapi: the surface is POST /agent, GET /agent/health and POST /agent/tools/{name} (screen reads) and POST /agent/audit (app-side HTTP reads).
app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.state.studio_agent = build_ag_ui_agent(agent)

_memory_nonces = MemoryNonceStore()
_nonces = (
    LayeredNonceStore(_memory_nonces, PostgresNonceStore(connect_studio)) if studio_db_configured() else _memory_nonces
)
# Outermost (first) middleware: nothing below runs for an unauthenticated request.
app.add_middleware(StudioAuthMiddleware, nonce_store=_nonces)


@app.get("/agent/health")
def health():
    return {"status": "ok"}


@app.post("/agent/tools/{tool_name}")
async def run_tool(tool_name: str, request: Request):
    """Direct invocation of ONE governance read tool for the fixed screens (same auth, audit and limits)."""
    actor = (request.scope.get("state") or {}).get(STATE_KEY)
    if not actor:  # defence in depth: the middleware always sets this
        return JSONResponse({"ok": False, "error": "unauthenticated"}, status_code=401)
    raw = await request.body()
    if len(raw) > MAX_BODY_BYTES:
        return JSONResponse({"ok": False, "error": "bad_params"}, status_code=422)
    try:
        params = json.loads(raw) if raw.strip() else {}
    except ValueError:
        return JSONResponse({"ok": False, "error": "bad_params"}, status_code=422)
    status, body = await run_screen_tool(tool_name, params, actor["staff_id"], actor.get("roles"))
    return JSONResponse(body, status_code=status)


@app.post("/agent/audit")
async def http_tool_audit(request: Request):
    """Append-only audit row for a read the Studio app made over HTTP (eiris_*, opd_signals). Metadata only."""
    actor = (request.scope.get("state") or {}).get(STATE_KEY)
    if not actor:  # defence in depth: the middleware always sets this
        return JSONResponse({"ok": False, "error": "unauthenticated"}, status_code=401)
    raw = await request.body()
    if len(raw) > MAX_AUDIT_BODY_BYTES:
        return JSONResponse({"ok": False, "error": "bad_audit"}, status_code=422)
    try:
        body = json.loads(raw) if raw.strip() else None
    except ValueError:
        return JSONResponse({"ok": False, "error": "bad_audit"}, status_code=422)
    status, out = await record_http_audit(body, actor["staff_id"], actor.get("roles"))
    return JSONResponse(out, status_code=status)


def scoped_thread_id(staff_id: str, thread_id: str) -> str:
    """Threads are namespaced by staff id, so one staff member cannot resume another's thread."""
    prefix = f"{staff_id}:"
    return thread_id if thread_id.startswith(prefix) else prefix + thread_id


@app.post("/agent")
async def run_agent(input_data: RunAgentInput, request: Request):
    actor = (request.scope.get("state") or {}).get(STATE_KEY)
    if not actor:  # defence in depth: the middleware always sets this
        return JSONResponse({"ok": False, "error": "unauthenticated"}, status_code=401)
    staff_id = actor["staff_id"]
    input_data = input_data.model_copy(update={"thread_id": scoped_thread_id(staff_id, input_data.thread_id)})

    encoder = EventEncoder(accept=request.headers.get("accept"))
    request_agent = request.app.state.studio_agent.clone()
    # The staff id reaches tools only through the graph config, never through model output.
    request_agent.config = {"configurable": {STAFF_KEY: staff_id, ROLES_KEY: actor.get("roles") or []}}

    async def event_generator():
        finished = False
        try:
            async for event in request_agent.run(input_data):
                finished = finished or getattr(event, "type", None) == EventType.RUN_FINISHED
                yield encoder.encode(event)
        except Exception as exc:
            # Fixed code and message only: exception text can embed hostnames or DSN fragments.
            logging.getLogger(__name__).warning("run failed type=%s code=%s", type(exc).__name__, classify(exc))
            if not finished:
                yield encoder.encode(run_error_event(exc))

    return StreamingResponse(event_generator(), media_type=encoder.get_content_type())


warnings.filterwarnings("ignore", category=UserWarning, module="pydantic")

if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8123"))
    uvicorn.run("main:app", host="0.0.0.0", port=port)
