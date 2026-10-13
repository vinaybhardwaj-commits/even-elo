"""
This is the main entry point for the agent.
It defines the workflow graph, state, tools, nodes and edges.
"""

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

from ag_ui.core import RunAgentInput
from ag_ui.encoder import EventEncoder
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from copilotkit import CopilotKitMiddleware, LangGraphAGUIAgent
from deepagents import create_deep_agent

from src.anthropic_compat import ConsecutiveSystemMessagesMiddleware
from src.studio_auth import (
    STATE_KEY,
    LayeredNonceStore,
    MemoryNonceStore,
    PostgresNonceStore,
    StudioAuthMiddleware,
)
from src.studio_checkpoint import dev_checkpointer, postgres_checkpointer
from src.studio_db import connect_studio, studio_db_configured
from src.studio_logging import configure_logging
from src.studio_tools import GOVERNANCE_TOOLS, STAFF_KEY
from src.model import build_model
from src.visualization_router import JevVisualizationMiddleware
from src.skill_backend import SKILL_SOURCES, build_agent_backend
from src.plan import plan_visualization
from src.prompt import SYSTEM_PROMPT

load_dotenv()
configure_logging()

# Read-only governance tools (M0-S2). No write tools exist.
TOOLS = [plan_visualization, *GOVERNANCE_TOOLS]


def build_agent(checkpointer):
    return create_deep_agent(
        model=build_model(name="sonnet", allow_unconfigured=True),
        tools=TOOLS,
        middleware=[
            CopilotKitMiddleware(),
            JevVisualizationMiddleware(),
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


# No docs/openapi: the surface is exactly POST /agent and GET /agent/health.
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
    request_agent.config = {"configurable": {STAFF_KEY: staff_id}}

    async def event_generator():
        async for event in request_agent.run(input_data):
            yield encoder.encode(event)

    return StreamingResponse(event_generator(), media_type=encoder.get_content_type())


warnings.filterwarnings("ignore", category=UserWarning, module="pydantic")

if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8123"))
    uvicorn.run("main:app", host="0.0.0.0", port=port)
