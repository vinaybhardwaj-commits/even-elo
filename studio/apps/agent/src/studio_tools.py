"""Live READ-ONLY governance tools (M0-S2).

Rules (all enforced in code and tests):
  * typed arguments, fixed parameterised SQL; the model never supplies SQL text;
  * the staff id comes from the graph config (set by the server from the verified actor JWT),
    never from a tool argument;
  * every call writes exactly one studio_audit row (metadata only, no row content); if the audit
    row cannot be written the call fails and returns no data;
  * env STUDIO_LIVE_READS is read on every call: 0/false/off/no/empty switches to fixtures;
  * only SELECT/WITH statements can reach the connection (see assert_read_only).

Tables read (from src/lib/migrations.ts of even-elo): physicians, physician_engagements, hospitals,
gov_signal_snapshots, gov_interventions, incidents. Free-text columns (notes, narratives,
registration numbers, contact details, doctor names inside signal payloads) are never selected.

M1 adds six tools over the column-scoped VIEWS in schema studio_ro (ops/neon/0003_studio_views.sql):
physician_privileges, physician_oppe, physician_metrics, physician_qualifications, capture_gaps and
feedback_by_physician. They read ONLY studio_ro views, never the base tables behind them.
"""

from __future__ import annotations

import datetime as dt
import decimal
import hashlib
import json
import logging
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Literal, Optional

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool
from pydantic import BaseModel, Field

from src import studio_audit
from src.studio_db import connect_read_only
from src.studio_pins import PinError

logger = logging.getLogger("studio.tools")

STAFF_KEY = "studio_staff_id"
# Inside src/ so the kill switch works in a deploy image that ships no tests/ directory.
FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"
MAX_LIMIT = 200
MAX_OFFSET = 100_000

# ---------------------------------------------------------------------------------------------
# SQL. Placeholders are psycopg %s. LIKE patterns are escaped by like_pattern().
# ---------------------------------------------------------------------------------------------

LIST_PHYSICIANS_SQL = """
SELECT p.id::text AS physician_id, p.full_name, p.primary_specialty, p.current_status,
       p.date_joined_network::text AS date_joined_network,
       COALESCE(string_agg(DISTINCT h.code, ', ' ORDER BY h.code) FILTER (WHERE h.code IS NOT NULL), '') AS hospitals,
       count(*) OVER () AS total_count
FROM physicians p
LEFT JOIN physician_engagements e ON e.physician_id = p.id AND e.status <> 'terminated'
LEFT JOIN hospitals h ON h.id = e.hospital_id
WHERE (%s::text IS NULL OR p.current_status = %s::text)
  AND (%s::text IS NULL OR p.primary_specialty ILIKE %s::text ESCAPE '\\')
  AND (%s::text IS NULL OR p.full_name ILIKE %s::text ESCAPE '\\')
  AND (%s::text IS NULL OR EXISTS (
        SELECT 1 FROM physician_engagements e2 JOIN hospitals h2 ON h2.id = e2.hospital_id
        WHERE e2.physician_id = p.id AND e2.status <> 'terminated' AND h2.code = %s::text))
GROUP BY p.id
ORDER BY p.full_name, p.id
LIMIT %s OFFSET %s
"""

PHYSICIAN_PROFILE_SQL = """
SELECT p.id::text AS physician_id, p.full_name, p.preferred_name, p.primary_specialty, p.current_status,
       p.date_joined_network::text AS date_joined_network,
       p.registration_council, p.registration_expiry::text AS registration_expiry,
       COALESCE((SELECT string_agg(h.code || ' ' || e.category || ' ' || e.status, ' | ' ORDER BY h.code)
                 FROM physician_engagements e JOIN hospitals h ON h.id = e.hospital_id
                 WHERE e.physician_id = p.id), '') AS engagements
FROM physicians p
WHERE p.id = %s::uuid
LIMIT 1
"""

# One row per (snapshot day, signal). With a physician: only signals that list them in affected[].
SIGNAL_SNAPSHOTS_SQL = """
SELECT s.day::text AS day, s.period, sig.value->>'label' AS signal, sig.value->>'severity' AS severity,
       sig.value->>'trend' AS trend, sig.value->>'scope' AS scope,
       NULLIF(sig.value->>'n', '')::int AS n,
       COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(sig.value->'affected') = 'array' THEN sig.value->'affected' END), 0) AS affected_doctors,
       aff.value->>'n' AS physician_n,
       COALESCE(aff.value->>'mean', aff.value->>'value') AS physician_value
FROM gov_signal_snapshots s
CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(s.payload->'report'->'signals') = 'array' THEN s.payload->'report'->'signals' ELSE '[]'::jsonb END
    ) AS sig(value)
LEFT JOIN LATERAL (
      SELECT a.value FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(sig.value->'affected') = 'array' THEN sig.value->'affected' ELSE '[]'::jsonb END) AS a(value)
      WHERE a.value->>'uid' = (SELECT cdmss_doctor_uid FROM physicians WHERE id = %s::uuid)
      LIMIT 1
    ) aff ON TRUE
WHERE s.day >= (current_date - %s::int)
  AND (%s::uuid IS NULL OR aff.value IS NOT NULL)
ORDER BY s.day DESC, sig.value->>'label'
LIMIT %s
"""

INTERVENTIONS_SQL = """
SELECT i.id::text AS intervention_id, i.done_on::text AS done_on, i.signal_key, i.signal_label, i.kind,
       i.action, i.physician_id::text AS physician_id, i.cdmss_sync_state
FROM gov_interventions i
WHERE (%s::uuid IS NULL OR i.physician_id = %s::uuid)
ORDER BY i.done_on DESC, i.created_at DESC
LIMIT %s
"""

INCIDENT_SUMMARY_SQL = """
SELECT i.status, COALESCE(i.polarity, 'negative') AS polarity, COALESCE(i.severity, 'n/a') AS severity,
       count(*)::int AS incidents
FROM incidents i
WHERE i.submitted_at >= now() - make_interval(days => %s::int)
GROUP BY 1, 2, 3
ORDER BY incidents DESC, 1, 2, 3
LIMIT %s
"""

OVERVIEW_COUNTS_SQL = """
SELECT metric, value FROM (
  SELECT 1 AS ord, 'physicians_active' AS metric, count(*)::int AS value FROM physicians WHERE current_status = 'active'
  UNION ALL SELECT 2, 'physicians_total', count(*)::int FROM physicians
  UNION ALL SELECT 3, 'hospitals_active', count(*)::int FROM hospitals WHERE is_active
  UNION ALL SELECT 4, 'engagements_open', count(*)::int FROM physician_engagements WHERE status <> 'terminated'
  UNION ALL SELECT 5, 'incidents_open', count(*)::int FROM incidents WHERE status = 'open'
  UNION ALL SELECT 6, 'interventions_total', count(*)::int FROM gov_interventions
  UNION ALL SELECT 7, 'signal_snapshot_days', count(DISTINCT day)::int FROM gov_signal_snapshots
) c ORDER BY ord
"""

# ---------------------------------------------------------------------------------------------
# M1: reads over the studio_ro views (ops/neon/0003_studio_views.sql). Views only, never base tables.
# ---------------------------------------------------------------------------------------------

PHYSICIAN_PRIVILEGES_SQL = """
SELECT v.privilege_id::text AS privilege_id, v.hospital_code, v.procedure_or_specialty, v.is_core, v.basis,
       v.granted_date::text AS granted_date, v.expires_at::text AS expires_at, v.withdrawn_date::text AS withdrawn_date
FROM studio_ro.physician_privileges v
WHERE v.physician_id = %s::uuid
ORDER BY (v.withdrawn_date IS NOT NULL), v.is_core DESC, v.procedure_or_specialty
LIMIT %s
"""

PHYSICIAN_OPPE_SQL = """
SELECT v.review_id::text AS review_id, v.hospital_code, v.period_start::text AS period_start, v.period_end::text AS period_end,
       v.due_at::date::text AS due_on, v.status, v.completed_at::date::text AS completed_on
FROM studio_ro.physician_oppe v
WHERE v.physician_id = %s::uuid
ORDER BY v.due_at DESC
LIMIT %s
"""

PHYSICIAN_METRICS_SQL = """
SELECT v.hospital_code, v.year, v.month, v.opd_count, v.ipd_admissions, v.ot_cases, v.revenue_inr
FROM studio_ro.physician_metrics v
WHERE v.physician_id = %s::uuid
  AND make_date(v.year, v.month, 1) >= (date_trunc('month', current_date) - make_interval(months => %s::int))::date
ORDER BY v.year DESC, v.month DESC, v.hospital_code
LIMIT %s
"""

PHYSICIAN_QUALIFICATIONS_SQL = """
SELECT v.qualification_id::text AS qualification_id, v.degree, v.institution_tier, v.year_completed, v.country,
       v.verified, v.verified_at::date::text AS verified_on
FROM studio_ro.physician_qualifications v
WHERE v.physician_id = %s::uuid
ORDER BY v.year_completed DESC NULLS LAST, v.degree
LIMIT %s
"""

CAPTURE_GAPS_SQL = """
SELECT v.gap_id::text AS gap_id, v.title, v.attr, v.status, v.baseline_mean, v.shipped_at::text AS shipped_on
FROM studio_ro.capture_gaps v
ORDER BY v.status, v.title
LIMIT %s
"""

# Feedback counts per physician: source/polarity/severity/status only (the view has no narrative or reporter).
# The view is bucketed by month, so the window starts at the first day of the month that contains today - N days.
FEEDBACK_BY_PHYSICIAN_SQL = """
SELECT v.source, v.polarity, v.severity, v.status, sum(v.incidents)::int AS incidents
FROM studio_ro.physician_feedback v
WHERE v.physician_id = %s::uuid
  AND v.month >= date_trunc('month', current_date - %s::int)::date
  AND (%s::text IS NULL OR v.source = %s::text)
GROUP BY v.source, v.polarity, v.severity, v.status
ORDER BY incidents DESC, v.source, v.polarity, v.severity, v.status
LIMIT %s
"""

# The ONLY views the M1 tools touch (ops/neon/0003_studio_views.sql grants SELECT on exactly these).
STUDIO_RO_VIEWS = (
    "physician_privileges",
    "physician_oppe",
    "physician_metrics",
    "physician_qualifications",
    "capture_gaps",
    "physician_feedback",
)

# The ONLY tables the read tools touch. ops/neon/0001_roles.sql grants SELECT on exactly these (a test
# asserts the SQL grant list, this tuple, the tools' FROM/JOIN tables and the live probe agree).
GOVERNANCE_TABLES = (
    "physicians",
    "physician_engagements",
    "hospitals",
    "gov_signal_snapshots",
    "gov_interventions",
    "incidents",
)

ALL_SQL = {
    "list_physicians": LIST_PHYSICIANS_SQL,
    "physician_profile": PHYSICIAN_PROFILE_SQL,
    "signal_snapshots": SIGNAL_SNAPSHOTS_SQL,
    "interventions": INTERVENTIONS_SQL,
    "incident_summary": INCIDENT_SUMMARY_SQL,
    "overview_counts": OVERVIEW_COUNTS_SQL,
    "physician_privileges": PHYSICIAN_PRIVILEGES_SQL,
    "physician_oppe": PHYSICIAN_OPPE_SQL,
    "physician_metrics": PHYSICIAN_METRICS_SQL,
    "physician_qualifications": PHYSICIAN_QUALIFICATIONS_SQL,
    "capture_gaps": CAPTURE_GAPS_SQL,
    "feedback_by_physician": FEEDBACK_BY_PHYSICIAN_SQL,
}

_FORBIDDEN = re.compile(
    r"\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do|merge|vacuum|set|lock|listen|notify)\b",
    re.IGNORECASE,
)


def assert_read_only(sql: str) -> None:
    """Only a single SELECT/WITH statement may reach the connection."""
    stripped = sql.strip().rstrip(";").strip()
    if not re.match(r"^(select|with)\b", stripped, re.IGNORECASE) or ";" in stripped or _FORBIDDEN.search(stripped):
        raise ValueError("studio tools are read-only: statement refused")


def query_hash(tool_name: str, sql: Optional[str] = None) -> str:
    return hashlib.sha256((sql or ALL_SQL[tool_name]).encode()).hexdigest()[:12]


def like_pattern(text: str) -> str:
    escaped = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


# ---------------------------------------------------------------------------------------------
# Runtime plumbing
# ---------------------------------------------------------------------------------------------


class ToolError(Exception):
    """Message is safe to show the model/user (no data, no secrets)."""


def live_reads_enabled() -> bool:
    """Read on EVERY call (no redeploy). Unset = live; 0/false/off/no/empty = fixtures."""
    value = os.environ.get("STUDIO_LIVE_READS")
    if value is None:
        return True
    return value.strip().lower() not in {"", "0", "false", "off", "no"}


def staff_id_from(config: Optional[RunnableConfig]) -> str:
    staff = ((config or {}).get("configurable") or {}).get(STAFF_KEY)
    if not isinstance(staff, str) or not staff:
        raise ToolError("Governance tools are unavailable: no authenticated staff identity on this run.")
    return staff


def _json_safe(value: Any) -> Any:
    if isinstance(value, (dt.date, dt.datetime)):
        return value.isoformat()
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, decimal.Decimal):
        return float(value)
    return value


async def _fetch_rows_pg(sql: str, params: tuple) -> list[dict]:
    assert_read_only(sql)
    conn = await connect_read_only()
    try:
        cur = await conn.execute(sql, params)
        return await cur.fetchall()
    finally:
        await conn.close()


# Replaceable (tests inject a recorder).
fetch_rows = _fetch_rows_pg


def load_fixture(tool_name: str, limit: Optional[int] = None, offset: int = 0) -> list[dict]:
    # tool_name may carry a subdirectory ("docaudits/x"): only the six top-level fixtures belong to ALL_SQL.
    path = FIXTURE_DIR / f"{tool_name}.json"
    try:
        rows = json.loads(path.read_text())["rows"]
    except (OSError, ValueError, KeyError):
        raise ToolError("Fixture data for this tool is not available.") from None
    rows = rows[offset:]
    return rows[:limit] if limit else rows


async def run_read_tool(
    tool_name: str,
    params: dict[str, Any],
    sql_params: tuple,
    config: Optional[RunnableConfig],
    limit: Optional[int],
    offset: int = 0,
    sql: Optional[str] = None,
    fixture: Optional[str] = None,
) -> str:
    """Execute (live or fixture), audit, and return the typed table payload as JSON.

    `sql` / `fixture`: tools outside ALL_SQL (other modules' read tools) pass their own fixed SQL text and fixture
    name; everything else (audit, kill switch, source line) is shared."""
    statement = sql or ALL_SQL[tool_name]
    staff_id = staff_id_from(config)
    started = time.monotonic()
    live = live_reads_enabled()
    mode = "live" if live else "fixture"

    async def audit(row_count: int, outcome: str) -> None:
        await studio_audit.audit_sink(
            studio_audit.AuditRow(
                staff_id=staff_id,
                tool=tool_name,
                params_hash=studio_audit.params_hash(params),
                row_count=row_count,
                duration_ms=int((time.monotonic() - started) * 1000),
                mode=mode,
                outcome=outcome,
            )
        )

    failure: Optional[str] = None
    rows: list[dict] = []
    try:
        if live:
            raw = await fetch_rows(statement, sql_params)
            rows = [{k: _json_safe(v) for k, v in dict(r).items()} for r in raw]
        else:
            rows = load_fixture(fixture or tool_name, limit, offset)
    except ToolError as exc:
        failure = str(exc)
    except PinError:
        logger.warning("tool=%s failed: no pinned database address", tool_name)
        failure = "The governance database address is not pinned, so this read was refused."
    except Exception as exc:  # DB/driver error: never leak its text (can embed hostnames/DSN fragments)
        logger.warning("tool=%s failed type=%s", tool_name, type(exc).__name__)
        failure = "The governance database read failed."
    if failure is not None:
        try:  # a failed read is audited too (row_count 0); an audit failure must not mask the error
            await audit(0, "error")
        except Exception as exc:
            logger.error("tool=%s audit write failed type=%s", tool_name, type(exc).__name__)
        raise ToolError(failure)
    try:
        await audit(len(rows), "ok")
    except Exception as exc:  # fail closed: no audit row, no data
        logger.error("tool=%s audit write failed type=%s", tool_name, type(exc).__name__)
        raise ToolError("The audit log is unavailable, so this read was refused.") from None
    duration_ms = int((time.monotonic() - started) * 1000)
    logger.info("tool=%s staff=%s rows=%d ms=%d mode=%s", tool_name, staff_id, len(rows), duration_ms, "live" if live else "fixture")
    # A paged tool selects `count(*) OVER () AS total_count` (matches before LIMIT/OFFSET); it is the payload's
    # `total`, not a column. Past the last page there are no rows, so no total.
    total = rows[0].get("total_count") if rows else None
    for r in rows:
        r.pop("total_count", None)
    columns = list(rows[0].keys()) if rows else []
    return json.dumps(
        {
            "source": {"tool": tool_name, "query_hash": query_hash(tool_name, statement)},
            "mode": "live" if live else "fixture",
            "synthetic": not live,
            "columns": columns,
            "rows": rows,
            "row_count": len(rows),
            **({"total": total} if isinstance(total, int) else {}),
        }
    )


# ---------------------------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------------------------

Limit = Field(default=50, ge=1, le=MAX_LIMIT, description="Maximum rows (1-200).")
WindowDays = Field(default=30, ge=1, le=365, description="Look-back window in days (1-365).")


class PhysicianFilter(BaseModel):
    status: Optional[Literal["active", "inactive", "terminated"]] = None
    specialty_contains: Optional[str] = Field(default=None, max_length=80)
    name_contains: Optional[str] = Field(default=None, max_length=80)
    hospital_code: Optional[str] = Field(default=None, max_length=40)


class ListPhysiciansArgs(BaseModel):
    filter: PhysicianFilter = Field(default_factory=PhysicianFilter)
    limit: int = Limit
    offset: int = Field(default=0, ge=0, le=MAX_OFFSET, description="Rows to skip (paging); the result's `total` is the match count.")


class PhysicianIdArgs(BaseModel):
    physician_id: uuid.UUID = Field(description="Physician id (uuid) from list_physicians.")


class SignalSnapshotsArgs(BaseModel):
    physician_id: Optional[uuid.UUID] = None
    window_days: int = WindowDays
    limit: int = Limit


class InterventionsArgs(BaseModel):
    physician_id: Optional[uuid.UUID] = None
    limit: int = Limit


class IncidentSummaryArgs(BaseModel):
    window_days: int = WindowDays


class NoArgs(BaseModel):
    pass


class PhysicianLimitArgs(BaseModel):
    physician_id: uuid.UUID = Field(description="Physician id (uuid) from list_physicians.")
    limit: int = Limit


class PhysicianMetricsArgs(BaseModel):
    physician_id: uuid.UUID = Field(description="Physician id (uuid) from list_physicians.")
    months: int = Field(default=12, ge=1, le=60, description="Look-back in months (1-60).")
    limit: int = Limit


class LimitArgs(BaseModel):
    limit: int = Limit


class FeedbackByPhysicianArgs(BaseModel):
    physician_id: uuid.UUID = Field(description="Physician id (uuid) from list_physicians.")
    window_days: int = Field(default=365, ge=1, le=1825, description="Look-back window in days (1-1825).")
    source: Optional[Literal["patient", "peer", "governance", "external_public"]] = None
    limit: int = Limit


@tool(args_schema=ListPhysiciansArgs)
async def list_physicians(
    filter: PhysicianFilter = PhysicianFilter(), limit: int = 50, offset: int = 0, config: RunnableConfig = None
) -> str:  # noqa: A002
    """List physicians (id, name, specialty, status, hospitals). Read-only, up to 200 rows per page; use `offset`
    to page, and the result's `total` for the match count.
    The result is a table with a `source`; present it with the table component, do not retype it."""
    f = filter if isinstance(filter, PhysicianFilter) else PhysicianFilter.model_validate(filter)
    spec = like_pattern(f.specialty_contains) if f.specialty_contains else None
    name = like_pattern(f.name_contains) if f.name_contains else None
    sql_params = (f.status, f.status, spec, spec, name, name, f.hospital_code, f.hospital_code, limit, offset)
    params = {"filter": f.model_dump(), "limit": limit, "offset": offset}
    return await run_read_tool("list_physicians", params, sql_params, config, limit, offset)


@tool(args_schema=PhysicianIdArgs)
async def physician_profile(physician_id: uuid.UUID, config: RunnableConfig = None) -> str:
    """One physician's profile: specialty, status, join date, council and registration expiry, engagements.
    No contact details or registration number. Read-only."""
    pid = str(physician_id)
    return await run_read_tool("physician_profile", {"physician_id": pid}, (pid,), config, 1)


@tool(args_schema=SignalSnapshotsArgs)
async def signal_snapshots(
    physician_id: Optional[uuid.UUID] = None, window_days: int = 30, limit: int = 50, config: RunnableConfig = None
) -> str:
    """Governance signal snapshots (one row per day and signal: severity, trend, scope, counts) in the
    last `window_days`. With physician_id, only signals that list that physician as affected. Read-only."""
    pid = str(physician_id) if physician_id else None
    return await run_read_tool(
        "signal_snapshots", {"physician_id": pid, "window_days": window_days, "limit": limit}, (pid, window_days, pid, limit), config, limit
    )


@tool(args_schema=InterventionsArgs)
async def interventions(physician_id: Optional[uuid.UUID] = None, limit: int = 50, config: RunnableConfig = None) -> str:
    """Recorded governance interventions (date, signal, kind, action, sync state); no free-text notes. Read-only."""
    pid = str(physician_id) if physician_id else None
    return await run_read_tool("interventions", {"physician_id": pid, "limit": limit}, (pid, pid, limit), config, limit)


@tool(args_schema=IncidentSummaryArgs)
async def incident_summary(window_days: int = 30, config: RunnableConfig = None) -> str:
    """Patient feedback counts by status, polarity and severity in the last `window_days`. Counts only: no
    narratives, names or reporters. Read-only."""
    return await run_read_tool("incident_summary", {"window_days": window_days}, (window_days, MAX_LIMIT), config, MAX_LIMIT)


@tool(args_schema=NoArgs)
async def overview_counts(config: RunnableConfig = None) -> str:
    """Headline governance counts (physicians, hospitals, open engagements and patient feedback items, interventions,
    snapshot days). Read-only."""
    return await run_read_tool("overview_counts", {}, (), config, None)


class ToolErrorToResult(AgentMiddleware):
    """A failed read is a tool RESULT the model can see, not an abort of the whole chat run.

    create_agent's ToolNode re-raises every error except its own validation errors, so without this one
    failing tool (and every sibling call in the same turn) ends the run. ToolError text is safe by
    contract (fixed strings). The screen door (studio_screen.py) calls the tools directly and still
    sees the exception."""

    async def awrap_tool_call(self, request, handler):
        try:
            return await handler(request)
        except ToolError as exc:
            return ToolMessage(content=str(exc), name=request.tool_call["name"], tool_call_id=request.tool_call["id"], status="error")

    def wrap_tool_call(self, request, handler):
        try:
            return handler(request)
        except ToolError as exc:
            return ToolMessage(content=str(exc), name=request.tool_call["name"], tool_call_id=request.tool_call["id"], status="error")


@tool(args_schema=PhysicianLimitArgs)
async def physician_privileges(physician_id: uuid.UUID, limit: int = 50, config: RunnableConfig = None) -> str:
    """One physician's clinical privileges (hospital, procedure or specialty, core or special, basis, grant
    and expiry dates, withdrawal date). No withdrawal reasons. Read-only."""
    pid = str(physician_id)
    return await run_read_tool("physician_privileges", {"physician_id": pid, "limit": limit}, (pid, limit), config, limit)


@tool(args_schema=PhysicianLimitArgs)
async def physician_oppe(physician_id: uuid.UUID, limit: int = 50, config: RunnableConfig = None) -> str:
    """One physician's OPPE reviews (hospital, period, due date, status, completion date). No reviewer
    notes or review packets. Read-only."""
    pid = str(physician_id)
    return await run_read_tool("physician_oppe", {"physician_id": pid, "limit": limit}, (pid, limit), config, limit)


@tool(args_schema=PhysicianMetricsArgs)
async def physician_metrics(physician_id: uuid.UUID, months: int = 12, limit: int = 50, config: RunnableConfig = None) -> str:
    """One physician's monthly clinical volumes (OPD count, IPD admissions, OT cases, revenue) by hospital
    for the last `months` months. No uploaded file names. Read-only."""
    pid = str(physician_id)
    return await run_read_tool("physician_metrics", {"physician_id": pid, "months": months, "limit": limit}, (pid, months, limit), config, limit)


@tool(args_schema=PhysicianLimitArgs)
async def physician_qualifications(physician_id: uuid.UUID, limit: int = 50, config: RunnableConfig = None) -> str:
    """One physician's qualifications (degree, institution tier, year, country, verified or not). No
    institution names or certificate files. Read-only."""
    pid = str(physician_id)
    return await run_read_tool("physician_qualifications", {"physician_id": pid, "limit": limit}, (pid, limit), config, limit)


@tool(args_schema=LimitArgs)
async def capture_gaps(limit: int = 50, config: RunnableConfig = None) -> str:
    """OPD documentation capture gaps (title, attribute, status, baseline score, shipped date); not per
    physician; no notes. Read-only."""
    return await run_read_tool("capture_gaps", {"limit": limit}, (limit,), config, limit)


@tool(args_schema=FeedbackByPhysicianArgs)
async def feedback_by_physician(
    physician_id: uuid.UUID, window_days: int = 365, source: Optional[str] = None, limit: int = 50, config: RunnableConfig = None
) -> str:
    """Feedback counts for ONE physician by source, polarity, severity and status in the last `window_days`.
    Counts only: no narratives, reporters or patient references. Use source="patient" for patient
    feedback. Read-only."""
    pid = str(physician_id)
    return await run_read_tool(
        "feedback_by_physician",
        {"physician_id": pid, "window_days": window_days, "source": source, "limit": limit},
        (pid, window_days, source, source, limit),
        config,
        limit,
    )


VIEW_TOOLS = [physician_privileges, physician_oppe, physician_metrics, physician_qualifications, capture_gaps, feedback_by_physician]
VIEW_TOOL_NAMES = tuple(t.name for t in VIEW_TOOLS)


GOVERNANCE_TOOLS = [list_physicians, physician_profile, signal_snapshots, interventions, incident_summary, overview_counts, *VIEW_TOOLS]
GOVERNANCE_TOOL_NAMES = [t.name for t in GOVERNANCE_TOOLS]
