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

from src.studio_access import can_use_tool
from src.studio_cdmss_tools import CDMSS_TOOLS
from src.studio_docaudit_tools import DOCAUDIT_TOOLS
from src.studio_tools import GOVERNANCE_TOOLS, STAFF_KEY, ToolError

logger = logging.getLogger("studio.screen")

SCREEN_TOOLS = {t.name: t for t in [*GOVERNANCE_TOOLS, *DOCAUDIT_TOOLS, *CDMSS_TOOLS]}
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


async def run_screen_tool(tool_name: str, params: dict, staff_id: str, roles) -> tuple[int, dict]:
    """Returns (http_status, json_body). The tool's own JSON is returned unchanged on success."""
    if tool_name not in SCREEN_TOOLS:
        return 404, {"ok": False, "error": "unknown_tool"}
    if not can_use_tool(roles, tool_name):  # per-tool predicate = the source page's access
        return 403, {"ok": False, "error": "forbidden"}
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


# ---------------------------------------------------------------------------------------------
# HTTP read tools (M1-http). These run in the Studio Next app (the agent has no egress to the
# incident or CDMSS APIs). The app reports each call here so it lands in the same append-only
# studio_audit table. Metadata only: tool, params hash, counts, timing. Never row content.
# ---------------------------------------------------------------------------------------------

HTTP_TOOL_NAMES = frozenset({"eiris_incidents", "eiris_incident_detail", "opd_signals", "audit_findings", "audit_finding_detail", "rmo_inbox", "rmo_author", "rmo_release"})
# M3: patient feedback (governance incidents table) read and retract, audited by the Studio server like the tools above.
HTTP_TOOL_NAMES = HTTP_TOOL_NAMES | frozenset({"patient_feedback", "feedback_retract"})
HTTP_TOOL_NAMES = HTTP_TOOL_NAMES | frozenset(
    {
        # M3-surgical: reads of the even-elo surgical-governance API, plus one name for confirmed writes.
        "surgical_overview",
        "surgical_leaderboard",
        "surgical_vcs",
        "surgical_vc_detail",
        "surgical_cases",
        "surgical_streams",
        "surgical_weights",
        "surgical_positions",
        "surgical_audit_log",
        "surgical_write",
    }
)
HTTP_TOOL_NAMES = HTTP_TOOL_NAMES | frozenset(
    {
        # M3-onboarding: reads of the even-elo VC onboarding API, plus one name for confirmed writes.
        "onboarding_overview",
        "onboarding_pipeline",
        "onboarding_prescreen",
        "onboarding_pending_credentials",
        "onboarding_hospitals",
        "onboarding_write",
    }
)
# M3 admin: users, roles, resignations and audit-log reads plus three confirm-card writes, audited by the Studio server like the tools above.
HTTP_TOOL_NAMES = HTTP_TOOL_NAMES | frozenset({"admin_users", "admin_roles", "admin_resignations", "admin_audit", "admin_set_status", "admin_grant_role", "admin_process_resignation"})
MAX_AUDIT_BODY_BYTES = 4096
_MAX_ROWS = 100_000
_MAX_MS = 600_000


async def record_http_audit(body: Any, staff_id: str, roles=None) -> tuple[int, dict]:
    """Validate one app-reported HTTP tool call and append its studio_audit row. (status, json_body)."""
    from src import studio_audit  # late: tests replace studio_audit.audit_sink

    if not isinstance(body, dict) or set(body) - {"tool", "params", "row_count", "duration_ms", "outcome"}:
        return 422, {"ok": False, "error": "bad_audit"}
    tool, params = body.get("tool"), body.get("params", {})
    row_count, duration_ms, outcome = body.get("row_count"), body.get("duration_ms"), body.get("outcome")
    if tool not in HTTP_TOOL_NAMES or not isinstance(params, dict):
        return 422, {"ok": False, "error": "bad_audit"}
    # The app already refused a tool the role may not run; an audit row for one is refused too (roles=None: direct call).
    if roles is not None and not can_use_tool(roles, tool):
        return 403, {"ok": False, "error": "forbidden"}
    for n, cap in ((row_count, _MAX_ROWS), (duration_ms, _MAX_MS)):
        if isinstance(n, bool) or not isinstance(n, int) or not 0 <= n <= cap:
            return 422, {"ok": False, "error": "bad_audit"}
    if outcome not in ("ok", "error"):
        return 422, {"ok": False, "error": "bad_audit"}
    try:
        await studio_audit.audit_sink(
            studio_audit.AuditRow(
                staff_id=staff_id,
                tool=tool,
                params_hash=studio_audit.params_hash(params),
                row_count=row_count,
                duration_ms=duration_ms,
                mode="live",
                outcome=outcome,
            )
        )
    except Exception as exc:  # fail closed: the app returns no data without this row
        logger.error("http audit write failed type=%s", type(exc).__name__)
        return 503, {"ok": False, "error": "audit_unavailable"}
    return 200, {"ok": True}
