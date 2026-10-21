"""Screen tool endpoint (M1): POST /agent/tools/{name}.

Fixed layouts in the app load their data through the SAME audited read tools the chat uses. This module
only adds a direct-invocation door; it adds no SQL, no grants and no write path.

  * allowlist: exactly the governance read tools (GOVERNANCE_TOOL_NAMES: the six M0-S2 tools and the six
    studio_ro view tools added in M1), nothing else;
  * params: validated against the tool's own pydantic args model; unknown keys are refused;
  * identity: the staff id comes from the verified actor JWT (StudioAuthMiddleware), never the body;
  * audit + live/fixture switch + source line + query hash: inherited, because the tool itself runs
    (studio_tools.run_read_tool writes the studio_audit row and fails closed);
  * errors: fixed codes only. Exception text is never returned or logged.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from pydantic import ValidationError

from src.studio_tools import GOVERNANCE_TOOLS, STAFF_KEY, ToolError

logger = logging.getLogger("studio.screen")

SCREEN_TOOLS = {t.name: t for t in GOVERNANCE_TOOLS}
MAX_BODY_BYTES = 4096


def validate_params(tool_name: str, params: Any) -> dict:
    """Return the validated params, or raise ValueError (fixed message)."""
    tool = SCREEN_TOOLS[tool_name]
    if params is None:
        params = {}
    if not isinstance(params, dict):
        raise ValueError("params must be an object")
    model = tool.args_schema
    unknown = set(params) - set(model.model_fields)
    if unknown:
        raise ValueError("unknown parameter")
    try:
        return model.model_validate(params).model_dump(mode="json", exclude_unset=True)
    except ValidationError:
        raise ValueError("invalid parameter") from None


async def run_screen_tool(tool_name: str, params: dict, staff_id: str) -> tuple[int, dict]:
    """Returns (http_status, json_body). The tool's own JSON is returned unchanged on success."""
    if tool_name not in SCREEN_TOOLS:
        return 404, {"ok": False, "error": "unknown_tool"}
    try:
        clean = validate_params(tool_name, params)
    except ValueError:
        return 422, {"ok": False, "error": "bad_params"}
    try:
        raw = await SCREEN_TOOLS[tool_name].ainvoke(clean, config={"configurable": {STAFF_KEY: staff_id}})
    except ToolError as exc:  # ToolError text is safe by contract (fixed strings, no data)
        return 502, {"ok": False, "error": "tool_failed", "message": str(exc)}
    except Exception as exc:
        logger.warning("screen tool=%s failed type=%s", tool_name, type(exc).__name__)
        return 502, {"ok": False, "error": "tool_failed"}
    try:
        return 200, json.loads(raw)
    except (TypeError, ValueError):
        logger.warning("screen tool=%s returned non-JSON", tool_name)
        return 502, {"ok": False, "error": "tool_failed"}
