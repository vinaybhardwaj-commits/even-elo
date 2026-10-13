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
from fastapi import FastAPI
from copilotkit import CopilotKitMiddleware, LangGraphAGUIAgent
from ag_ui_langgraph import add_langgraph_fastapi_endpoint
from deepagents import create_deep_agent

from src.anthropic_compat import ConsecutiveSystemMessagesMiddleware
from src.bounded_memory_saver import BoundedMemorySaver
from src.model import build_model
from src.visualization_router import JevVisualizationMiddleware
from src.skill_backend import SKILL_SOURCES, build_agent_backend
from src.plan import plan_visualization
from src.prompt import SYSTEM_PROMPT

load_dotenv()

# Real governance tools arrive in M1; only the routing helper remains.
TOOLS = [plan_visualization]

agent = create_deep_agent(
    model=build_model(name="sonnet", allow_unconfigured=True),
    tools=TOOLS,
    middleware=[
        CopilotKitMiddleware(),
        JevVisualizationMiddleware(),
        ConsecutiveSystemMessagesMiddleware(),
    ],
    skills=SKILL_SOURCES,
    backend=build_agent_backend,
    checkpointer=BoundedMemorySaver(max_threads=200),
    system_prompt=SYSTEM_PROMPT,
)

app = FastAPI()


@app.get("/health")
def health():
    return {"status": "ok"}


add_langgraph_fastapi_endpoint(
    app=app,
    agent=LangGraphAGUIAgent(
        name="sample_agent",
        description="Even Healthcare governance studio: answers you can interact with",
        graph=agent,
    ),
    path="/",
)

warnings.filterwarnings("ignore", category=UserWarning, module="pydantic")

if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8123"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
