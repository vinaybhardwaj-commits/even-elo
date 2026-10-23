"""CDMSS module read tools (Phase 1): catalogue metrics (T1), drill-downs (T2) and the view payloads for V1-V5 and V8.

Same contract as studio_tools.py / studio_docaudit_tools.py: typed args, FIXED SQL (the model never supplies SQL text), the staff
id from the graph config, one studio_audit row per query (the SQL hash is part of params_hash), the STUDIO_LIVE_READS kill
switch, only SELECT/WITH reaches a connection, errors are fixed strings. Nothing here writes.

Data: schema cdmss_ro through connect_cdmss_read_only() (ops/cdmss/0002_cdmss_ro_views.sql; the views already apply the canonical-row
rule and excluded_reason IS NULL, so no query here aggregates a base table) and, for denominators and doctor identity, the governance
connection (studio_ro.dw_* views, physicians / physician_engagements / hospitals). The JSON shapes are in .bc/CONTRACT.md.

Every number leaves through stat(): numerator, denominator, n, window, definition id, interval, min-n gating and coverage greying are
applied in one place so no view can skip them. Statistics are plain: Wilson 95% intervals for proportions, normal intervals for means,
funnel limits at z = 1.96 / 3.09 (binomial, the catalogue's method: no overdispersion adjustment).
"""

from __future__ import annotations

import asyncio
import copy
import datetime as dt
import hashlib
import json
import logging
import math
import os
import re
import time
import weakref
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal, Optional

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool
from pydantic import BaseModel, Field

from src import studio_audit
from src.clock import KOLKATA
from src.studio_db import NotConfigured, connect_cdmss_read_only, connect_read_only
from src.studio_pins import PinError
from src.studio_tools import MAX_OFFSET, ToolError, _json_safe, assert_read_only, live_reads_enabled, staff_id_from

logger = logging.getLogger("studio.cdmss")

DOCTOR_MIN_N = 10  # doctor rows
GROUP_MIN_N = 15  # site / specialty groups
SITE_COMPARISON_MIN_COVERAGE = 0.90  # share of window notes whose doctor has exactly one home site; below it every site comparison is withheld (ruling, 23 Oct)
POOL_PER_DB = 2  # pgbouncer relay pool_size per database: concurrent queries of one call never exceed it
CACHE_MAX_ENTRIES = 256  # LRU cap (drilldown / finding_detail keys grow per uid and offset)
CACHE_TTL_S = 300  # finished payloads are reused for 5 minutes (same tool, same normalised params, same IST day)
FUNNEL_MIN_N = 50  # funnel inclusion (audited notes)
COVERAGE_GREY_PCT = 50.0
SCAN_CAP = 50_000  # rows an aggregate may scan
LIST_CAP = 500
Z95, Z998 = 1.96, 3.09
BANDS = ("A", "B", "C", "D", "E")
R5_RULE_REF = "ehrc-f283f2c4-7739-46e2-b5c8-997d89a79f5c"  # ratified R5 "antibiotic for acute upper-respiratory illness" (catalogue M-AMS-03)
CASE_BASE_DEFAULT = "https://even-cdmss.vercel.app"
APP_SOURCE_DEFAULT = "standalone"  # the catalogue's APP_SOURCE (C-2) default; override with CDMSS_APP_SOURCE. Live value UNVERIFIED.
ENGINE_FAMILY = "opd-note-audit/0.81.3+ (derived by shape in cdmss_ro.opd_note_audit)"

PRECISION_LINE = "About 1 in 5 findings are wrong or contested (engine precision; the catalogue has no family-specific figure)."
C7_CAVEATS = (
    "The score is an encounter proxy, not a clinician scorecard.",
    "Notes where PDQI-9 was not assessed score 0 on note quality, which raises the index, so full NQI is shown over assessed notes only.",
    "Underuse findings carry zero penalty.",
)
NO_DB_SOURCE = "metric catalogue (module definitions; no database read)"
DB13_LAG_CAVEAT = "Per-1,000-Rx figures count only notes already in the DB13 extract (with a medication line), in numerator and denominator alike: notes newer than 'DB13 as of' are excluded."
SITE_CAVEAT = "OPD site is the doctor's home site (governance DB engagement), not where the note was written."


# --------------------------------------------------------------------------------------------------------------
# Statistics (pure)
# --------------------------------------------------------------------------------------------------------------


def _phi(z: float) -> float:
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def wilson(k: float, n: float, z: float = Z95) -> Optional[tuple[float, float]]:
    """Wilson score interval for k successes in n trials; None when n <= 0."""
    if n <= 0:
        return None
    p = k / n
    d = 1.0 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, centre - half), min(1.0, centre + half)


def mean_sd(n: float, s: float, ss: float) -> tuple[Optional[float], Optional[float]]:
    if n <= 0:
        return None, None
    m = s / n
    if n < 2:
        return m, None
    return m, math.sqrt(max((ss - s * s / n) / (n - 1), 0.0))


def mean_ci(n: float, s: float, ss: float, z: float = Z95) -> Optional[tuple[float, float]]:
    m, sd = mean_sd(n, s, ss)
    if m is None or sd is None:
        return None
    half = z * sd / math.sqrt(n)
    return m - half, m + half


def funnel_limit(p_bar: float, n: float, z: float) -> tuple[float, float]:
    """p_bar +/- z*sqrt(p_bar(1-p_bar)/n), clamped to [0,1] (lib/opd-funnel-core.ts funnelLimit)."""
    if n <= 0:
        return p_bar, p_bar
    half = z * math.sqrt(p_bar * (1 - p_bar) / n)
    return max(0.0, p_bar - half), min(1.0, p_bar + half)


def two_sided_p(z: float) -> float:
    return 2.0 * (1.0 - _phi(abs(z)))


def prop_change_p(k1: float, n1: float, k2: float, n2: float) -> Optional[float]:
    if n1 <= 0 or n2 <= 0:
        return None
    pool = (k1 + k2) / (n1 + n2)
    se = math.sqrt(pool * (1 - pool) * (1 / n1 + 1 / n2))
    if se == 0:
        return 1.0 if k1 / n1 == k2 / n2 else 0.0
    return two_sided_p((k2 / n2 - k1 / n1) / se)


def mean_change_p(n1, s1, ss1, n2, s2, ss2) -> Optional[float]:
    m1, sd1 = mean_sd(n1, s1, ss1)
    m2, sd2 = mean_sd(n2, s2, ss2)
    if m1 is None or m2 is None or sd1 is None or sd2 is None:
        return None
    se = math.sqrt(sd1 * sd1 / n1 + sd2 * sd2 / n2)
    if se == 0:
        return 1.0 if m1 == m2 else 0.0
    return two_sided_p((m2 - m1) / se)


def rate_change_p(e1: float, n1: float, e2: float, n2: float) -> Optional[float]:
    """Events per note, Poisson z on the difference of the two rates."""
    if n1 <= 0 or n2 <= 0:
        return None
    r1, r2 = e1 / n1, e2 / n2
    var = r1 / n1 + r2 / n2
    if var == 0:
        return 1.0 if r1 == r2 else 0.0
    return two_sided_p((r2 - r1) / math.sqrt(var))


SMALL_CHANGE = "small change (under 10%)"


def classify_change(early: Optional[float], late: Optional[float], p: Optional[float]) -> tuple[str, Optional[float]]:
    """'rising'/'falling' only if p < 0.05 AND relative change >= 10%. p < 0.05 with a smaller change is 'small change (under 10%)';
    'no clear change' is kept for p >= 0.05 (or nothing to compare)."""
    if early is None or late is None or p is None or early == 0:
        return "no clear change", None
    rel = (late - early) / abs(early)
    if p < 0.05 and abs(rel) >= 0.10:
        return ("rising" if late > early else "falling"), rel
    if p < 0.05:
        return SMALL_CHANGE, rel
    return "no clear change", rel


def raw_band(score: Optional[float]) -> Optional[str]:
    if score is None:
        return None
    return "A" if score >= 85 else "B" if score >= 70 else "C" if score >= 55 else "D" if score >= 40 else "E"


def plain_rate(v: Optional[float], per: int, noun: str) -> Optional[str]:
    """Gloss for a value that is already per `per` (per 100 notes, per 1,000 prescriptions): 80.63 per 100 -> 'about 81 in every 100 notes'."""
    if v is None:
        return None
    return f"about {v:,.0f} in every {per:,} {noun}"


def plain_findings_per_100(v: Optional[float]) -> Optional[str]:
    """Findings per 100 notes can exceed 100 and is not a share: 80.63 -> 'about 81 findings per 100 notes'."""
    return None if v is None else f"about {v:,.0f} findings per 100 notes"


def plain_in_ten(p: Optional[float]) -> Optional[str]:
    """p as a fraction 0-1 -> 'about 3 in 10'."""
    if p is None:
        return None
    k = round(p * 10)
    if k <= 0:
        return "fewer than 1 in 20" if p < 0.05 else "about 1 in 20"
    if k >= 10:
        return "nearly all"
    return f"about {k} in 10"


# --------------------------------------------------------------------------------------------------------------
# Windows
# --------------------------------------------------------------------------------------------------------------


def now_ist() -> dt.datetime:  # replaceable in tests
    return dt.datetime.now(KOLKATA)


@dataclass(frozen=True)
class Window:
    frm: dt.date
    to: dt.date

    @property
    def days(self) -> int:
        return (self.to - self.frm).days + 1

    def as_dict(self) -> dict:
        return {"from": self.frm.isoformat(), "to": self.to.isoformat(), "days": self.days, "tz": "Asia/Kolkata", "anchor": "today (IST calendar days, inclusive)"}


def window_pair(days: int, today: dt.date) -> tuple[Window, Window]:
    late = Window(today - dt.timedelta(days=days - 1), today)
    early = Window(today - dt.timedelta(days=2 * days - 1), today - dt.timedelta(days=days))
    return late, early


# --------------------------------------------------------------------------------------------------------------
# Access to the databases (replaceable in tests), audit
# --------------------------------------------------------------------------------------------------------------


async def _fetch_cdmss(sql: str, params: dict) -> list[dict]:
    assert_read_only(sql)
    conn = await connect_cdmss_read_only()
    try:
        cur = await conn.execute(sql, params)
        return await cur.fetchall()
    finally:
        await conn.close()


async def _fetch_gov(sql: str, params: dict) -> list[dict]:
    assert_read_only(sql)
    conn = await connect_read_only()
    try:
        cur = await conn.execute(sql, params)
        return await cur.fetchall()
    finally:
        await conn.close()


fetch_cdmss = _fetch_cdmss
fetch_gov = _fetch_gov


_SEMS: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()


def _semaphores() -> dict:
    """One semaphore per database per event loop (a loop is the process in production; tests use a loop each)."""
    loop = asyncio.get_running_loop()
    sems = _SEMS.get(loop)
    if sems is None:
        sems = _SEMS[loop] = {"cdmss": asyncio.Semaphore(POOL_PER_DB), "gov": asyncio.Semaphore(POOL_PER_DB)}
    return sems


async def gather_all(*coros: Awaitable) -> list:
    """asyncio.gather that does not leave siblings running (and auditing) after one fails: they are cancelled and awaited."""
    tasks = [asyncio.ensure_future(c) for c in coros]
    try:
        return list(await asyncio.gather(*tasks))
    except BaseException:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise


class Run:
    """One tool call: staff identity, the IST 'today', the audited query runner and the provenance it accumulates."""

    def __init__(self, tool_name: str, params: dict, config: Optional[RunnableConfig]):
        self.tool, self.params = tool_name, params
        self.staff = staff_id_from(config)
        if not live_reads_enabled():
            raise ToolError("CDMSS tools have no fixtures: live reads are switched off.")
        self.today = now_ist().date()
        self.app_source = os.environ.get("CDMSS_APP_SOURCE") or APP_SOURCE_DEFAULT
        self.sql: list[str] = []
        self.hashes: list[str] = []
        self.sources: list[str] = []
        self.cutoffs: list[Any] = []
        self.versions: set[str] = set()
        self.db13_as_of: Optional[str] = None
        self.incomplete: list[str] = []
        # Independent queries run together but never more than the relay pool can serve: the limit is process-wide (all concurrent calls share it).
        self._sem = _semaphores()

    async def audit_cache(self) -> None:
        """A cache hit (or a shared single-flight result) is audited too: one row, no query, row_count 0. The table's CHECK only allows
        outcome ok|error, so it is an 'ok' row whose params_hash covers {"args", "cache": true} and so never equals a real query's hash."""
        try:
            await studio_audit.audit_sink(
                studio_audit.AuditRow(staff_id=self.staff, tool=self.tool, params_hash=studio_audit.params_hash({"args": self.params, "cache": True}), row_count=0, duration_ms=0, mode="live", outcome="ok")
            )
        except Exception as exc:  # fail closed, like every other read
            logger.error("tool=%s audit write failed type=%s", self.tool, type(exc).__name__)
            raise ToolError("The audit log is unavailable, so this read was refused.") from None

    async def q(self, db: Literal["cdmss", "gov"], sql: str, params: dict, source: str) -> list[dict]:
        started = time.monotonic()
        qh = hashlib.sha256(sql.encode()).hexdigest()[:12]
        fetch = fetch_cdmss if db == "cdmss" else fetch_gov
        if db == "cdmss":
            params = {**params, "app": self.app_source}  # every opd_* / gov_signal read is pinned to one app_source

        async def audit(rows: int, outcome: str) -> None:
            await studio_audit.audit_sink(
                studio_audit.AuditRow(
                    staff_id=self.staff,
                    tool=self.tool,
                    params_hash=studio_audit.params_hash({"args": self.params, "db": db, "query": qh}),
                    row_count=rows,
                    duration_ms=int((time.monotonic() - started) * 1000),
                    mode="live",
                    outcome=outcome,
                )
            )

        # Bookkeeping in CALL order (not completion order), so the provenance and the query hash do not depend on timing.
        self.sql.append(sql)
        self.hashes.append(qh)
        if source not in self.sources:
            self.sources.append(source)
        failure: Optional[str] = None
        rows: list[dict] = []
        try:
            async with self._sem[db]:
                fetched = await fetch(sql, params)
            rows = [{k: _json_safe(v) if not isinstance(v, (list, tuple)) else v for k, v in dict(r).items()} for r in fetched]
        except ToolError as exc:
            failure = str(exc)
        except NotConfigured:
            failure = "The CDMSS database is not configured." if db == "cdmss" else "The governance database is not configured."
        except PinError:
            failure = "The database address is not pinned, so this read was refused."
        except Exception as exc:  # never leak driver text (hostnames, DSN fragments)
            logger.warning("tool=%s db=%s failed type=%s", self.tool, db, type(exc).__name__)
            failure = "The CDMSS database read failed." if db == "cdmss" else "The governance database read failed."
        if failure is not None:
            try:
                await audit(0, "error")
            except Exception as exc:
                logger.error("tool=%s audit write failed type=%s", self.tool, type(exc).__name__)
            raise ToolError(failure)
        try:
            await audit(len(rows), "ok")
        except Exception as exc:  # fail closed: no audit row, no data
            logger.error("tool=%s audit write failed type=%s", self.tool, type(exc).__name__)
            raise ToolError("The audit log is unavailable, so this read was refused.") from None
        logger.info("tool=%s staff=%s db=%s rows=%d ms=%d", self.tool, self.staff, db, len(rows), int((time.monotonic() - started) * 1000))
        return rows

    def query_hash(self) -> str:
        return hashlib.sha256("\n".join(self.sql).encode()).hexdigest()[:12]


# --------------------------------------------------------------------------------------------------------------
# SQL (fixed text; every value is a bound parameter)
# --------------------------------------------------------------------------------------------------------------

FINDINGS_ARR = "jsonb_array_elements(CASE WHEN jsonb_typeof(a.findings) = 'array' THEN a.findings ELSE '[]'::jsonb END) e"
NOT_INFO = "COALESCE(e->>'informational', 'false') <> 'true'"
LV_PRED = f"e->>'verdict' = 'low-value' AND {NOT_INFO} AND COALESCE(e->>'direction', '') <> 'underuse'"
DUP_PRED = f"(e->>'signal_type' IN ('duplicate_prescription', 'duplicate_molecule') OR e->>'lvc_category' = 'therapeutic_duplication') AND {NOT_INFO}"
NSAID_AT_PRED = (
    "e->>'signal_type' = 'drug_interaction' AND e->>'rationale' ~* 'nsaid' "
    "AND e->>'rationale' ~* '(anticoag|antiplatelet|antithrombotic|warfarin|heparin|enoxaparin|clopidogrel)'"
)

# One scan of the canonical OPD notes; aggregates by (doctor, period, complexity band). {period} is one of two fixed expressions.
PERIOD_EARLY_LATE = "CASE WHEN a.note_day_ist >= %(late_from)s THEN 'late' ELSE 'early' END"
PERIOD_WEEKLY = "'w' || ((%(late_to)s::date - a.note_day_ist) / 7)::int"

OPD_AGG_SQL = """
SELECT s.doctor_uid, s.period, s.complexity_band,
       count(*) AS n,
       count(*) FILTER (WHERE s.assessed) AS n_assessed,
       COALESCE(sum(s.nqi) FILTER (WHERE s.assessed), 0) AS sum_nqi,
       COALESCE(sum(s.nqi * s.nqi) FILTER (WHERE s.assessed), 0) AS ssq_nqi,
       count(*) FILTER (WHERE s.assessed AND s.raw_band = 'A') AS band_a,
       count(*) FILTER (WHERE s.assessed AND s.raw_band = 'B') AS band_b,
       count(*) FILTER (WHERE s.assessed AND s.raw_band = 'C') AS band_c,
       count(*) FILTER (WHERE s.assessed AND s.raw_band = 'D') AS band_d,
       count(*) FILTER (WHERE s.assessed AND s.raw_band = 'E') AS band_e,
       count(s.clin) AS n_clin, COALESCE(sum(s.clin), 0) AS sum_clin, COALESCE(sum(s.clin * s.clin), 0) AS ssq_clin,
       count(s.completeness_pct) AS n_comp, COALESCE(sum(s.completeness_pct), 0) AS sum_comp, COALESCE(sum(s.completeness_pct * s.completeness_pct), 0) AS ssq_comp,
       count(*) FILTER (WHERE s.n_lv > 0) AS n_lv_notes,
       COALESCE(sum(s.n_lv), 0) AS n_lv, COALESCE(sum(s.n_dup), 0) AS n_dup, COALESCE(sum(s.n_nsaid_at), 0) AS n_nsaid_at,
       max(s.audited_at) AS cutoff,
       array_agg(DISTINCT s.engine_version) AS versions
FROM (
  SELECT a.doctor_uid, __PERIOD__ AS period, a.complexity_band, a.note_quality_index AS nqi, a.raw_band, a.completeness_pct,
         a.audited_at, a.engine_version,
         (a.pdqi9_assessed AND a.scorecard_recorded AND a.pdqi9_assessed_basis = 'scorecard') AS assessed,
         CASE WHEN a.score_appropriateness IS NULL AND a.score_prescribing_safety IS NULL THEN NULL
              ELSE (COALESCE(a.score_appropriateness, 0) + COALESCE(a.score_prescribing_safety, 0))
                   / ((a.score_appropriateness IS NOT NULL)::int + (a.score_prescribing_safety IS NOT NULL)::int) END AS clin,
         fx.n_lv, fx.n_dup, fx.n_nsaid_at
  FROM cdmss_ro.opd_note_audit a
  CROSS JOIN LATERAL (
    SELECT count(*) FILTER (WHERE __LV__) AS n_lv, count(*) FILTER (WHERE __DUP__) AS n_dup, count(*) FILTER (WHERE __NSAID__) AS n_nsaid_at
    FROM __FINDINGS__
  ) fx
  WHERE a.note_day_ist BETWEEN %(from)s AND %(to)s AND a.doctor_uid IS NOT NULL AND a.app_source = %(app)s
  ORDER BY a.note_day_ist DESC, a.audit_id
  LIMIT %(scan)s
) s
GROUP BY s.doctor_uid, s.period, s.complexity_band
"""


def opd_agg_sql(period_expr: str) -> str:
    return (
        OPD_AGG_SQL.replace("__PERIOD__", period_expr)
        .replace("__LV__", LV_PRED)
        .replace("__DUP__", DUP_PRED)
        .replace("__NSAID__", NSAID_AT_PRED)
        .replace("__FINDINGS__", FINDINGS_ARR)
    )


# Audited note identities (for the DB13 denominators) with the R5 flag per note.
OPD_UIDS_SQL = f"""
SELECT a.uid, a.doctor_uid, {PERIOD_EARLY_LATE} AS period,
       EXISTS (SELECT 1 FROM {FINDINGS_ARR} WHERE e->>'rule_ref' = %(r5)s AND {NOT_INFO}) AS has_r5,
       (SELECT count(*) FROM {FINDINGS_ARR} WHERE {DUP_PRED}) AS n_dup,
       (SELECT count(*) FROM {FINDINGS_ARR} WHERE {NSAID_AT_PRED}) AS n_nsaid_at
FROM cdmss_ro.opd_note_audit a
WHERE a.note_day_ist BETWEEN %(from)s AND %(to)s AND a.doctor_uid IS NOT NULL AND a.app_source = %(app)s
ORDER BY a.audit_id
LIMIT %(scan)s
"""

# DB13 extract (governance DB): one row per audited prescription uid.
DW_RX_SQL = """
SELECT DISTINCT ON (p.uid) p.uid,
       CASE WHEN jsonb_typeof(p.medications) = 'array' THEN jsonb_array_length(p.medications) ELSE 0 END AS n_med,
       CASE WHEN jsonb_typeof(p.further_investigation) = 'array' THEN jsonb_array_length(p.further_investigation) ELSE 0 END AS n_inv,
       (jsonb_typeof(p.medications) IS DISTINCT FROM 'array') AS med_unparsed,
       EXISTS (SELECT 1 FROM unnest(COALESCE(p.diagnosis_icd_codes, '{}'::text[]) || COALESCE(p.impression_icd_codes, '{}'::text[])) c
               WHERE upper(btrim(c)) ~ '^J(0[0-6]|2[0-2])') AS urti
FROM studio_ro.dw_individuals_prescriptions p
WHERE p.uid = ANY(%(uids)s) AND NOT COALESCE(p.is_draft, false)
ORDER BY p.uid, p."timestamp" DESC NULLS LAST
"""

DW_AS_OF_SQL = "SELECT max(db13_snapshot_now) AS as_of FROM studio_ro.dw_extract_status WHERE status IN ('ok', 'partial')"

DIRECTORY_SQL = """
SELECT p.cdmss_doctor_uid AS doctor_uid, p.full_name, p.primary_specialty,
       COALESCE(array_agg(DISTINCT h.code) FILTER (WHERE h.code IS NOT NULL), '{}'::text[]) AS sites
FROM physicians p
LEFT JOIN physician_engagements e ON e.physician_id = p.id AND e.status <> 'terminated'
LEFT JOIN hospitals h ON h.id = e.hospital_id
WHERE p.cdmss_doctor_uid IS NOT NULL
GROUP BY p.id
ORDER BY p.cdmss_doctor_uid
LIMIT 20000
"""

DOCTOR_DIM_SQL = """
SELECT d.doctor_uid, d.doctor_name, COALESCE(d.directory_speciality, d.roster_specialty) AS speciality
FROM cdmss_ro.doctor_dim d
WHERE d.doctor_uid = ANY(%(uids)s)
LIMIT 5000
"""

SIGNALS_SQL = """
SELECT s.signal_id::text AS signal_id, s.reference, s.doctor_uid, s.signal_type, s.importance, COALESCE(s.status, 'routed') AS status,
       s.response_required, s.window_from, s.window_to, s.sla_due_at, s.created_at, s.updated_at,
       (s.sla_due_at IS NOT NULL AND s.sla_due_at < now()) AS overdue,
       count(*) OVER () AS total_count
FROM cdmss_ro.gov_signal s
WHERE s.app_source = %(app)s AND COALESCE(s.status, 'routed') NOT IN ('ruled', 'closed')
  AND COALESCE(s.note_class, 'opd') = 'opd'
  AND (%(overdue_only)s::boolean IS FALSE OR (s.sla_due_at IS NOT NULL AND s.sla_due_at < now()))
  AND (%(doctor)s::text IS NULL OR s.doctor_uid = %(doctor)s::text)
  AND (%(doctors)s::text[] IS NULL OR s.doctor_uid = ANY(%(doctors)s::text[]) OR (%(prefix)s::text IS NOT NULL AND starts_with(s.reference, %(prefix)s::text)))
ORDER BY (s.sla_due_at IS NOT NULL AND s.sla_due_at < now()) DESC, s.created_at DESC, s.signal_id
LIMIT %(limit)s OFFSET %(offset)s
"""

# Data cut-off for the signal / finding reads: the newest audit the window's notes carry (those reads return no audit timestamp of their own).
NOTE_CUTOFF_SQL = """
SELECT max(a.audited_at) AS cutoff
FROM cdmss_ro.opd_note_audit a
WHERE a.note_day_ist BETWEEN %(from)s AND %(to)s AND a.app_source = %(app)s
"""

FINDING_COLS = """f.audit_id::text AS audit_id, f.uid, f.doctor_uid, f.note_day_ist::text AS note_day, f.finding_no, f.subject, f.domain, f.verdict,
       f.signal_type, f.lvc_category, f.rule_ref, f.evidence, f.rationale, f.confidence, f.source, f.concept_id"""

# Fixed predicates for the drill-downs (chosen by metric id, never from user text).
FINDING_PREDICATES = {
    "lv": f"f.verdict = 'low-value' AND COALESCE(f.informational, false) = false AND COALESCE(f.direction, '') <> 'underuse'",
    "dup": "(f.signal_type IN ('duplicate_prescription', 'duplicate_molecule') OR f.lvc_category = 'therapeutic_duplication') AND COALESCE(f.informational, false) = false",
    "nsaid": "f.signal_type = 'drug_interaction' AND f.rationale ~* 'nsaid' AND f.rationale ~* '(anticoag|antiplatelet|antithrombotic|warfarin|heparin|enoxaparin|clopidogrel)'",
    "r5": "f.rule_ref = %(r5)s AND COALESCE(f.informational, false) = false",
    "redflag": "((f.verdict = 'low-value' AND COALESCE(f.informational, false) = false) OR f.signal_type = 'drug_interaction')",
}


def findings_sql(kind: str, *, by_doctors: bool, by_one_doctor: bool, windowed: bool = True) -> str:
    return f"""
SELECT {FINDING_COLS}, count(*) OVER () AS total_count
FROM cdmss_ro.opd_finding f
WHERE {FINDING_PREDICATES[kind]} AND f.app_source = %(app)s
  AND f.note_day_ist BETWEEN %(from)s AND %(to)s
  {"AND f.doctor_uid = ANY(%(doctors)s::text[])" if by_doctors else ""}
  {"AND f.doctor_uid = %(doctor)s::text" if by_one_doctor else ""}
ORDER BY f.note_day_ist DESC, f.uid, f.finding_no
LIMIT %(limit)s OFFSET %(offset)s
"""


def notes_list_sql(order: str, assessed_only: bool, unassessed_only: bool, by_doctors: bool, by_one_doctor: bool) -> str:
    return f"""
SELECT a.audit_id::text AS audit_id, a.uid, a.doctor_uid, a.note_day_ist::text AS note_day, a.note_quality_index AS nqi, a.raw_band,
       (a.pdqi9_assessed AND a.scorecard_recorded AND a.pdqi9_assessed_basis = 'scorecard') AS assessed,
       a.score_appropriateness, a.score_prescribing_safety, a.completeness_pct,
       count(*) OVER () AS total_count
FROM cdmss_ro.opd_note_audit a
WHERE a.note_day_ist BETWEEN %(from)s AND %(to)s AND a.doctor_uid IS NOT NULL AND a.app_source = %(app)s
  {"AND (a.pdqi9_assessed AND a.scorecard_recorded AND a.pdqi9_assessed_basis = 'scorecard')" if assessed_only else ""}
  {"AND NOT (a.pdqi9_assessed AND a.scorecard_recorded AND a.pdqi9_assessed_basis = 'scorecard')" if unassessed_only else ""}
  {"AND a.doctor_uid = ANY(%(doctors)s::text[])" if by_doctors else ""}
  {"AND a.doctor_uid = %(doctor)s::text" if by_one_doctor else ""}
ORDER BY {order}
LIMIT %(limit)s OFFSET %(offset)s
"""


NOTE_ORDERS = {
    "nqi_asc": "a.note_quality_index ASC NULLS LAST, a.note_day_ist DESC, a.audit_id",
    "recent": "a.note_day_ist DESC, a.audit_id",
    "completeness_asc": "a.completeness_pct ASC NULLS LAST, a.note_day_ist DESC, a.audit_id",
}

NOTE_HEADER_SQL = """
SELECT a.audit_id::text AS audit_id, a.uid, a.doctor_uid, a.note_day_ist::text AS note_day, a.engine_version, a.raw_band, a.note_quality_index AS nqi,
       (a.pdqi9_assessed AND a.scorecard_recorded AND a.pdqi9_assessed_basis = 'scorecard') AS assessed, a.audited_at
FROM cdmss_ro.opd_note_audit a
WHERE a.uid = %(uid)s::text AND a.app_source = %(app)s
ORDER BY a.audited_at DESC NULLS LAST
LIMIT 5
"""

FINDING_DETAIL_SQL = f"""
SELECT {FINDING_COLS}
FROM cdmss_ro.opd_finding f
WHERE f.uid = %(uid)s::text AND f.app_source = %(app)s AND (%(finding_no)s::int IS NULL OR f.finding_no = %(finding_no)s::int)
ORDER BY f.finding_no
LIMIT 200
"""

ALL_SQL_TEXTS = {
    "opd_agg_early_late": opd_agg_sql(PERIOD_EARLY_LATE),
    "opd_agg_weekly": opd_agg_sql(PERIOD_WEEKLY),
    "opd_uids": OPD_UIDS_SQL,
    "dw_rx": DW_RX_SQL,
    "dw_as_of": DW_AS_OF_SQL,
    "directory": DIRECTORY_SQL,
    "doctor_dim": DOCTOR_DIM_SQL,
    "signals": SIGNALS_SQL,
    "finding_detail": FINDING_DETAIL_SQL,
    "note_header": NOTE_HEADER_SQL,
    "note_cutoff": NOTE_CUTOFF_SQL,
}
# The CDMSS views these tools touch (the role holds SELECT on exactly the cdmss_ro views).
CDMSS_VIEWS = ("cdmss_ro.opd_note_audit", "cdmss_ro.opd_finding", "cdmss_ro.doctor_dim", "cdmss_ro.gov_signal")
DW_VIEWS = ("studio_ro.dw_individuals_prescriptions", "studio_ro.dw_extract_status")


# --------------------------------------------------------------------------------------------------------------
# Aggregates
# --------------------------------------------------------------------------------------------------------------

_SUM_FIELDS = (
    "n n_assessed sum_nqi ssq_nqi band_a band_b band_c band_d band_e n_clin sum_clin ssq_clin n_comp sum_comp ssq_comp n_lv_notes n_lv n_dup n_nsaid_at"
).split()


@dataclass
class OpdAgg:
    n: float = 0
    n_assessed: float = 0
    sum_nqi: float = 0
    ssq_nqi: float = 0
    band_a: float = 0
    band_b: float = 0
    band_c: float = 0
    band_d: float = 0
    band_e: float = 0
    n_clin: float = 0
    sum_clin: float = 0
    ssq_clin: float = 0
    n_comp: float = 0
    sum_comp: float = 0
    ssq_comp: float = 0
    n_lv_notes: float = 0
    n_lv: float = 0
    n_dup: float = 0
    n_nsaid_at: float = 0

    def add_row(self, r: dict) -> None:
        for f in _SUM_FIELDS:
            setattr(self, f, getattr(self, f) + float(r.get(f) or 0))


@dataclass
class RxAgg:
    n_notes: float = 0  # audited notes found in the extract (consults)
    n_rx: float = 0  # ... with at least one medication line
    n_5plus: float = 0
    sum_inv: float = 0
    n_urti: float = 0
    n_urti_r5: float = 0
    n_unparsed: float = 0
    n_dup: float = 0  # findings on the SAME notes as n_rx (found in the extract with a medication line)
    n_nsaid_at: float = 0

    def add(self, o: "RxAgg") -> None:
        for f in self.__dataclass_fields__:
            setattr(self, f, getattr(self, f) + getattr(o, f))


@dataclass
class Doc:
    uid: str
    name: Optional[str] = None
    speciality: Optional[str] = None
    sites: list = field(default_factory=list)

    @property
    def site(self) -> str:
        return self.sites[0] if len(self.sites) == 1 else ("MULTI" if len(self.sites) > 1 else "UNMAPPED")


@dataclass
class Group:
    """Everything one metric needs for one slice (all sites / a site / a doctor): late and early aggregates, banded LVC cells and Rx sums."""

    late: OpdAgg = field(default_factory=OpdAgg)
    early: OpdAgg = field(default_factory=OpdAgg)
    rx_late: RxAgg = field(default_factory=RxAgg)
    rx_early: RxAgg = field(default_factory=RxAgg)
    cells: dict = field(default_factory=dict)  # complexity band -> [n, o] (late window)
    periods: dict = field(default_factory=dict)  # weekly mode: period -> OpdAgg


@dataclass
class Dataset:
    run: Run
    late: Window
    early: Optional[Window]
    rows: list
    docs: dict
    rx: dict  # (doctor, period) -> RxAgg
    weekly: bool = False
    truncated: bool = False  # the scan cap cut the window (newest rows kept), so early vs late is not comparable

    @property
    def model(self) -> dict:
        """Stratum rates for O/E, built once from every doctor's banded late-window cells."""
        if "_model" not in self.__dict__:
            self.__dict__["_model"] = stratum_model(self.group().cells)
        return self.__dict__["_model"]

    def doc(self, uid: str) -> Doc:
        return self.docs.get(uid) or Doc(uid)

    def group(self, pred=lambda uid: True) -> Group:
        g = Group()
        for r in self.rows:
            uid = r["doctor_uid"]
            if not pred(uid):
                continue
            per = r["period"]
            if self.weekly:
                g.periods.setdefault(per, OpdAgg()).add_row(r)
                continue
            (g.late if per == "late" else g.early).add_row(r)
            if per == "late":
                cell = g.cells.setdefault(r.get("complexity_band"), [0, 0])
                cell[0] += float(r.get("n") or 0)
                cell[1] += float(r.get("n_lv_notes") or 0)
        for (uid, per), agg in self.rx.items():
            if pred(uid):
                (g.rx_late if per == "late" else g.rx_early).add(agg)
        return g


async def load_directory(run: Run) -> dict:
    rows = await run.q("gov", DIRECTORY_SQL, {}, "governance DB: physicians, physician_engagements, hospitals")
    return {r["doctor_uid"]: Doc(r["doctor_uid"], r.get("full_name"), r.get("primary_specialty"), sorted(r.get("sites") or [])) for r in rows}


async def fill_names(run: Run, docs: dict, uids) -> dict:
    """Doctors the governance DB does not know by name get CDMSS's doctor_dim name (staff identity); unknown ones stay unnamed."""
    missing = sorted({u for u in uids if u not in docs or not docs[u].name})
    if missing:
        for r in await run.q("cdmss", DOCTOR_DIM_SQL, {"uids": missing}, "cdmss_ro.doctor_dim"):
            d = docs.setdefault(r["doctor_uid"], Doc(r["doctor_uid"]))
            d.name = d.name or r.get("doctor_name")
            d.speciality = d.speciality or r.get("speciality")
    for u in uids:
        docs.setdefault(u, Doc(u))
    return docs


async def load_dataset(run: Run, days: int, *, need_rx: bool = False, weekly: bool = False, directory: Any = None) -> Dataset:
    """`directory` may be a dict or an awaitable that yields one (a task shared by several loads). The independent reads (the
    note aggregate, the directory, the uid list for the DB13 denominators) run together."""
    today = run.today
    if weekly:
        late, early = Window(today - dt.timedelta(days=days - 1), today), None
        sql = ALL_SQL_TEXTS["opd_agg_weekly"]
        frm = late.frm
    else:
        late, early = window_pair(days, today)
        sql = ALL_SQL_TEXTS["opd_agg_early_late"]
        frm = early.frm
    p = {"from": frm, "to": today, "late_from": late.frm, "late_to": late.to, "scan": SCAN_CAP + 1}
    want_rx = need_rx and not weekly
    jobs = [run.q("cdmss", sql, p, "cdmss_ro.opd_note_audit")]
    if want_rx:
        jobs.append(run.q("cdmss", ALL_SQL_TEXTS["opd_uids"], {**p, "r5": R5_RULE_REF}, "cdmss_ro.opd_note_audit"))
    if directory is None:
        jobs.append(load_directory(run))
    res = await gather_all(*jobs)
    rows = res[0]
    notes = res[1] if want_rx else None
    docs = res[-1] if directory is None else (await directory if asyncio.isfuture(directory) or asyncio.iscoroutine(directory) else directory)
    total = sum(float(r["n"] or 0) for r in rows)
    if total > SCAN_CAP:
        run.incomplete.append(f"The window holds more than {SCAN_CAP:,} audited notes; the newest {SCAN_CAP:,} were read, so every figure covers a truncated window.")
    for r in rows:
        if r.get("cutoff"):
            run.cutoffs.append(r["cutoff"])
        run.versions.update(v for v in (r.get("versions") or []) if v)
    names = fill_names(run, docs, {r["doctor_uid"] for r in rows})
    if want_rx:
        _, rx = await gather_all(names, load_rx(run, notes))
    else:
        await names
        rx = {}
    return Dataset(run, late, early, rows, docs, rx, weekly, truncated=total > SCAN_CAP)


async def load_rx(run: Run, notes: list) -> dict:
    """DB13 denominators for the notes already listed by the `opd_uids` read."""
    if len(notes) > SCAN_CAP:
        run.incomplete.append(f"More than {SCAN_CAP:,} audited notes in the window: DB13 denominators cover the first {SCAN_CAP:,}.")
        notes = notes[:SCAN_CAP]
    by_uid = {n["uid"]: n for n in notes}
    if not by_uid:
        return {}
    rows, asof = await gather_all(
        run.q("gov", ALL_SQL_TEXTS["dw_rx"], {"uids": sorted(by_uid)}, "studio_ro.dw_individuals_prescriptions"),
        run.q("gov", DW_AS_OF_SQL, {}, "studio_ro.dw_extract_status"),
    )
    if asof and asof[0].get("as_of"):
        run.db13_as_of = str(asof[0]["as_of"])
    out: dict = {}
    for r in rows:
        n = by_uid.get(r["uid"])
        if not n:
            continue
        a = out.setdefault((n["doctor_uid"], n["period"]), RxAgg())
        a.n_notes += 1
        if (r.get("n_med") or 0) > 0:
            a.n_rx += 1
            a.n_dup += float(n.get("n_dup") or 0)
            a.n_nsaid_at += float(n.get("n_nsaid_at") or 0)
            if r["n_med"] >= 5:
                a.n_5plus += 1
        a.sum_inv += r.get("n_inv") or 0
        a.n_unparsed += 1 if r.get("med_unparsed") else 0
        if r.get("urti"):
            a.n_urti += 1
            a.n_urti_r5 += 1 if n.get("has_r5") else 0
    return out


# --------------------------------------------------------------------------------------------------------------
# The Stat: one place that applies window, interval, min-n, coverage and change
# --------------------------------------------------------------------------------------------------------------

METRICS: dict[str, dict] = {}


def _m(mid, label, family, unit, status, definition, sources, min_n_kind="group", caveats=()):
    METRICS[mid] = dict(id=mid, label=label, family=family, unit=unit, status=status, definition=definition, sources=list(sources), min_n_kind=min_n_kind, caveats=list(caveats))


_OPD_SRC = ["cdmss_ro.opd_note_audit"]
_RX_SRC = ["cdmss_ro.opd_note_audit", "studio_ro.dw_individuals_prescriptions"]
_m("M-OPD-01", "Mean OPD NQI (PDQI-assessed notes only)", "opd", "score", "ok", "Mean of the stored note_quality_index over notes where PDQI-9 was assessed (scorecard recorded and note_quality weight > 0); coverage = assessed / canonical notes; greyed under 50% coverage.", _OPD_SRC, caveats=C7_CAVEATS)
_m("M-OPD-02", "NQI band mix (raw band)", "opd", "percent", "ok", "Share of PDQI-assessed notes with raw band A, A-B, and C-E (A>=85, B>=70, C>=55, D>=40, E<40). Value = share in A-B.", _OPD_SRC, caveats=C7_CAVEATS)
_m("M-OPD-03", "Clinical NQI", "opd", "score", "ok", "Prescribing-safety and appropriateness domain scores, equally weighted and reweighted to 100 (documentation, patient-centredness and PDQI-9 excluded); over all canonical notes.", _OPD_SRC, caveats=("Domain scores are assumed to be on the same 0-100 scale as the NQI.",))
_m("M-OPD-04", "Documentation completeness", "opd", "percent", "ok", "Mean completeness_pct over canonical notes (NABH-OPD mandatory items).", _OPD_SRC)
_m("M-OPD-05", "Low-value findings per 100 notes", "opd", "per_100", "ok", "Non-informational, non-underuse findings with verdict low-value per 100 canonical notes; also the share of notes with at least one.", _OPD_SRC)
_m("M-OPD-05b", "Notes with at least one low-value finding", "opd", "percent", "ok", "Share of canonical notes with at least one non-informational, non-underuse low-value finding (the board's pct_low). This is the rate V3's funnel and V4's contributors use; M-OPD-05 counts findings per 100 notes.", _OPD_SRC)
_m("M-OPD-06", "Low-value care observed/expected", "opd", "ratio", "ok", "Notes with a low-value finding (O) over the sum of complexity-band stratum rates (E). Unbanded notes excluded. Not age-adjusted (age is not stored).", _OPD_SRC, "doctor", caveats=("Complexity-adjusted only; age band is not available.",))
_m("M-OPD-08", "Same-class duplicates per 1,000 Rx", "opd", "per_1000", "ok", "Duplicate-prescription / duplicate-molecule / therapeutic-duplication findings per 1,000 prescriptions (with a medication line) among the audited notes found in the DB13 extract.", _RX_SRC, caveats=("Class membership is the audit's rule text; completeness UNVERIFIED.", DB13_LAG_CAVEAT))
_m("M-OPD-12", "NSAID with an antithrombotic per 1,000 Rx", "opd", "per_1000", "ok", "drug_interaction findings whose rationale names an NSAID and an anticoagulant/antiplatelet, per 1,000 prescriptions.", _RX_SRC, caveats=("Text match on the finding rationale; no structured rule id is stored. Low-dose aspirin may be counted in both classes (UNVERIFIED).", DB13_LAG_CAVEAT))
_m("M-OPD-13", "Prescriptions with 5 or more medicines", "opd", "percent", "ok", "Share of prescriptions (with a medication line) listing five or more medicines, from the DB13 extract.", _RX_SRC)
_m("M-OPD-14", "Tests per consult", "opd", "count", "ok", "Investigation lines per audited consult found in the DB13 extract (further_investigation array length).", _RX_SRC, caveats=("Shape of further_investigation in the extract is UNVERIFIED; a non-array counts as 0 tests.",))
for _mid, _lab, _why in (
    ("M-OPD-09", "Sedatives in age 60+ per 1,000 Rx", "Patient age is not stored on the audit row and the engine has no Beers/sedative-60+ rule."),
    ("M-OPD-10", "NSAID in age 60+ or CKD per 1,000 Rx", "Neither age nor a CKD flag is stored."),
    ("M-OPD-11", "Triple whammy per 1,000 Rx", "Only the NSAID + ACE-I/ARB pair rule exists; there is no three-drug (with diuretic) test."),
):
    _m(_mid, _lab, "opd", "per_1000", "unavailable", _why, [])
_AMS_NO_AWARE = "No WHO AWaRe classification is available: the formulary marks Reserve (restricted) only, and no AWaRe list is in the repo or the DB13 extract."
_m("M-AMS-01", "WHO Access share of antibiotics", "ams", "percent", "unavailable", _AMS_NO_AWARE, [])
_m("M-AMS-02", "Prescriptions with a Watch agent", "ams", "percent", "unavailable", _AMS_NO_AWARE, [])
_m("M-AMS-03", "Antibiotic flagged in viral URTI", "ams", "percent", "ok", "Audited URTI consults (ICD J00-J06, J20-J22 in the DB13 extract) carrying the ratified R5 finding 'antibiotic for acute upper-respiratory illness', as a share of audited URTI consults.", _RX_SRC, caveats=("A lower bound: only what the audit caught. ICD code set UNVERIFIED.",))
_m("M-AMS-04", "Antibiotics in gastroenteritis", "ams", "percent", "unavailable", "No ratified gastroenteritis-antibiotic rule exists, so there is no numerator.", [])
_m("M-AMS-05", "Post-operative prophylaxis longer than 24 h", "ams", "percent", "unavailable", "No order/MAR timestamps are in the DB13 extract and no rule exists.", [])

MIN_N = {"doctor": DOCTOR_MIN_N, "site": GROUP_MIN_N, "all": GROUP_MIN_N, "group": GROUP_MIN_N}


def stat(
    mid: str,
    window: Window,
    *,
    value=None,
    num=None,
    den=None,
    n: float = 0,
    ci=None,
    ci_method="none",
    kind="group",
    coverage=None,
    change=None,
    plain=None,
    note=None,
    band=None,
    extra=None,
    min_n: Optional[int] = None,
    label: Optional[str] = None,
    measure: str = "rate",
) -> dict:
    """Build a Stat (CONTRACT section 1), applying the min-n and coverage gates."""
    meta = METRICS[mid]
    status, reason = "ok", None
    if meta["status"] == "unavailable":
        status, reason, value, ci, num, den, plain = "unavailable", "not_available", None, None, None, None, None
        note = note or meta["definition"]
    else:
        floor = min_n if min_n is not None else MIN_N[kind]
        if n < floor:
            status, reason, value, ci, change, plain, band = "count_only", "min_n", None, None, None, None, None
        elif value is None:
            status, reason = "count_only", "no_denominator"
        if status == "count_only":
            # Below the floor only the count n is shown: a numerator/denominator pair (or counts in `extra`) would give the hidden value back.
            num = den = None
            extra = {"band_stats": extra["band_stats"]} if isinstance(extra, dict) and "band_stats" in extra else None
        if status == "ok" and coverage is not None and coverage["pct"] < COVERAGE_GREY_PCT:
            status, reason = "greyed", "coverage_lt_50"
    if measure == "mean":
        num = den = None  # a mean's numerator is a score sum ("165643/2055"): value, interval and n are the whole story
    out = {
        "metric_id": mid,
        "label": label or meta["label"],
        "value": value,
        "unit": meta["unit"],
        "numerator": num,
        "denominator": den,
        "n": int(n),
        "ci95": [ci[0], ci[1]] if ci else None,
        "ci_method": ci_method if ci else "none",
        "window": window.as_dict(),
        "coverage": coverage,
        "status": status,
        "grey_reason": reason,
        "change": change,
        "plain": plain,
        "note": note,
        "band": band,
        "kind": measure,  # "mean" (score means: no numerator/denominator) or "rate"
    }
    if extra is not None:
        out["extra"] = extra
    return out


def _change(early_w: Optional[Window], late_w: Window, ev, lv, en, ln, p):
    if early_w is None or ev is None or lv is None:
        return None
    direction, rel = classify_change(ev, lv, p)
    return {
        "direction": direction,
        "p_value": p,
        "relative_change": rel,
        "early": {"from": early_w.frm.isoformat(), "to": early_w.to.isoformat(), "value": ev, "n": int(en)},
        "late": {"from": late_w.frm.isoformat(), "to": late_w.to.isoformat(), "value": lv, "n": int(ln)},
    }


def _ratio(a: float, b: float) -> Optional[float]:
    return a / b if b else None


def metric_stat(mid: str, g: Group, ds: Dataset, kind: str = "group") -> dict:
    """The Stat for one catalogue metric over one slice; a truncated scan never claims a change."""
    out = _metric_stat(mid, g, ds, kind)
    if ds.truncated and out.get("change"):
        out["change"] = {"direction": "not computed (truncated)", "p_value": None, "relative_change": None, "early": out["change"]["early"], "late": out["change"]["late"]}
    return out


def _metric_stat(mid: str, g: Group, ds: Dataset, kind: str = "group") -> dict:
    L, E, w, ew = g.late, g.early, ds.late, ds.early
    if METRICS[mid]["status"] == "unavailable":
        return stat(mid, w, kind=kind)
    if mid == "M-OPD-01":
        m, _ = mean_sd(L.n_assessed, L.sum_nqi, L.ssq_nqi)
        em, _ = mean_sd(E.n_assessed, E.sum_nqi, E.ssq_nqi)
        cov = {"assessed": int(L.n_assessed), "total": int(L.n), "pct": round(100 * L.n_assessed / L.n, 1) if L.n else 0.0}
        ch = _change(ew, w, em, m, E.n_assessed, L.n_assessed, mean_change_p(E.n_assessed, E.sum_nqi, E.ssq_nqi, L.n_assessed, L.sum_nqi, L.ssq_nqi))
        return stat(mid, w, value=m, num=L.sum_nqi, den=L.n_assessed, n=L.n_assessed, ci=mean_ci(L.n_assessed, L.sum_nqi, L.ssq_nqi), ci_method="mean_normal", kind=kind, measure="mean", coverage=cov, change=ch, band=raw_band(m),
                    plain=f"about {m:.0f} out of 100 on {cov['pct']:.0f}% of notes" if m is not None else None)
    if mid == "M-OPD-02":
        k = L.band_a + L.band_b
        p = _ratio(k, L.n_assessed)
        ep = _ratio(E.band_a + E.band_b, E.n_assessed)
        cov = {"assessed": int(L.n_assessed), "total": int(L.n), "pct": round(100 * L.n_assessed / L.n, 1) if L.n else 0.0}
        ci = wilson(k, L.n_assessed)
        ch = _change(ew, w, None if ep is None else 100 * ep, None if p is None else 100 * p, E.n_assessed, L.n_assessed, prop_change_p(E.band_a + E.band_b, E.n_assessed, k, L.n_assessed))
        counts = {b: int(getattr(L, f"band_{b.lower()}")) for b in BANDS}
        ce = L.band_c + L.band_d + L.band_e
        extra = {"counts": counts, "pct_a": _pct(L.band_a, L.n_assessed), "pct_ab": _pct(k, L.n_assessed), "pct_ce": _pct(ce, L.n_assessed), "basis": "PDQI-assessed notes, raw band",
                 "band_stats": {b: band_share_stat(mid, w, b, getattr(L, f"band_{b.lower()}"), L.n_assessed, cov, kind) for b in BANDS}}
        return stat(mid, w, value=None if p is None else 100 * p, num=k, den=L.n_assessed, n=L.n_assessed, ci=None if ci is None else (100 * ci[0], 100 * ci[1]), ci_method="wilson", kind=kind, coverage=cov, change=ch, plain=plain_in_ten(p), extra=extra)
    if mid == "M-OPD-03":
        m, _ = mean_sd(L.n_clin, L.sum_clin, L.ssq_clin)
        em, _ = mean_sd(E.n_clin, E.sum_clin, E.ssq_clin)
        ch = _change(ew, w, em, m, E.n_clin, L.n_clin, mean_change_p(E.n_clin, E.sum_clin, E.ssq_clin, L.n_clin, L.sum_clin, L.ssq_clin))
        return stat(mid, w, value=m, num=L.sum_clin, den=L.n_clin, n=L.n_clin, ci=mean_ci(L.n_clin, L.sum_clin, L.ssq_clin), ci_method="mean_normal", kind=kind, measure="mean", change=ch, band=raw_band(m),
                    plain=f"about {m:.0f} out of 100" if m is not None else None)
    if mid == "M-OPD-04":
        m = _ratio(L.sum_comp, L.n_comp)
        em = _ratio(E.sum_comp, E.n_comp)
        return stat(mid, w, value=m, num=L.sum_comp, den=L.n_comp, n=L.n_comp, ci=mean_ci(L.n_comp, L.sum_comp, L.ssq_comp), ci_method="mean_normal", kind=kind, measure="mean",
                    plain=None if m is None else f"about {m:.0f}% of mandatory items present",
                    change=_change(ew, w, em, m, E.n_comp, L.n_comp, mean_change_p(E.n_comp, E.sum_comp, E.ssq_comp, L.n_comp, L.sum_comp, L.ssq_comp)))
    if mid == "M-OPD-05":
        r = _ratio(L.n_lv, L.n)
        er = _ratio(E.n_lv, E.n)
        pn = _ratio(L.n_lv_notes, L.n)
        ci = wilson(L.n_lv_notes, L.n)
        extra = {"pct_notes_with_one_or_more": None if pn is None else 100 * pn, "notes_with_one_or_more": int(L.n_lv_notes),
                 "pct_ci95": None if ci is None else [100 * ci[0], 100 * ci[1]], "ci_method": "wilson"}
        return stat(mid, w, value=None if r is None else 100 * r, num=L.n_lv, den=L.n, n=L.n, kind=kind, extra=extra,
                    change=_change(ew, w, None if er is None else 100 * er, None if r is None else 100 * r, E.n, L.n, rate_change_p(E.n_lv, E.n, L.n_lv, L.n)),
                    plain=plain_findings_per_100(None if r is None else 100 * r))
    if mid == "M-OPD-05b":
        p, ep = _ratio(L.n_lv_notes, L.n), _ratio(E.n_lv_notes, E.n)
        ci = wilson(L.n_lv_notes, L.n)
        return stat(mid, w, value=None if p is None else 100 * p, num=L.n_lv_notes, den=L.n, n=L.n, ci=None if ci is None else (100 * ci[0], 100 * ci[1]), ci_method="wilson", kind=kind,
                    change=_change(ew, w, None if ep is None else 100 * ep, None if p is None else 100 * p, E.n, L.n, prop_change_p(E.n_lv_notes, E.n, L.n_lv_notes, L.n)), plain=plain_in_ten(p))
    if mid == "M-OPD-06":
        return stat(mid, w, **{**oe_parts(g, ds.model), "kind": kind})
    if mid in ("M-OPD-08", "M-OPD-12"):
        R, RE = g.rx_late, g.rx_early
        k, ek = (R.n_dup, RE.n_dup) if mid == "M-OPD-08" else (R.n_nsaid_at, RE.n_nsaid_at)  # same notes as the denominator
        v = _ratio(1000 * k, R.n_rx)
        ev = _ratio(1000 * ek, RE.n_rx)
        return stat(mid, w, value=v, num=k, den=R.n_rx, n=R.n_rx, kind=kind, change=_change(ew, w, ev, v, RE.n_rx, R.n_rx, rate_change_p(ek, RE.n_rx, k, R.n_rx)),
                    plain=plain_rate(v, 1000, "prescriptions"), note=_unparsed_note(R))
    if mid == "M-OPD-13":
        R, RE = g.rx_late, g.rx_early
        p = _ratio(R.n_5plus, R.n_rx)
        ep = _ratio(RE.n_5plus, RE.n_rx)
        ci = wilson(R.n_5plus, R.n_rx)
        return stat(mid, w, value=None if p is None else 100 * p, num=R.n_5plus, den=R.n_rx, n=R.n_rx, ci=None if ci is None else (100 * ci[0], 100 * ci[1]), ci_method="wilson", kind=kind,
                    change=_change(ew, w, None if ep is None else 100 * ep, None if p is None else 100 * p, RE.n_rx, R.n_rx, prop_change_p(RE.n_5plus, RE.n_rx, R.n_5plus, R.n_rx)),
                    plain=plain_in_ten(p), note=_unparsed_note(R))
    if mid == "M-OPD-14":
        R, RE = g.rx_late, g.rx_early
        v = _ratio(R.sum_inv, R.n_notes)
        ev = _ratio(RE.sum_inv, RE.n_notes)
        return stat(mid, w, value=v, num=R.sum_inv, den=R.n_notes, n=R.n_notes, kind=kind, change=_change(ew, w, ev, v, RE.n_notes, R.n_notes, rate_change_p(RE.sum_inv, RE.n_notes, R.sum_inv, R.n_notes)),
                    plain=None if v is None else f"about {v:.1f} tests per consult")
    if mid == "M-AMS-03":
        R, RE = g.rx_late, g.rx_early
        p = _ratio(R.n_urti_r5, R.n_urti)
        ep = _ratio(RE.n_urti_r5, RE.n_urti)
        ci = wilson(R.n_urti_r5, R.n_urti)
        return stat(mid, w, value=None if p is None else 100 * p, num=R.n_urti_r5, den=R.n_urti, n=R.n_urti, ci=None if ci is None else (100 * ci[0], 100 * ci[1]), ci_method="wilson", kind=kind,
                    change=_change(ew, w, None if ep is None else 100 * ep, None if p is None else 100 * p, RE.n_urti, R.n_urti, prop_change_p(RE.n_urti_r5, RE.n_urti, R.n_urti_r5, R.n_urti)),
                    plain=plain_in_ten(p), note="Lower bound: only what the audit caught.")
    raise ToolError("Unknown metric.")


def band_share_stat(mid: str, w: Window, b: str, k: float, n: float, cov: dict, kind: str) -> dict:
    """One band's share of the PDQI-assessed notes (raw band), same gates as every Stat; for the stacked mix bar."""
    p = _ratio(k, n)
    ci = wilson(k, n)
    return stat(mid, w, value=None if p is None else 100 * p, num=k, den=n, n=n, ci=None if ci is None else (100 * ci[0], 100 * ci[1]), ci_method="wilson", kind=kind, coverage=cov,
                plain=plain_in_ten(p), band=b, label=f"Band {b} share of PDQI-assessed notes (raw band)")


def _pct(k, n):
    return None if not n else 100 * k / n


def _unparsed_note(R: RxAgg) -> Optional[str]:
    return f"{int(R.n_unparsed)} prescriptions had no readable medication array and count as zero medicines." if R.n_unparsed else None


def stratum_model(all_cells: dict) -> dict:
    """complexity band -> rate, global fallback (catalogue: band-marginal with n >= 30, else global). Age is unavailable, so band x age collapses to band."""
    tot_n = sum(c[0] for k, c in all_cells.items() if k is not None)
    tot_o = sum(c[1] for k, c in all_cells.items() if k is not None)
    model = {"__global__": (tot_o / tot_n) if tot_n else 0.0}
    for band, (n, o) in all_cells.items():
        if band is not None and n >= 30:
            model[band] = o / n
    return model


def oe_parts(g: Group, model: Optional[dict]) -> dict:
    cells = {b: c for b, c in g.cells.items() if b is not None}
    n_banded = sum(c[0] for c in cells.values())
    o = sum(c[1] for c in cells.values())
    expected = sum(c[0] * (model or {}).get(b, (model or {}).get("__global__", 0.0)) for b, c in cells.items())
    cov = {"assessed": int(n_banded), "total": int(g.late.n), "pct": round(100 * n_banded / g.late.n, 1) if g.late.n else 0.0}
    return dict(value=(o / expected) if expected > 0 else None, num=o, den=expected, n=n_banded, coverage=None, note=f"Banded notes {int(n_banded)} of {int(g.late.n)}; unbanded notes are excluded. Not age-adjusted.", plain=None, extra={"banded_coverage": cov, "expected_rate": (expected / n_banded) if n_banded else None, "raw_rate": (o / n_banded) if n_banded else None})


# --------------------------------------------------------------------------------------------------------------
# Pseudo-metrics: counts the module shows that are not catalogue rates (module-local ids, labelled as such)
# --------------------------------------------------------------------------------------------------------------

_m("M-SIG-01", "Open governance signals", "gov", "count", "ok", "Module-local count (not a catalogue metric): open OPD governance signal threads in cdmss_ro.gov_signal, status not ruled or closed.", ["cdmss_ro.gov_signal"])
_m("M-WL-01", "Low-value findings (worklist size)", "opd", "count", "ok", "Module-local count: non-informational, non-underuse low-value findings in the window.", ["cdmss_ro.opd_finding"])
_m("M-WL-02", "Notes without PDQI-9 assessment (worklist size)", "opd", "count", "ok", "Module-local count: canonical notes in the window where PDQI-9 was not assessed.", ["cdmss_ro.opd_note_audit"])
CATALOGUE_IDS = tuple(sorted(k for k in METRICS if k.startswith("M-OPD"))) + tuple(sorted(k for k in METRICS if k.startswith("M-AMS")))
RX_METRICS = frozenset(k for k, v in METRICS.items() if "studio_ro.dw_individuals_prescriptions" in v["sources"])


def count_stat(mid: str, window: Window, total: int) -> dict:
    return stat(mid, window, value=float(total), num=float(total), den=None, n=total, min_n=0)


# --------------------------------------------------------------------------------------------------------------
# Presentation helpers
# --------------------------------------------------------------------------------------------------------------


def case_url(uid: Optional[str]) -> Optional[str]:
    """The CDMSS prescription page for the note. UNVERIFIED that its uid equals the OPD audit uid (CONTRACT section 5)."""
    if not uid:
        return None
    base = (os.environ.get("CDMSS_CASE_BASE_URL") or CASE_BASE_DEFAULT).rstrip("/")
    return f"{base}/care/{re.sub(r'[^A-Za-z0-9._~-]', lambda m: '%%%02X' % ord(m.group(0)), str(uid))}"


def quote_of(evidence: Any, limit: int = 300) -> Optional[str]:
    """The note quote a finding carries: evidence is a jsonb array of strings or {quote|text|excerpt} objects (shape UNVERIFIED)."""
    if isinstance(evidence, str):
        try:
            evidence = json.loads(evidence)
        except ValueError:
            return evidence[:limit] or None
    parts: list[str] = []
    for item in evidence if isinstance(evidence, list) else ([evidence] if isinstance(evidence, dict) else []):
        if isinstance(item, str):
            parts.append(item)
        elif isinstance(item, dict):
            for k in ("quote", "text", "excerpt", "snippet"):
                if isinstance(item.get(k), str) and item[k]:
                    parts.append(item[k])
                    break
    text = " | ".join(p.strip() for p in parts if p.strip())
    return (text[:limit] + ("…" if len(text) > limit else "")) or None


def evidence_row(r: dict, docs: dict) -> dict:
    d = docs.get(r.get("doctor_uid")) or Doc(r.get("doctor_uid") or "")
    return {
        "audit_id": r.get("audit_id"),
        "uid": r.get("uid"),
        "doctor_uid": r.get("doctor_uid"),
        "doctor_name": d.name,
        "note_day": r.get("note_day"),
        "finding_no": r.get("finding_no"),
        "subject": r.get("subject"),
        "domain": r.get("domain"),
        "verdict": r.get("verdict"),
        "signal_type": r.get("signal_type"),
        "lvc_category": r.get("lvc_category"),
        "rule_ref": r.get("rule_ref"),
        "quote": quote_of(r.get("evidence")),
        "rationale": r.get("rationale"),
        "case": {"family": "opd", "uid": r.get("uid"), "url": case_url(r.get("uid")), "url_verified": False},
    }


def _fmt(s: dict) -> str:
    v = s["value"]
    if v is None:
        return "not shown"
    u = s["unit"]
    if u == "score":
        return f"{v:.0f}"
    if u == "percent":
        return f"{v:.0f}%"
    if u == "per_100":
        return f"{v:.0f} per 100 notes"
    if u == "per_1000":
        return f"{v:.1f} per 1,000 prescriptions"
    if u == "ratio":
        return f"{v:.2f}"
    return f"{v:.1f}" if isinstance(v, float) and not float(v).is_integer() else f"{int(v)}"


def sentence(s: dict) -> str:
    """A full-sentence claim for one Stat, with its numbers and window."""
    w = s["window"]
    span = f"{w['from']} to {w['to']}"
    if s["status"] == "unavailable":
        return f"{s['label']} cannot be reported: {s['note']}"
    if s["status"] == "count_only":
        return f"{s['label']}: only {s['n']} notes in {span}, too few to show a figure."
    tail = ""
    if s.get("coverage"):
        tail = f", on {s['coverage']['pct']:.0f}% of notes"
        if s["status"] == "greyed":
            tail += " (under half the notes were assessed, so treat it as indicative only)"
    ch = s.get("change")
    chg = f" It is {ch['direction']} against the previous {w['days']} days." if ch and ch["direction"] in ("rising", "falling") else (f" There is a small change (under 10%) against the previous {w['days']} days." if ch and ch["direction"] == SMALL_CHANGE else (" There is no clear change against the previous period." if ch else ""))
    return f"{s['label']} was {_fmt(s)} over {s['n']} {'prescriptions' if s['unit'] == 'per_1000' else 'notes'} between {span}{tail}.{chg}"


def build_envelope(run: Run, window: Window, headline: str, plain: str, stats: list, caveats=(), action: str = "") -> dict:
    cuts = []
    for c in run.cutoffs:
        try:
            cuts.append(dt.datetime.fromisoformat(str(c)))
        except ValueError:
            continue
    cutoff = max(cuts).isoformat() if cuts else None
    cav: list[str] = []
    if any(s["metric_id"] in ("M-OPD-01", "M-OPD-02", "M-OPD-03") for s in stats):
        cav.extend(C7_CAVEATS)
    cav.extend(caveats)
    cav.extend(run.incomplete)
    if run.db13_as_of:
        cav.append(f"Notes newer than DB13 as of {run.db13_as_of} are not in the extract and are excluded from the per-1,000-Rx metrics (and the other DB13-based figures).")
    for s in stats:
        cav.extend(METRICS.get(s["metric_id"], {}).get("caveats", []))
        if s.get("note") and s["status"] != "unavailable":
            cav.append(s["note"])
    seen, out = set(), []
    for c in cav:
        if c not in seen:
            seen.add(c)
            out.append(c)
    engine = ENGINE_FAMILY + (f"; versions read: {', '.join(sorted(run.versions))}" if run.versions else "")
    return {
        "provenance": {
            "window": window.as_dict(),
            "data_cutoff": cutoff,
            "sources": list(run.sources),
            "engine_family": engine,
            "db13_as_of": run.db13_as_of,
            "generated_at": now_ist().isoformat(),
            "query_hashes": list(run.hashes),
        },
        "headline": {"sentence": headline, "plain": plain},
        "stats": stats,
        "caveats": out,
        "precision_line": PRECISION_LINE,
        "action_line": action,
    }


def _cell(v: Any) -> Any:
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    return json.dumps(v, default=str)


def wrap(run: Run, tool_name: str, columns: list, rows: list, view: dict, total: Optional[int] = None) -> str:
    flat = [{c: _cell(r.get(c)) for c in columns} for r in rows]
    body: dict = {
        "source": {"tool": tool_name, "query_hash": run.query_hash()},
        "mode": "live",
        "synthetic": False,
        "columns": columns,
        "rows": flat,
        "row_count": len(flat),
    }
    if total is not None:
        body["total"] = total
    if run.incomplete:
        body["incomplete"] = " ".join(run.incomplete)[:300]
    body["view"] = view
    return json.dumps(body, default=str)


def groups_by(ds: Dataset, key) -> dict:
    """One pass: key(doctor_uid) -> Group (None keys are dropped)."""
    out: dict = {}
    for r in ds.rows:
        k = key(r["doctor_uid"])
        if k is None:
            continue
        g = out.setdefault(k, Group())
        per = r["period"]
        if ds.weekly:
            g.periods.setdefault(per, OpdAgg()).add_row(r)
            continue
        (g.late if per == "late" else g.early).add_row(r)
        if per == "late":
            cell = g.cells.setdefault(r.get("complexity_band"), [0, 0])
            cell[0] += float(r.get("n") or 0)
            cell[1] += float(r.get("n_lv_notes") or 0)
    for (uid, per), agg in ds.rx.items():
        k = key(uid)
        if k is not None:
            out.setdefault(k, Group())
            (out[k].rx_late if per == "late" else out[k].rx_early).add(agg)
    return out


def site_comparison(ds: Dataset) -> dict:
    """Is the per-note site good enough to compare sites? OPD notes carry no site of their own: the site is the doctor's home site, and
    doctors with none (UNMAPPED) or several (MULTI) cannot be placed. Coverage = placed notes / notes in the window."""
    total = mapped = 0.0
    for r in ds.rows:
        if r.get("period") != "late":
            continue
        n = float(r.get("n") or 0)
        total += n
        if ds.doc(r["doctor_uid"]).site not in ("UNMAPPED", "MULTI"):
            mapped += n
    cov = mapped / total if total else 1.0
    withheld = total > 0 and cov < SITE_COMPARISON_MIN_COVERAGE
    caption = f"Site comparison withheld: {round(100 * (1 - cov))}% of notes have no site (doctor home-site mapping). Fix pending." if withheld else None
    return {"withheld": withheld, "coverage": round(cov, 4), "min_coverage": SITE_COMPARISON_MIN_COVERAGE, "notes": int(total), "notes_with_site": int(mapped), "caption": caption}


async def refuse_site_filter_if_withheld(run: Run, days: int, site: Optional[str], ds: Optional["Dataset"] = None) -> None:
    """While site comparison is withheld, a site FILTER is a comparison too (two filtered calls rebuild it): refuse it with the caption."""
    if not site:
        return
    sc = site_comparison(ds if ds is not None else await load_dataset(run, days))
    if sc["withheld"]:
        raise ToolError(sc["caption"])


def withheld_stat(st: dict, caption: str) -> dict:
    """A Stat reduced to its count: the figure and everything that gives it back (interval, numerator/denominator, change) is dropped."""
    out = {**st, "value": None, "numerator": None, "denominator": None, "ci95": None, "ci_method": "none", "change": None, "plain": None, "status": "count_only", "grey_reason": "site_coverage", "note": caption}
    if out.get("extra"):
        out["extra"] = None
    return out


def site_of(ds: Dataset):
    return lambda uid: ds.doc(uid).site


def _site_pred(ds: Dataset, site: Optional[str], doctor: Optional[str] = None):
    return lambda uid: (site is None or ds.doc(uid).site == site) and (doctor is None or uid == doctor)


def _stat_row(site_or_key: str, label: str, s: dict) -> dict:
    ci = s["ci95"] or [None, None]
    return {"key": site_or_key, "label": label, "metric_id": s["metric_id"], "value": s["value"], "unit": s["unit"], "n": s["n"], "status": s["status"], "ci_lo": ci[0], "ci_hi": ci[1]}


# --------------------------------------------------------------------------------------------------------------
# Views
# --------------------------------------------------------------------------------------------------------------

OPD_TILES = ("M-OPD-01", "M-OPD-03", "M-OPD-02", "M-OPD-05", "M-OPD-04")
AMS_TILES = ("M-AMS-01", "M-AMS-02", "M-AMS-03", "M-AMS-04", "M-AMS-05")
COMING = (("ipd", "IPD discharge and episode audits"), ("ot", "OT notes"), ("preop", "Pre-op risk"), ("readmission", "Readmissions"))


async def build_v1(run: Run, days: int) -> str:
    ds = await load_dataset(run, days, need_rx=True)
    g = ds.group()
    opd = [metric_stat(m, g, ds, "all") for m in OPD_TILES]
    ams = [metric_stat(m, g, ds, "all") for m in AMS_TILES]
    tiles = lambda xs: [{"stat": s, "headline": sentence(s), "plain": s.get("plain")} for s in xs]  # noqa: E731
    first = opd[0]
    headline = sentence(first)
    movers = [s for s in (*opd, *ams) if s.get("change") and s["change"]["direction"] in ("rising", "falling")]
    action = (
        f"Governance leads: {len(movers)} measure(s) are moving ({', '.join(s['metric_id'] for s in movers)}); open the scorecard for those first."
        if movers
        else "Governance leads: nothing is moving clearly this week; use the scorecard to look at sites and the doctor view for outliers."
    )
    env = build_envelope(run, ds.late, headline, first.get("plain") or headline, [*opd, *ams], caveats=(SITE_CAVEAT,), action=action)
    rows = [{"family": "opd", "status": "live", "metric_id": s["metric_id"], "label": s["label"], "value": s["value"], "unit": s["unit"], "n": s["n"], "state": s["status"]} for s in opd]
    rows += [{"family": "ams", "status": "live", "metric_id": s["metric_id"], "label": s["label"], "value": s["value"], "unit": s["unit"], "n": s["n"], "state": s["status"]} for s in ams]
    view = {
        "envelope": env,
        "families": [
            {"family": "opd", "label": "OPD note audit", "status": "live", "tiles": tiles(opd)},
            {"family": "ams", "label": "Antimicrobial stewardship", "status": "live", "tiles": tiles(ams)},
            *({"family": f, "label": lab, "status": "coming"} for f, lab in COMING),
        ],
    }
    return wrap(run, "cdmss_v1_this_week", ["family", "status", "metric_id", "label", "value", "unit", "n", "state"], rows, view)


SCORECARD_METRICS = {"opd": ("M-OPD-01", "M-OPD-03", "M-OPD-02", "M-OPD-04", "M-OPD-05"), "ams": AMS_TILES}
TREND_METRICS = ("M-OPD-01", "M-OPD-03", "M-OPD-05")


async def build_v2(run: Run, days: int, family: str, site_filter: Optional[str]) -> str:
    metrics = SCORECARD_METRICS[family]
    # The window aggregate and the weekly trend aggregate are independent reads: run them together, sharing one directory read.
    directory = asyncio.ensure_future(load_directory(run))
    # the directory task is one of the gathered jobs, so a failing sibling cancels it instead of leaving it to finish and audit
    if family == "opd":
        _, ds, wds = await gather_all(directory, load_dataset(run, days, directory=directory), load_dataset(run, days, weekly=True, directory=directory))
    else:
        _, ds = await gather_all(directory, load_dataset(run, days, need_rx=True, directory=directory))
        wds = None
    by_site = groups_by(ds, site_of(ds))
    allg = ds.group()
    sc = site_comparison(ds)
    # Withheld: only the hospital-wide ("ALL") row, trend and band mix are built; no site is compared with another.
    sites = ["ALL"] if sc["withheld"] else ["ALL", *sorted(s for s in by_site if site_filter is None or s == site_filter)]
    site_list = [{"code": "ALL", "label": "All sites", "n": int(allg.late.n)}] + ([] if sc["withheld"] else [{"code": k, "label": k, "n": int(by_site[k].late.n)} for k in sorted(by_site)])  # no per-site counts while withheld
    matrix, rows, band_mix = [], [], []
    for s in sites:
        g = allg if s == "ALL" else by_site[s]
        kind = "all" if s == "ALL" else "site"
        cells = {m: metric_stat(m, g, ds, kind) for m in metrics}
        matrix.append({"site": s, "n_notes": int(g.late.n), "cells": cells})
        if family == "opd":
            mix = cells["M-OPD-02"]
            band_mix.append({"site": s, "counts": (mix.get("extra") or {}).get("counts"), "bands": mix["extra"]["band_stats"]})
        for m, st in cells.items():
            ci = st["ci95"] or [None, None]
            rows.append({"site": s, "metric_id": m, "label": st["label"], "value": st["value"], "unit": st["unit"], "n": st["n"], "status": st["status"], "ci_lo": ci[0], "ci_hi": ci[1]})
    trend = []
    if family == "opd":
        wby = groups_by(wds, site_of(wds))
        wall = wds.group()
        for s in sites:
            g = wall if s == "ALL" else wby.get(s)
            if g is None:
                continue
            for m in TREND_METRICS:
                pts = []
                for k in range(days // 7 - 1, -1, -1):
                    wk = Window(wds.late.to - dt.timedelta(days=7 * k + 6), wds.late.to - dt.timedelta(days=7 * k))
                    wd = Dataset(run, wk, None, [], ds.docs, {}, False)
                    st = metric_stat(m, Group(late=g.periods.get(f"w{k}", OpdAgg())), wd, "all" if s == "ALL" else "site")
                    pts.append({"week_from": wk.frm.isoformat(), "week_to": wk.to.isoformat(), "value": st["value"], "n": st["n"], "status": st["status"]})
                trend.append({"site": s, "metric_id": m, "points": pts})
    head = matrix[0]["cells"][metrics[0]]
    below = [m["site"] for m in matrix[1:] if any(c["status"] == "count_only" for c in m["cells"].values())]
    env = build_envelope(
        run, ds.late, sentence(head), head.get("plain") or sentence(head), [c for m in matrix for c in m["cells"].values()],
        caveats=(SITE_CAVEAT, *((sc["caption"],) if sc["withheld"] else ())),
        action=("Governance leads: site comparison is paused until each note has a site; read the hospital-wide row." if sc["withheld"] else "Site medical heads: read your own row first; " + (f"{', '.join(below)} have too few audited notes for some measures." if below else "all listed sites have enough audited notes.")),
    )
    view = {"envelope": env, "site_basis": "doctor_home_site", "site_comparison": sc, "sites": site_list, "matrix_sites": sites, "band_mix": band_mix, "metrics": [{"metric_id": m, "label": METRICS[m]["label"], "unit": METRICS[m]["unit"]} for m in metrics], "matrix": matrix, "trend": trend}
    return wrap(run, "cdmss_v2_scorecard", ["site", "metric_id", "label", "value", "unit", "n", "status", "ci_lo", "ci_hi"], rows, view)


def funnel_points(p_bar: float, max_n: int) -> list:
    top = max(max_n, 60)
    ns = sorted({int(round(DOCTOR_MIN_N + (top - DOCTOR_MIN_N) * i / 24)) for i in range(25)})
    out = []
    for n in ns:
        lo95, hi95 = funnel_limit(p_bar, n, Z95)
        lo998, hi998 = funnel_limit(p_bar, n, Z998)
        out.append({"n": n, "lo95": lo95, "hi95": hi95, "lo998": lo998, "hi998": hi998})
    return out


def position(rate: float, p_bar: float, n: int) -> str:
    lo95, hi95 = funnel_limit(p_bar, n, Z95)
    lo998, hi998 = funnel_limit(p_bar, n, Z998)
    return "above_998" if rate > hi998 else "above_95" if rate > hi95 else "below_998" if rate < lo998 else "below_95" if rate < lo95 else "within"


async def build_v3(run: Run, days: int, metric: str, site: Optional[str], specialty: Optional[str]) -> str:
    ds = await load_dataset(run, days)
    await refuse_site_filter_if_withheld(run, days, site, ds)
    ok_doc = lambda u: (site is None or ds.doc(u).site == site) and (specialty is None or (ds.doc(u).speciality or "").lower() == specialty.lower())  # noqa: E731
    gs = groups_by(ds, lambda u: u if ok_doc(u) else None)
    rows, doctors, excluded = [], [], 0
    included = [g for g in gs.values() if g.late.n >= FUNNEL_MIN_N]
    p_bar = _ratio(sum(g.late.n_lv_notes for g in included), sum(g.late.n for g in included)) if included else None
    for uid, g in gs.items():
        L = g.late
        if L.n <= 0:
            continue
        d = ds.doc(uid)
        if metric == "lv_rate":
            st = metric_stat("M-OPD-05b", g, ds, "doctor")
            oe = metric_stat("M-OPD-06", g, ds, "doctor")
            ci = wilson(L.n_lv_notes, L.n)
            value = _ratio(L.n_lv_notes, L.n)
            small = L.n < DOCTOR_MIN_N
            pos = "greyed" if (small or L.n < FUNNEL_MIN_N or p_bar is None) else position(value, p_bar, int(L.n))
            row = {"doctor_uid": uid, "doctor_name": d.name, "site": d.site, "speciality": d.speciality, "n": int(L.n), "value": None if small else value,
                   "ci95": None if small or ci is None else list(ci), "numerator": None if small else L.n_lv_notes, "denominator": None if small else L.n,
                   "expected_rate": None if small else oe["extra"]["expected_rate"] if oe.get("extra") else None, "oe": None if small else oe["value"], "position": pos, "stat": st}
        else:
            st = metric_stat("M-OPD-01", g, ds, "doctor")
            row = {"doctor_uid": uid, "doctor_name": d.name, "site": d.site, "speciality": d.speciality, "n": int(L.n_assessed), "value": st["value"],
                   "ci95": st["ci95"], "numerator": st["numerator"], "denominator": st["denominator"], "expected_rate": None, "oe": None,
                   "position": "greyed" if st["status"] != "ok" else "ranked", "stat": st}
        if st["status"] == "count_only":
            excluded += 1
            row["rank"] = None
        doctors.append(row)
    ranked = sorted((r for r in doctors if r["stat"]["status"] == "ok" and r["value"] is not None), key=lambda r: -r["value"])
    for i, r in enumerate(ranked, 1):
        r["rank"] = i
    for r in doctors:
        r.setdefault("rank", None)
    doctors.sort(key=lambda r: (r["rank"] is None, r["rank"] or 0, -r["n"]))
    above = [r for r in doctors if r["position"] == "above_998"]
    funnel = None
    if metric == "lv_rate":
        funnel = {"centre": p_bar, "centre_basis": "pooled rate over doctors with at least 50 audited notes", "z95": Z95, "z998": Z998,
                  "adjustment": "plain binomial limits (the catalogue's method): no overdispersion adjustment and no age adjustment", "min_n_include": FUNNEL_MIN_N,
                  "limits": funnel_points(p_bar, max((int(g.late.n) for g in included), default=0)) if p_bar is not None else []}
    head = metric_stat("M-OPD-05b" if metric == "lv_rate" else "M-OPD-01", ds.group(ok_doc), ds, "all")
    env = build_envelope(
        run, ds.late, sentence(head), head.get("plain") or sentence(head), [head],
        caveats=(SITE_CAVEAT, "Variation between doctors reflects case mix and documentation habits as well as quality; a position beyond a limit is a prompt to look, not a verdict.")
        + (("Funnel limits are plain binomial around the pooled rate (no overdispersion adjustment).",) if metric == "lv_rate" else ()),
        action=(f"Site medical heads: review the {len(above)} doctor(s) above the 99.8% limit first, with their notes in the worklist." if above else "Site medical heads: no doctor is beyond the 99.8% limit; read the ranked list for the widest intervals."),
    )
    for r in doctors:
        ci = r["ci95"] or [None, None]
        rows.append({"doctor_uid": r["doctor_uid"], "doctor_name": r["doctor_name"], "site": r["site"], "speciality": r["speciality"], "n": r["n"], "value": r["value"], "ci_lo": ci[0], "ci_hi": ci[1], "position": r["position"]})
    view = {"envelope": env, "metric": metric, "funnel": funnel, "doctors": doctors, "excluded": {"count": excluded, "reason": f"fewer than {DOCTOR_MIN_N} audited notes"}}
    return wrap(run, "cdmss_v3_doctor_variation", ["doctor_uid", "doctor_name", "site", "speciality", "n", "value", "ci_lo", "ci_hi", "position"], rows, view)


async def build_v4(run: Run, days: int, site: str) -> str:
    ds = await load_dataset(run, days)
    sc = site_comparison(ds)
    if sc["withheld"]:
        # The whole view is a site comparison: show the caption and the hospital-wide figure only.
        all_stat = metric_stat("M-OPD-05b", ds.group(), ds, "all")
        other = {**withheld_stat(all_stat, sc["caption"]), "n": 0}
        site_list = [{"code": "ALL", "label": "All sites", "n": int(ds.group().late.n)}]  # no per-site counts while withheld
        env = build_envelope(run, ds.late, f"{sc['caption']} {sentence(all_stat)}", all_stat.get("plain") or sentence(all_stat), [all_stat], caveats=(SITE_CAVEAT, sc["caption"]),
                             action="Governance leads: contributors by site are paused until each note has a site; use the hospital-wide figure and the doctor variation view.")
        view = {"envelope": env, "site": site, "sites": site_list, "site_comparison": sc, "metric": "lv_rate", "site_rate": all_stat, "other_sites_rate": other, "gap": None, "contributors": [], "top_contributor_removed": None}
        return wrap(run, "cdmss_v4_contributors", ["doctor_uid", "doctor_name", "n", "events", "rate", "share_of_gap", "rate_without"], [], view)
    gs = groups_by(ds, lambda u: u if ds.doc(u).site == site else None)
    in_site = ds.group(lambda u: ds.doc(u).site == site)
    other = ds.group(lambda u: ds.doc(u).site != site)
    s_n, s_e = in_site.late.n, in_site.late.n_lv_notes
    o_n, o_e = other.late.n, other.late.n_lv_notes
    site_stat = metric_stat("M-OPD-05b", in_site, ds, "site")
    other_stat = metric_stat("M-OPD-05b", other, ds, "site")
    rate_site, rate_other = _ratio(s_e, s_n), _ratio(o_e, o_n)
    site_small = s_n < GROUP_MIN_N  # under the site floor: the gap, the other sites' inputs and every share would give the site's rate back
    other_small = o_n < GROUP_MIN_N  # the other sites together under the floor: their rate, and any gap against it, would be one division from a small group's
    if site_small or other_small:
        why = f"{site} has" if site_small else "the other sites together have"
        other_stat = {**other_stat, "value": None, "numerator": None, "denominator": None, "ci95": None, "ci_method": "none", "change": None, "plain": None,
                      "status": "count_only", "grey_reason": "min_n", "n": 0 if site_small else int(o_n), "note": f"Withheld: {why} fewer than {GROUP_MIN_N} audited notes."}
        if other_stat.get("extra"):
            other_stat["extra"] = None
    gap = None
    excess = None
    if not site_small and not other_small and rate_site is not None and rate_other is not None:
        gap = {"absolute": rate_site - rate_other, "relative": (rate_site - rate_other) / rate_other if rate_other else None}
        excess = s_e - s_n * rate_other
    contributors = []
    for uid, g in gs.items():
        L = g.late
        d = ds.doc(uid)
        small = L.n < DOCTOR_MIN_N
        ci = wilson(L.n_lv_notes, L.n)
        share = None
        if not small and not site_small and not other_small and excess is not None and excess > 0 and rate_other is not None:
            share = (L.n_lv_notes - L.n * rate_other) / excess
        # the remainder must itself be a group above the doctor floor, else it is one small doctor's rate
        without = _ratio(s_e - L.n_lv_notes, s_n - L.n) if s_n - L.n >= DOCTOR_MIN_N and not site_small else None
        contributors.append({"doctor_uid": uid, "doctor_name": d.name, "n": int(L.n), "events": None if small else int(L.n_lv_notes), "rate": None if small else _ratio(L.n_lv_notes, L.n),
                             "ci95": None if small or ci is None else list(ci), "share_of_gap": share, "site_rate_without": None if small else without,
                             "status": "count_only" if small else "ok"})
    contributors.sort(key=lambda r: (r["status"] != "ok", -(r["share_of_gap"] if r["share_of_gap"] is not None else -9e9), -r["n"]))
    top = next((c for c in contributors if c["share_of_gap"] is not None), None)
    sentence_ = sentence(site_stat)
    if gap and gap["absolute"] is not None and site_stat["status"] == "ok":
        direction = "above" if gap["absolute"] > 0 else "below"
        sentence_ = f"At {site}, {100 * rate_site:.0f}% of notes carry a low-value finding, {abs(100 * gap['absolute']):.0f} points {direction} the other sites ({100 * rate_other:.0f}%), over {int(s_n)} notes."
    env = build_envelope(
        run, ds.late, sentence_, site_stat.get("plain") or sentence_, [site_stat, other_stat], caveats=(SITE_CAVEAT, "A doctor's share of the gap is their excess over the other sites' rate; it describes the site's number, not individual quality."),
        action=(f"Site medical head for {site}: start with the largest contributor's notes; removing them moves the site rate to {100 * top['site_rate_without']:.0f}%." if top and top["site_rate_without"] is not None else f"Site medical head for {site}: no single contributor stands out."),
    )
    rows = [{"doctor_uid": c["doctor_uid"], "doctor_name": c["doctor_name"], "n": c["n"], "events": c["events"], "rate": c["rate"], "share_of_gap": c["share_of_gap"], "rate_without": c["site_rate_without"]} for c in contributors]
    all_sites = groups_by(ds, site_of(ds))
    site_list = [{"code": "ALL", "label": "All sites", "n": int(ds.group().late.n)}] + [{"code": k, "label": k, "n": int(all_sites[k].late.n)} for k in sorted(all_sites)]
    view = {"envelope": env, "site": site, "sites": site_list, "site_comparison": sc, "metric": "lv_rate", "site_rate": site_stat, "other_sites_rate": other_stat, "gap": gap, "contributors": contributors,
            "top_contributor_removed": None if not top else {"doctor_uid": top["doctor_uid"], "site_rate_without": top["site_rate_without"]}}
    return wrap(run, "cdmss_v4_contributors", ["doctor_uid", "doctor_name", "n", "events", "rate", "share_of_gap", "rate_without"], rows, view)


IMPORTANCE_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3}
_REF_SITE = re.compile(r"^([A-Za-z0-9]{2,8})-")


def _resp_required(v: Any) -> bool:
    return str(v if v is not None else "none").strip().lower() not in ("", "none", "false", "no")


def _signal_row(r: dict, docs: dict) -> dict:
    d = docs.get(r.get("doctor_uid")) or Doc(r.get("doctor_uid") or "")
    m = _REF_SITE.match(r.get("reference") or "")
    return {
        "signal_id": r.get("signal_id"), "reference": r.get("reference"), "doctor_uid": r.get("doctor_uid"), "doctor_name": d.name,
        "site": m.group(1).upper() if m else d.site, "signal_type": r.get("signal_type"), "importance": r.get("importance"), "status": r.get("status"),
        "response_required": _resp_required(r.get("response_required")), "window_from": r.get("window_from"), "window_to": r.get("window_to"),
        "sla_due_at": r.get("sla_due_at"), "overdue": bool(r.get("overdue")),
    }


def _site_args(ds_docs: dict, site: Optional[str]) -> tuple[Optional[list], Optional[str]]:
    if not site:
        return None, None
    return sorted(u for u, d in ds_docs.items() if d.site == site), f"{site}-"


async def note_cutoff(run: Run, window: "Window") -> None:
    for r in await run.q("cdmss", NOTE_CUTOFF_SQL, {"from": window.frm, "to": window.to}, "cdmss_ro.opd_note_audit"):
        if r.get("cutoff"):
            run.cutoffs.append(r["cutoff"])


async def signals_for(run: Run, directory: dict, *, site, doctor, overdue_only: bool, limit: int, offset: int) -> tuple[list, int]:
    doctors, prefix = _site_args(directory, site)
    rows = await run.q("cdmss", SIGNALS_SQL, {"overdue_only": overdue_only, "doctor": doctor, "doctors": doctors, "prefix": prefix, "limit": limit, "offset": offset}, "cdmss_ro.gov_signal")
    total = int(rows[0]["total_count"]) if rows else 0
    run.cutoffs.extend(t for r in rows for t in (r.get("created_at"), r.get("updated_at")) if t)  # the newest signal thread read
    await fill_names(run, directory, {r["doctor_uid"] for r in rows if r.get("doctor_uid")})
    return [_signal_row(r, directory) for r in rows], total


async def build_v5(run: Run, days: int, site: Optional[str], doctor: Optional[str], limit: int) -> str:
    window, _ = window_pair(days, run.today)
    await refuse_site_filter_if_withheld(run, days, site)
    directory = await load_directory(run)
    signals, total = await signals_for(run, directory, site=site, doctor=doctor, overdue_only=False, limit=LIST_CAP, offset=0)
    by_doc: dict = {}
    for s in signals:
        if s["doctor_uid"]:
            by_doc.setdefault(s["doctor_uid"], []).append(s)
    rank = lambda sigs: min((IMPORTANCE_RANK.get(str(x["importance"]).lower(), 9) for x in sigs), default=9)  # noqa: E731
    uids = sorted(by_doc, key=lambda u: (rank(by_doc[u]), -len(by_doc[u]), u))[:limit]
    ev_rows: list = []
    if uids:
        ev_rows, _ = await gather_all(
            run.q("cdmss", findings_sql("redflag", by_doctors=True, by_one_doctor=False), {"from": window.frm, "to": window.to, "doctors": uids, "limit": LIST_CAP, "offset": 0, "r5": R5_RULE_REF}, "cdmss_ro.opd_finding"),
            note_cutoff(run, window),
        )
    ev: dict = {}
    for r in ev_rows:
        lst = ev.setdefault(r["doctor_uid"], [])
        if len(lst) < 5:
            lst.append(evidence_row(r, directory))
    dossiers, rows = [], []
    for u in uids:
        d = directory.get(u) or Doc(u)
        sigs = by_doc[u]
        top = min(sigs, key=lambda x: IMPORTANCE_RANK.get(str(x["importance"]).lower(), 9))
        dossiers.append({"doctor_uid": u, "doctor_name": d.name, "site": d.site, "signals": sigs, "evidence": ev.get(u, [])})
        rows.append({"doctor_uid": u, "doctor_name": d.name, "site": d.site, "n_signals": len(sigs), "n_open": len(sigs), "top_importance": top["importance"], "n_evidence": len(ev.get(u, []))})
    st = count_stat("M-SIG-01", window, total)
    overdue = sum(1 for s in signals if s["overdue"])
    headline = f"{total} open governance signal thread(s) across {len(by_doc)} doctor(s); {overdue} are past their response deadline."
    env = build_envelope(
        run, window, headline, headline, [st],
        caveats=("Open signals are not limited to the window; the window bounds the evidence findings shown.", "Red-flag basis: open governance signals, with each doctor's recent low-value and interaction findings as evidence. Importance and status vocabularies are shown as stored."),
        action="Governance leads: work the overdue threads first, then the highest-importance dossiers; each evidence line opens the CDMSS case.",
    )
    view = {"envelope": env, "dossiers": dossiers}
    return wrap(run, "cdmss_v5_redflags", ["doctor_uid", "doctor_name", "site", "n_signals", "n_open", "top_importance", "n_evidence"], rows, view, total=len(rows))


WORKLIST_COLUMNS = {
    "signals_open": ["reference", "doctor_uid", "doctor_name", "site", "signal_type", "importance", "status", "response_required", "window_from", "window_to", "sla_due_at", "overdue", "case_url"],
    "signals_overdue": ["reference", "doctor_uid", "doctor_name", "site", "signal_type", "importance", "status", "response_required", "window_from", "window_to", "sla_due_at", "overdue", "case_url"],
    "low_value_findings": ["note_day", "doctor_uid", "doctor_name", "site", "uid", "finding_no", "subject", "lvc_category", "rule_ref", "quote", "case_url"],
    "missing_pdqi": ["note_day", "doctor_uid", "doctor_name", "site", "uid", "nqi", "raw_band", "case_url"],
}
KIND_OF = {"label": None, "value": None}


def _columns_meta(cols: list) -> list:
    num = {"finding_no", "nqi", "n", "value"}
    boolean = {"overdue", "response_required"}
    return [{"key": c, "label": c.replace("_", " "), "kind": "link" if c == "case_url" else "number" if c in num else "boolean" if c in boolean else "text"} for c in cols]


async def build_v8(run: Run, days: int, lst: str, site: Optional[str], doctor: Optional[str], limit: int, offset: int) -> str:
    window, _ = window_pair(days, run.today)
    await refuse_site_filter_if_withheld(run, days, site)
    directory = await load_directory(run)
    cols = WORKLIST_COLUMNS[lst]
    rows: list = []
    total = 0
    if lst in ("signals_open", "signals_overdue"):
        rows, total = await signals_for(run, directory, site=site, doctor=doctor, overdue_only=lst == "signals_overdue", limit=limit, offset=offset)
        for r in rows:
            r["case_url"] = None
        st = count_stat("M-SIG-01", window, total)
        windowed = "Signals are not limited to the window."
    else:
        doctors = None
        if site:
            doctors = sorted(u for u, d in directory.items() if d.site == site)
        if site and not doctors:
            raw: list = []
        else:
            p = {"from": window.frm, "to": window.to, "doctors": doctors, "doctor": doctor, "limit": limit, "offset": offset, "r5": R5_RULE_REF}
            if lst == "low_value_findings":
                read = run.q("cdmss", findings_sql("lv", by_doctors=doctors is not None, by_one_doctor=doctor is not None), p, "cdmss_ro.opd_finding")
            else:
                read = run.q("cdmss", notes_list_sql(NOTE_ORDERS["recent"], False, True, doctors is not None, doctor is not None), p, "cdmss_ro.opd_note_audit")
            raw, _ = await gather_all(read, note_cutoff(run, window))
        total = int(raw[0]["total_count"]) if raw else 0
        await fill_names(run, directory, {r["doctor_uid"] for r in raw})
        for r in raw:
            d = directory.get(r["doctor_uid"]) or Doc(r["doctor_uid"])
            base = {"note_day": r.get("note_day"), "doctor_uid": r["doctor_uid"], "doctor_name": d.name, "site": d.site, "uid": r.get("uid"), "case_url": case_url(r.get("uid"))}
            if lst == "low_value_findings":
                rows.append({**base, "finding_no": r.get("finding_no"), "subject": r.get("subject"), "lvc_category": r.get("lvc_category"), "rule_ref": r.get("rule_ref"), "quote": quote_of(r.get("evidence"))})
            else:
                rows.append({**base, "nqi": r.get("nqi"), "raw_band": r.get("raw_band")})
        st = count_stat("M-WL-01" if lst == "low_value_findings" else "M-WL-02", window, total)
        windowed = None
    label = {"signals_open": "open signal threads", "signals_overdue": "overdue signal threads", "low_value_findings": "low-value findings", "missing_pdqi": "notes without a PDQI-9 assessment"}[lst]
    headline = f"{total} {label}" + (f" between {window.frm} and {window.to}." if windowed is None else ".") + (f" Showing {len(rows)} (up to {LIST_CAP} per page)." if total > len(rows) else "")
    env = build_envelope(run, window, headline, headline, [st], caveats=(windowed,) if windowed else (), action="Work the list top to bottom; each row opens the CDMSS case. Export the table to share it.")
    view = {"envelope": env, "list": lst, "columns_meta": _columns_meta(cols), "total": total}
    return wrap(run, "cdmss_v8_worklists", cols, rows, view, total=total)


# --------------------------------------------------------------------------------------------------------------
# T1 / T2
# --------------------------------------------------------------------------------------------------------------


async def build_catalogue(run: Run) -> str:
    window, _ = window_pair(7, run.today)
    run.sources.append(NO_DB_SOURCE)
    items = [METRICS[k] for k in CATALOGUE_IDS]
    env = build_envelope(run, window, f"{len(items)} catalogue metrics are defined for Phase 1; {sum(1 for i in items if i['status'] == 'unavailable')} cannot be reported yet and say why.", "", [], action="Ask for a metric by id; unavailable ones explain what data is missing.")
    rows = [{"id": i["id"], "label": i["label"], "family": i["family"], "status": i["status"], "unit": i["unit"]} for i in items]
    return wrap(run, "cdmss_metric_catalogue", ["id", "label", "family", "status", "unit"], rows, {"envelope": env, "metrics": items})


async def build_metric(run: Run, mid: str, days: int, group_by: str, site: Optional[str], doctor: Optional[str], limit: int) -> str:
    meta = METRICS[mid]
    if meta["status"] == "unavailable":
        window, _ = window_pair(days, run.today)
        run.sources.append(NO_DB_SOURCE)
        st = stat(mid, window)
        env = build_envelope(run, window, sentence(st), "", [st], action="No action: the data does not exist yet. Governance leads can decide whether to source it.")
        return wrap(run, "cdmss_metric", ["key", "label", "value", "unit", "n", "status"], [], {"envelope": env, "metric": meta, "groups": []})
    ds = await load_dataset(run, days, need_rx=mid in RX_METRICS)
    await refuse_site_filter_if_withheld(run, days, site, ds)
    pred = _site_pred(ds, site, doctor)
    if group_by == "none":
        gmap = {"ALL": ds.group(pred)}
        kind = "all"
    elif group_by == "site":
        gmap = {k: v for k, v in groups_by(ds, lambda u: site_of(ds)(u) if pred(u) else None).items()}
        kind = "site"
    else:
        gmap = groups_by(ds, lambda u: u if pred(u) else None)
        kind = "doctor"
    sc = site_comparison(ds)
    site_withheld = group_by == "site" and sc["withheld"]
    groups = []
    for k, g in gmap.items():
        st = metric_stat(mid, g, ds, kind)
        if site_withheld:
            st = withheld_stat(st, sc["caption"])
        label = k if group_by != "doctor" else (ds.doc(k).name or k)
        groups.append({"key": k, "label": label, "site": ds.doc(k).site if group_by == "doctor" else (k if group_by == "site" else None), "stat": st})
    groups.sort(key=lambda x: (x["stat"]["status"] not in ("ok", "greyed"), -(x["stat"]["value"] if x["stat"]["value"] is not None else -9e9), -x["stat"]["n"]))
    groups = groups[:limit]
    head = groups[0]["stat"] if group_by == "none" and groups else metric_stat(mid, ds.group(pred), ds, "all")
    env = build_envelope(run, ds.late, sentence(head), head.get("plain") or sentence(head), [head] if group_by == "none" else [head, *[x["stat"] for x in groups]], caveats=((SITE_CAVEAT,) if group_by == "site" or site else ()) + ((sc["caption"],) if site_withheld else ()),
                         action="Governance leads: use the doctor view for outliers and the worklist for the notes behind the number.")
    rows = [{"key": x["key"], "label": x["label"], "value": x["stat"]["value"], "unit": x["stat"]["unit"], "n": x["stat"]["n"], "status": x["stat"]["status"]} for x in groups]
    return wrap(run, "cdmss_metric", ["key", "label", "value", "unit", "n", "status"], rows, {"envelope": env, "metric": meta, "groups": groups, "site_comparison": sc})


DRILL = {
    "M-OPD-01": ("notes", "nqi_asc", True), "M-OPD-02": ("notes", "nqi_asc", True), "M-OPD-03": ("notes", "nqi_asc", False), "M-OPD-04": ("notes", "completeness_asc", False),
    "M-OPD-05": ("findings", "lv", None), "M-OPD-05b": ("findings", "lv", None), "M-OPD-06": ("findings", "lv", None), "M-OPD-08": ("findings", "dup", None), "M-OPD-12": ("findings", "nsaid", None), "M-AMS-03": ("findings", "r5", None),
}
DRILL_COLUMNS = ["note_day", "doctor_uid", "doctor_name", "site", "uid", "finding_no", "subject", "value", "quote", "case_url"]


async def build_drilldown(run: Run, mid: str, days: int, site: Optional[str], doctor: Optional[str], limit: int, offset: int) -> str:
    window, _ = window_pair(days, run.today)
    spec = DRILL.get(mid)
    if spec is None:
        reason = METRICS[mid]["definition"] if METRICS[mid]["status"] == "unavailable" else "This metric's numerator lives in the DB13 extract, so there are no CDMSS rows to list."
        env = build_envelope(run, window, f"No rows to list for {mid}.", "", [], caveats=(reason,), action="")
        return wrap(run, "cdmss_drilldown", DRILL_COLUMNS, [], {"envelope": env, "metric_id": mid, "total": 0}, total=0)
    await refuse_site_filter_if_withheld(run, days, site)
    directory = await load_directory(run)
    doctors = sorted(u for u, d in directory.items() if d.site == site) if site else None
    rows: list = []
    total = 0
    if not (site and not doctors):
        p = {"from": window.frm, "to": window.to, "doctors": doctors, "doctor": doctor, "limit": limit, "offset": offset, "r5": R5_RULE_REF}
        kind, which, assessed = spec
        if kind == "findings":
            read = run.q("cdmss", findings_sql(which, by_doctors=doctors is not None, by_one_doctor=doctor is not None), p, "cdmss_ro.opd_finding")
        else:
            read = run.q("cdmss", notes_list_sql(NOTE_ORDERS[which], bool(assessed), False, doctors is not None, doctor is not None), p, "cdmss_ro.opd_note_audit")
        raw, _ = await gather_all(read, note_cutoff(run, window))
        total = int(raw[0]["total_count"]) if raw else 0
        await fill_names(run, directory, {r["doctor_uid"] for r in raw})
        for r in raw:
            d = directory.get(r["doctor_uid"]) or Doc(r["doctor_uid"])
            base = {"note_day": r.get("note_day"), "doctor_uid": r["doctor_uid"], "doctor_name": d.name, "site": d.site, "uid": r.get("uid"), "case_url": case_url(r.get("uid"))}
            if kind == "findings":
                rows.append({**base, "finding_no": r.get("finding_no"), "subject": r.get("subject"), "value": r.get("confidence"), "quote": quote_of(r.get("evidence"))})
            else:
                rows.append({**base, "finding_no": None, "subject": f"raw band {r.get('raw_band')}", "value": r.get("completeness_pct") if which == "completeness_asc" else r.get("nqi"), "quote": None})
    st = count_stat("M-WL-01", window, total)
    head = f"{total} row(s) behind {mid} between {window.frm} and {window.to}." + (f" Showing {len(rows)}." if total > len(rows) else "")
    env = build_envelope(run, window, head, head, [st], caveats=(SITE_CAVEAT,) if site else (), action="Open the case from any row; quotes are the audit's evidence text.")
    return wrap(run, "cdmss_drilldown", DRILL_COLUMNS, rows, {"envelope": env, "metric_id": mid, "total": total}, total=total)


async def build_finding_detail(run: Run, uid: str, finding_no: Optional[int]) -> str:
    window, _ = window_pair(7, run.today)
    hdr = await run.q("cdmss", NOTE_HEADER_SQL, {"uid": uid}, "cdmss_ro.opd_note_audit")
    fnd = await run.q("cdmss", FINDING_DETAIL_SQL, {"uid": uid, "finding_no": finding_no}, "cdmss_ro.opd_finding")
    run.cutoffs.extend(h["audited_at"] for h in hdr if h.get("audited_at"))
    directory = await load_directory(run)
    uids = {r["doctor_uid"] for r in [*hdr, *fnd] if r.get("doctor_uid")}
    await fill_names(run, directory, uids)
    note = None
    if hdr:
        h = hdr[0]
        d = directory.get(h["doctor_uid"]) or Doc(h["doctor_uid"] or "")
        note = {"uid": h["uid"], "audit_id": h["audit_id"], "doctor_uid": h["doctor_uid"], "doctor_name": d.name, "note_day": h["note_day"], "engine_version": h["engine_version"],
                "raw_band": h["raw_band"], "nqi": h["nqi"], "pdqi9_assessed": bool(h["assessed"])}
        run.versions.add(h["engine_version"])
    findings = [{**evidence_row(r, directory), "confidence": r.get("confidence"), "source": r.get("source"), "concept_id": r.get("concept_id")} for r in fnd]
    head = f"Note {uid}: {len(findings)} finding(s)." if hdr else f"No audited note was found for {uid}."
    env = build_envelope(run, window, head, head, [], caveats=("Finding text and quotes are the audit's own and may be wrong or contested.",), action="Open the CDMSS case to see the note in context.")
    cols = ["finding_no", "subject", "verdict", "signal_type", "rule_ref", "quote", "rationale", "case_url"]
    rows = [{**f, "case_url": f["case"]["url"]} for f in findings]
    return wrap(run, "cdmss_finding_detail", cols, rows, {"envelope": env, "note": note, "findings": findings, "case": {"url": case_url(uid), "url_verified": False}})


# --------------------------------------------------------------------------------------------------------------
# Tools (typed args; SQL is fixed above; staff id from the graph config)
# --------------------------------------------------------------------------------------------------------------

SITE_RE = r"^[A-Za-z0-9_\- ]{1,20}$"
UID_RE = r"^[A-Za-z0-9_.\-:]{1,80}$"
Site = Field(default=None, pattern=SITE_RE, description="Site code, e.g. EHRC (the doctor's home site).")
DoctorUid = Field(default=None, pattern=UID_RE, description="CDMSS doctor uid.")
Days = lambda default: Field(default=default, ge=7, le=182, description="Window in days (7-182), IST calendar days ending today.")  # noqa: E731


class NoArgs(BaseModel):
    pass


class V1Args(BaseModel):
    window_days: int = Days(7)


class V2Args(BaseModel):
    window_days: int = Days(28)
    family: Literal["opd", "ams"] = "opd"
    site: Optional[str] = Site


class V3Args(BaseModel):
    window_days: int = Days(28)
    metric: Literal["lv_rate", "nqi"] = "lv_rate"
    site: Optional[str] = Site
    specialty: Optional[str] = Field(default=None, max_length=80)


class V4Args(BaseModel):
    window_days: int = Days(28)
    site: str = Field(pattern=SITE_RE, description="Site code (required).")
    metric: Literal["lv_rate"] = "lv_rate"


class V5Args(BaseModel):
    window_days: int = Days(28)
    site: Optional[str] = Site
    doctor_uid: Optional[str] = DoctorUid
    limit: int = Field(default=50, ge=1, le=LIST_CAP)


class V8Args(BaseModel):
    list: Literal["signals_open", "signals_overdue", "low_value_findings", "missing_pdqi"] = "signals_open"
    window_days: int = Days(28)
    site: Optional[str] = Site
    doctor_uid: Optional[str] = DoctorUid
    limit: int = Field(default=LIST_CAP, ge=1, le=LIST_CAP)
    offset: int = Field(default=0, ge=0, le=MAX_OFFSET)


class MetricArgs(BaseModel):
    metric_id: Literal[CATALOGUE_IDS]  # type: ignore[valid-type]
    window_days: int = Days(28)
    group_by: Literal["none", "site", "doctor"] = "none"
    site: Optional[str] = Site
    doctor_uid: Optional[str] = DoctorUid
    limit: int = Field(default=50, ge=1, le=LIST_CAP)


class DrillArgs(BaseModel):
    metric_id: Literal[CATALOGUE_IDS]  # type: ignore[valid-type]
    window_days: int = Days(28)
    site: Optional[str] = Site
    doctor_uid: Optional[str] = DoctorUid
    limit: int = Field(default=100, ge=1, le=LIST_CAP)
    offset: int = Field(default=0, ge=0, le=MAX_OFFSET)


class FindingArgs(BaseModel):
    uid: str = Field(pattern=UID_RE, description="OPD note uid.")
    finding_no: Optional[int] = Field(default=None, ge=1, le=10_000)


# --------------------------------------------------------------------------------------------------------------
# Result cache (300 s) and single-flight. Same tool + same normalised params + same IST day => the finished payload is reused;
# identical requests that arrive while one is running share that run. Nothing about SQL or numbers changes. Only successful
# payloads are cached. Every request is audited: a real run audits each query, a hit or a shared result audits one cache row.
# --------------------------------------------------------------------------------------------------------------

_cache: "OrderedDict" = OrderedDict()  # key -> (monotonic_at, cached_at_iso, payload dict), least recently used first
_inflight: dict = {}  # key -> asyncio.Future of the payload dict


def clear_cache() -> None:
    _cache.clear()
    _inflight.clear()


def _cache_put(key, entry) -> None:
    now = time.monotonic()
    for k in [k for k, v in _cache.items() if now - v[0] >= CACHE_TTL_S]:  # expired entries go first
        del _cache[k]
    _cache[key] = entry
    _cache.move_to_end(key)
    while len(_cache) > CACHE_MAX_ENTRIES:
        _cache.popitem(last=False)


def _cached_copy(payload: dict, at_iso: str) -> str:
    out = copy.deepcopy(payload)
    try:
        prov = out["view"]["envelope"]["provenance"]
        prov["cached_at"] = at_iso
        prov["cached"] = True
    except (KeyError, TypeError):
        pass
    return json.dumps(out)


async def cached(run: Run, build: Callable[[], Awaitable[str]]) -> str:
    key = (run.tool, run.today.isoformat(), json.dumps(run.params, sort_keys=True, default=str))
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < CACHE_TTL_S:
        _cache.move_to_end(key)
        await run.audit_cache()
        return _cached_copy(hit[2], hit[1])
    fut = _inflight.get(key)
    if fut is not None:
        try:
            payload, at_iso = await asyncio.shield(fut)
        except asyncio.CancelledError:
            if fut.cancelled():  # the leader was cancelled (its client gave up), not this request: run it ourselves
                return await build()
            raise
        await run.audit_cache()
        return _cached_copy(payload, at_iso)
    fut = asyncio.get_running_loop().create_future()
    _inflight[key] = fut
    try:
        body = await build()
        payload = json.loads(body)
        at_iso = dt.datetime.now(KOLKATA).isoformat(timespec="seconds")
        _cache_put(key, (time.monotonic(), at_iso, payload))
        if not fut.done():
            fut.set_result((payload, at_iso))
        return body
    except BaseException as exc:
        if not fut.done():
            if isinstance(exc, asyncio.CancelledError):
                fut.cancel()
            else:
                fut.set_exception(exc)
                fut.exception()  # mark retrieved: no "never retrieved" warning when nobody else was waiting
        raise
    finally:
        _inflight.pop(key, None)


def _args(**kw) -> dict:
    return {k: v for k, v in kw.items()}


@tool(args_schema=V1Args)
async def cdmss_v1_this_week(window_days: int = 7, config: RunnableConfig = None) -> str:
    """CDMSS module home: this week's OPD note-audit and antimicrobial-stewardship tiles (mean NQI with coverage, Clinical NQI,
    band mix, low-value findings per 100 notes, completeness, URTI antibiotics) with change against the previous period. Read-only.
    Returns the module envelope (provenance, headline, stats, caveats, action line)."""
    run = Run("cdmss_v1_this_week", _args(window_days=window_days), config)
    return await cached(run, lambda: build_v1(run, window_days))


@tool(args_schema=V2Args)
async def cdmss_v2_scorecard(window_days: int = 28, family: str = "opd", site: Optional[str] = None, config: RunnableConfig = None) -> str:
    """CDMSS family scorecard: a site-by-measure matrix and weekly trend lines for the OPD note audit or antimicrobial stewardship. Read-only."""
    run = Run("cdmss_v2_scorecard", _args(window_days=window_days, family=family, site=site), config)
    return await cached(run, lambda: build_v2(run, window_days, family, site))


@tool(args_schema=V3Args)
async def cdmss_v3_doctor_variation(window_days: int = 28, metric: str = "lv_rate", site: Optional[str] = None, specialty: Optional[str] = None, config: RunnableConfig = None) -> str:
    """CDMSS doctor variation: a funnel plot (share of notes with a low-value finding, with 95% and 99.8% limits) or a ranked mean-NQI list. Doctor names appear only beside note counts and intervals. Read-only."""
    run = Run("cdmss_v3_doctor_variation", _args(window_days=window_days, metric=metric, site=site, specialty=specialty), config)
    return await cached(run, lambda: build_v3(run, window_days, metric, site, specialty))


@tool(args_schema=V4Args)
async def cdmss_v4_contributors(site: str, window_days: int = 28, metric: str = "lv_rate", config: RunnableConfig = None) -> str:
    """CDMSS contributors: each doctor's share of a site's gap on low-value findings, and the site rate without them. Read-only."""
    run = Run("cdmss_v4_contributors", _args(window_days=window_days, site=site, metric=metric), config)
    return await cached(run, lambda: build_v4(run, window_days, site))


@tool(args_schema=V5Args)
async def cdmss_v5_redflags(window_days: int = 28, site: Optional[str] = None, doctor_uid: Optional[str] = None, limit: int = 50, config: RunnableConfig = None) -> str:
    """CDMSS red-flag dossiers: doctors with open governance signals, the signals and their recent evidence findings with note quotes and case links. Read-only."""
    run = Run("cdmss_v5_redflags", _args(window_days=window_days, site=site, doctor_uid=doctor_uid, limit=limit), config)
    return await cached(run, lambda: build_v5(run, window_days, site, doctor_uid, limit))


@tool(args_schema=V8Args)
async def cdmss_v8_worklists(list: str = "signals_open", window_days: int = 28, site: Optional[str] = None, doctor_uid: Optional[str] = None, limit: int = LIST_CAP, offset: int = 0, config: RunnableConfig = None) -> str:  # noqa: A002
    """CDMSS named worklists: open or overdue governance signals, low-value findings, or notes without a PDQI-9 assessment, with doctor, site, quote and case link. Up to 500 rows per page. Read-only."""
    run = Run("cdmss_v8_worklists", _args(list=list, window_days=window_days, site=site, doctor_uid=doctor_uid, limit=limit, offset=offset), config)
    return await cached(run, lambda: build_v8(run, window_days, list, site, doctor_uid, limit, offset))


@tool(args_schema=NoArgs)
async def cdmss_metric_catalogue(config: RunnableConfig = None) -> str:
    """The CDMSS Phase 1 metric catalogue: ids, labels, definitions, and which metrics cannot be reported yet and why. Read-only."""
    return await build_catalogue(Run("cdmss_metric_catalogue", {}, config))


@tool(args_schema=MetricArgs)
async def cdmss_metric(metric_id: str, window_days: int = 28, group_by: str = "none", site: Optional[str] = None, doctor_uid: Optional[str] = None, limit: int = 50, config: RunnableConfig = None) -> str:
    """One CDMSS catalogue metric (e.g. M-OPD-01 mean NQI, M-OPD-03 Clinical NQI, M-OPD-05 low-value per 100 notes), overall or by site or doctor, with numerator, denominator, n, window, interval, coverage and change. Always present the headline, window and caveats. Read-only."""
    run = Run("cdmss_metric", _args(metric_id=metric_id, window_days=window_days, group_by=group_by, site=site, doctor_uid=doctor_uid, limit=limit), config)
    return await cached(run, lambda: build_metric(run, metric_id, window_days, group_by, site, doctor_uid, limit))


@tool(args_schema=DrillArgs)
async def cdmss_drilldown(metric_id: str, window_days: int = 28, site: Optional[str] = None, doctor_uid: Optional[str] = None, limit: int = 100, offset: int = 0, config: RunnableConfig = None) -> str:
    """The notes or findings behind a CDMSS metric (worklist rows with doctor, site, quote and CDMSS case link), filtered by site or doctor. Read-only."""
    run = Run("cdmss_drilldown", _args(metric_id=metric_id, window_days=window_days, site=site, doctor_uid=doctor_uid, limit=limit, offset=offset), config)
    return await cached(run, lambda: build_drilldown(run, metric_id, window_days, site, doctor_uid, limit, offset))


@tool(args_schema=FindingArgs)
async def cdmss_finding_detail(uid: str, finding_no: Optional[int] = None, config: RunnableConfig = None) -> str:
    """One audited OPD note's findings in full: subject, verdict, rule, the note quote, rationale and the CDMSS case link. Read-only."""
    run = Run("cdmss_finding_detail", _args(uid=uid, finding_no=finding_no), config)
    return await cached(run, lambda: build_finding_detail(run, uid, finding_no))


CDMSS_TOOLS = [
    cdmss_v1_this_week, cdmss_v2_scorecard, cdmss_v3_doctor_variation, cdmss_v4_contributors, cdmss_v5_redflags, cdmss_v8_worklists,
    cdmss_metric_catalogue, cdmss_metric, cdmss_drilldown, cdmss_finding_detail,
]
CDMSS_TOOL_NAMES = [t.name for t in CDMSS_TOOLS]
