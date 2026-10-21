"""Document-audit read tools (M2 document-audits screen).

Same contract as studio_tools.py (typed args, fixed parameterised SQL, staff id from the graph config, one
studio_audit row per call, STUDIO_LIVE_READS kill switch, source line + query hash), via run_read_tool.

Data: the column-scoped views studio_ro.document_audit_list and studio_ro.document_audit_finding_list
(ops/neon/0004_docaudits_views.sql), plus physicians for the doctor's name and specialty. The base tables
document_audits / document_audit_findings are NOT granted to the read role. Never selected: finding_body,
doctor_response_comment, evidence_excerpt, citations, patient context, CDMSS sync error text, PDF url, doctor uid,
the RMO's name. All writes (authoring, release to portal) stay in even-elo's RMO inbox routes; nothing here writes.
"""

from __future__ import annotations

import uuid
from typing import Literal, Optional

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool
from pydantic import BaseModel, Field

from src.studio_tools import MAX_LIMIT, MAX_OFFSET, Limit, run_read_tool

OPEN_STATUSES = "('open','in_progress','contested','escalated')"
SEVERITY_RANK = "CASE x.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END"

LIST_DOCUMENT_AUDITS_SQL = f"""
SELECT a.audit_id::text AS audit_id, a.external_ref, a.hospital_code, a.physician_id::text AS physician_id,
       p.full_name, p.primary_specialty, a.doc_type, a.doc_day::text AS doc_day,
       a.ingested_at::date::text AS ingested_on, a.has_pdf, (a.triage_routed_at IS NOT NULL) AS routed,
       COALESCE(f.findings, 0) AS findings, COALESCE(f.open_findings, 0) AS open_findings,
       COALESCE(f.top_severity, 'none') AS top_severity,
       count(*) OVER () AS total_count
FROM studio_ro.document_audit_list a
JOIN physicians p ON p.id = a.physician_id
LEFT JOIN LATERAL (
      SELECT count(*)::int AS findings,
             count(*) FILTER (WHERE x.status IN {OPEN_STATUSES})::int AS open_findings,
             (array_agg(x.severity ORDER BY {SEVERITY_RANK}))[1] AS top_severity
      FROM studio_ro.document_audit_finding_list x WHERE x.audit_id = a.audit_id
    ) f ON TRUE
WHERE (%s::text IS NULL OR a.hospital_code = %s::text)
  AND (%s::uuid IS NULL OR a.physician_id = %s::uuid)
  AND (%s::text IS NULL OR a.doc_type = %s::text)
  AND (%s::text IS NULL OR EXISTS (SELECT 1 FROM studio_ro.document_audit_finding_list x WHERE x.audit_id = a.audit_id AND x.severity = %s::text))
  AND (%s::text IS NULL OR EXISTS (SELECT 1 FROM studio_ro.document_audit_finding_list x WHERE x.audit_id = a.audit_id AND x.status = %s::text))
  AND (%s::text IS NULL OR p.full_name ILIKE %s::text ESCAPE '\\')
ORDER BY a.ingested_at DESC, a.audit_id
LIMIT %s OFFSET %s
"""

# One row per finding (an audit with no findings yields one row with empty finding columns).
DOCUMENT_AUDIT_DETAIL_SQL = """
SELECT a.audit_id::text AS audit_id, a.external_ref, a.hospital_code, a.physician_id::text AS physician_id,
       p.full_name, p.primary_specialty, a.doc_type, a.doc_day::text AS doc_day,
       a.ingested_at::date::text AS ingested_on, a.has_pdf, a.triage_routed_at::date::text AS routed_on,
       f.finding_id::text AS finding_id, f.finding_label, f.severity, f.status, f.author_confirmed,
       f.authored_at::date::text AS authored_on, f.recurrence_count, f.portal_visible, f.response_owner,
       f.signal_reference, f.response_verb, f.responded_at::date::text AS responded_on, f.sync_state
FROM studio_ro.document_audit_list a
JOIN physicians p ON p.id = a.physician_id
LEFT JOIN studio_ro.document_audit_finding_list f ON f.audit_id = a.audit_id
WHERE a.audit_id = %s::uuid
ORDER BY f.authored_at DESC NULLS LAST, f.finding_id
LIMIT %s
"""

DOCUMENT_AUDIT_DOCTOR_ROLLUP_SQL = f"""
SELECT f.physician_id::text AS physician_id, p.full_name, p.primary_specialty,
       count(DISTINCT f.audit_id)::int AS audits, count(*)::int AS findings,
       (count(*) FILTER (WHERE f.status IN {OPEN_STATUSES}))::int AS open_findings,
       (count(*) FILTER (WHERE f.severity IN ('critical', 'high') AND f.status IN {OPEN_STATUSES}))::int AS critical_high_open,
       (count(*) FILTER (WHERE f.status = 'contested'))::int AS contested,
       (count(*) FILTER (WHERE f.response_verb IS NOT NULL))::int AS responded,
       max(f.authored_at)::date::text AS last_finding_on,
       count(*) OVER () AS total_count
FROM studio_ro.document_audit_finding_list f
JOIN studio_ro.document_audit_list a ON a.audit_id = f.audit_id
JOIN physicians p ON p.id = f.physician_id
WHERE (%s::text IS NULL OR a.hospital_code = %s::text)
  AND a.ingested_at >= now() - make_interval(days => %s::int)
GROUP BY f.physician_id, p.full_name, p.primary_specialty
ORDER BY open_findings DESC, p.full_name, f.physician_id
LIMIT %s OFFSET %s
"""

DOCUMENT_AUDIT_HEADLINE_SQL = f"""
SELECT metric, value FROM (
  SELECT 1 AS ord, 'audits_total' AS metric, count(*)::int AS value
    FROM studio_ro.document_audit_list a WHERE (%s::text IS NULL OR a.hospital_code = %s::text)
  UNION ALL SELECT 2, 'findings_total', count(*)::int
    FROM studio_ro.document_audit_finding_list f JOIN studio_ro.document_audit_list a ON a.audit_id = f.audit_id
    WHERE (%s::text IS NULL OR a.hospital_code = %s::text)
  UNION ALL SELECT 3, 'findings_open', count(*)::int
    FROM studio_ro.document_audit_finding_list f JOIN studio_ro.document_audit_list a ON a.audit_id = f.audit_id
    WHERE f.status IN {OPEN_STATUSES} AND (%s::text IS NULL OR a.hospital_code = %s::text)
  UNION ALL SELECT 4, 'critical_high_open', count(*)::int
    FROM studio_ro.document_audit_finding_list f JOIN studio_ro.document_audit_list a ON a.audit_id = f.audit_id
    WHERE f.severity IN ('critical', 'high') AND f.status IN {OPEN_STATUSES} AND (%s::text IS NULL OR a.hospital_code = %s::text)
  UNION ALL SELECT 5, 'doctors_with_findings', count(DISTINCT f.physician_id)::int
    FROM studio_ro.document_audit_finding_list f JOIN studio_ro.document_audit_list a ON a.audit_id = f.audit_id
    WHERE (%s::text IS NULL OR a.hospital_code = %s::text)
  UNION ALL SELECT 6, 'findings_responded', count(*)::int
    FROM studio_ro.document_audit_finding_list f JOIN studio_ro.document_audit_list a ON a.audit_id = f.audit_id
    WHERE f.response_verb IS NOT NULL AND (%s::text IS NULL OR a.hospital_code = %s::text)
  UNION ALL SELECT 7, 'days_since_last_ingest', (current_date - max(a.ingested_at)::date)::int
    FROM studio_ro.document_audit_list a WHERE (%s::text IS NULL OR a.hospital_code = %s::text)
) c ORDER BY ord
"""

DOCAUDIT_SQL = {
    "list_document_audits": LIST_DOCUMENT_AUDITS_SQL,
    "document_audit_detail": DOCUMENT_AUDIT_DETAIL_SQL,
    "document_audit_doctor_rollup": DOCUMENT_AUDIT_DOCTOR_ROLLUP_SQL,
    "document_audit_headline": DOCUMENT_AUDIT_HEADLINE_SQL,
}
# Tables/views these tools touch (the role holds SELECT on the two views and on physicians only).
DOCAUDIT_VIEWS = ("studio_ro.document_audit_list", "studio_ro.document_audit_finding_list")


def _like(text: str) -> str:
    escaped = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _run(name: str, params: dict, sql_params: tuple, config: Optional[RunnableConfig], limit: Optional[int], offset: int = 0):
    return run_read_tool(name, params, sql_params, config, limit, offset, sql=DOCAUDIT_SQL[name], fixture=f"docaudits/{name}")


class DocAuditFilter(BaseModel):
    hospital_code: Optional[str] = Field(default=None, max_length=40)
    physician_id: Optional[uuid.UUID] = None
    doc_type: Optional[Literal["progress", "ot", "discharge"]] = None
    severity: Optional[Literal["critical", "high", "medium", "low"]] = None
    status: Optional[Literal["open", "in_progress", "remediated", "contested", "escalated"]] = None
    doctor_name_contains: Optional[str] = Field(default=None, max_length=80)


class ListDocumentAuditsArgs(BaseModel):
    filter: DocAuditFilter = Field(default_factory=DocAuditFilter)
    limit: int = Limit
    offset: int = Field(default=0, ge=0, le=MAX_OFFSET, description="Rows to skip (paging); the result's `total` is the match count.")


class DocumentAuditIdArgs(BaseModel):
    audit_id: uuid.UUID = Field(description="Document audit id (uuid) from list_document_audits.")


class DoctorRollupArgs(BaseModel):
    hospital_code: Optional[str] = Field(default=None, max_length=40)
    window_days: int = Field(default=90, ge=1, le=365, description="Audits ingested in the last N days (1-365).")
    limit: int = Limit
    offset: int = Field(default=0, ge=0, le=MAX_OFFSET)


class HeadlineArgs(BaseModel):
    hospital_code: Optional[str] = Field(default=None, max_length=40)


@tool(args_schema=ListDocumentAuditsArgs)
async def list_document_audits(filter: DocAuditFilter = DocAuditFilter(), limit: int = 50, offset: int = 0, config: RunnableConfig = None) -> str:  # noqa: A002
    """Document audits (progress / OT / discharge note audits ingested from CDMSS), newest first: doctor, hospital,
    document type and date, finding counts and top severity. Filters: hospital, doctor id, doc type, finding severity,
    finding status, doctor name. No finding text. Read-only, up to 200 per page; use `offset` and the result's `total`.
    The result is a table with a `source`; present it with the table component, do not retype it."""
    f = filter if isinstance(filter, DocAuditFilter) else DocAuditFilter.model_validate(filter)
    pid = str(f.physician_id) if f.physician_id else None
    name = _like(f.doctor_name_contains) if f.doctor_name_contains else None
    sql_params = (f.hospital_code, f.hospital_code, pid, pid, f.doc_type, f.doc_type, f.severity, f.severity, f.status, f.status, name, name, limit, offset)
    params = {"filter": f.model_dump(mode="json"), "limit": limit, "offset": offset}
    return await _run("list_document_audits", params, sql_params, config, limit, offset)


@tool(args_schema=DocumentAuditIdArgs)
async def document_audit_detail(audit_id: uuid.UUID, config: RunnableConfig = None) -> str:
    """One document audit with its findings (label, severity, status, whether an RMO confirmed authorship, portal
    release, doctor response verb and date, CDMSS sync state). No finding body, doctor comment or evidence text. Read-only."""
    aid = str(audit_id)
    return await _run("document_audit_detail", {"audit_id": aid}, (aid, MAX_LIMIT), config, MAX_LIMIT)


@tool(args_schema=DoctorRollupArgs)
async def document_audit_doctor_rollup(hospital_code: Optional[str] = None, window_days: int = 90, limit: int = 50, offset: int = 0, config: RunnableConfig = None) -> str:
    """Per-doctor roll-up of document-audit findings for audits ingested in the last `window_days`: audits, findings,
    open findings, open critical/high, contested, responded, latest finding date. Sorted by open findings. Read-only."""
    params = {"hospital_code": hospital_code, "window_days": window_days, "limit": limit, "offset": offset}
    return await _run("document_audit_doctor_rollup", params, (hospital_code, hospital_code, window_days, limit, offset), config, limit, offset)


@tool(args_schema=HeadlineArgs)
async def document_audit_headline(hospital_code: Optional[str] = None, config: RunnableConfig = None) -> str:
    """Document-audit headline counts: audits, findings, open findings, open critical/high, doctors with findings,
    findings with a doctor response, days since the last ingest. Optional hospital. Read-only."""
    return await _run("document_audit_headline", {"hospital_code": hospital_code}, (hospital_code,) * 14, config, None)


DOCAUDIT_TOOLS = [list_document_audits, document_audit_detail, document_audit_doctor_rollup, document_audit_headline]
DOCAUDIT_TOOL_NAMES = [t.name for t in DOCAUDIT_TOOLS]
