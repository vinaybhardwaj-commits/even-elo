"""L-C1 live probe: GOV_RO_DATABASE_URL must be a SELECT-only role.

Proposed by the M0-S2 refuter for studio/apps/agent/tests/. Skips unless GOV_RO_DATABASE_URL is
set. Run at the ops step, once, against the real read-only role:

    GOV_RO_DATABASE_URL=... uv run pytest tests/test_lc1_live_probe.py -q

SAFE against production: every write attempt is a no-op (WHERE false / zero rows) inside a
transaction that is always rolled back; TRUNCATE is checked via the catalogue, never executed.
Postgres checks privileges at plan time, so a no-op statement still raises permission denied.
The DSN is captured at import (conftest.py deletes the variable for each test) and never printed.
"""

import os
import sys
from pathlib import Path

import pytest

psycopg = pytest.importorskip("psycopg")
DSN = os.environ.get("GOV_RO_DATABASE_URL", "")
pytestmark = pytest.mark.skipif(not DSN, reason="GOV_RO_DATABASE_URL not set (live L-C1 probe)")

GOV_TABLES = ("physicians", "physician_engagements", "hospitals", "gov_signal_snapshots", "gov_interventions")
# Column-scoped views (ops/neon/0003_studio_views.sql). EXACT column lists: a new column is a test failure until reviewed.
BASE_VIEW_COLUMNS = {
    "physician_privileges": ("privilege_id", "physician_id", "hospital_code", "procedure_or_specialty", "is_core", "basis", "granted_date", "expires_at", "withdrawn_date", "created_at"),
    "physician_oppe": ("review_id", "physician_id", "hospital_code", "period_start", "period_end", "due_at", "status", "completed_at", "created_at"),
    "physician_metrics": ("metric_id", "physician_id", "hospital_code", "year", "month", "opd_count", "ipd_admissions", "ot_cases", "revenue_inr", "uploaded_at"),
    "physician_qualifications": ("qualification_id", "physician_id", "degree", "institution_tier", "year_completed", "country", "verified", "verified_at", "created_at"),
    "capture_gaps": ("gap_id", "title", "attr", "status", "baseline_mean", "shipped_at", "created_at"),
    "incident_reply_status": ("reply_id", "incident_id", "physician_id", "incident_status", "replied_by_physician", "replied_at"),
    "physician_feedback": ("physician_id", "source", "polarity", "severity", "status", "month", "incidents"),
}
# Columns ops/neon/0008_ungate_views.sql appends at the END of five of those views (V, 21 Oct: no doctor or PHI gating).
UNGATE_APPENDED = {
    "physician_privileges": ("withdrawn_reason",),
    "physician_oppe": ("decision_notes",),
    "physician_qualifications": ("institution",),
    "capture_gaps": ("note", "source_doc"),
    "incident_reply_status": ("reply_text",),
}
VIEW_COLUMNS = {v: cols + UNGATE_APPENDED.get(v, ()) for v, cols in BASE_VIEW_COLUMNS.items()}
# Document-audit views (ops/neon/0007_docaudits_views.sql), EXACT columns; installed by a second owner step.
DOCAUDIT_VIEW_COLUMNS = {
    "document_audit_list": ("audit_id", "external_ref", "hospital_code", "physician_id", "doc_type", "doc_day", "ingested_at", "last_synced_at", "triage_routed_at", "doc_class", "has_pdf", "pdf_url", "source", "created_at"),
    "document_audit_finding_list": ("finding_id", "audit_id", "physician_id", "finding_label", "finding_body", "evidence_excerpt", "severity", "status", "authored_by_name", "author_confirmed", "authored_at", "recurrence_count", "portal_visible", "response_owner", "signal_reference", "signal_type", "doc_class", "cdmss_routed", "response_verb", "response_comment", "responded_at", "sync_state", "sync_attempts", "sync_permanent", "created_at"),
}
# Incident view (ops/neon/0009_incidents_view.sql), EXACT columns; installed by a third owner step. public.incidents itself is denied.
INCIDENT_VIEW_COLUMNS = {"incident_register": ("status", "polarity", "severity", "submitted_at")}
INCIDENT_BASE_TABLES = ("incidents",)
DOCAUDIT_BASE_TABLES = ("document_audits", "document_audit_findings")
ALL_VIEW_COLUMNS = {**VIEW_COLUMNS, **DOCAUDIT_VIEW_COLUMNS, **INCIDENT_VIEW_COLUMNS}
VIEW_BASE_TABLES = ("privileges", "oppe_reviews", "clinical_metrics_monthly", "qualifications", "gov_capture_gaps", "incident_replies") + DOCAUDIT_BASE_TABLES + INCIDENT_BASE_TABLES
# studio_dw read views (ops/neon/0012_studio_dw.sql). The 8 data views are GENERATED from the extract spec (ops/db13/extract/spec.py),
# the same source 0012's DDL is generated from, so the two cannot drift; the two status views are fixed text in 0012.
# Expected whenever the studio_dw schema exists, and ALWAYS with STUDIO_EXPECT_DW=1 (a missing schema is then a failure).
sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "ops" / "db13"))
from extract.spec import TABLES as _DW_TABLES  # noqa: E402

DW_STATUS_COLUMNS = {
    "dw_extract_status": ("run_id", "mode", "status", "started_at", "ended_at", "db13_snapshot_now", "rows"),
    "dw_extract_tables": ("run_id", "table_name", "status", "started_at", "ended_at", "db13_snapshot_now", "rows_read", "fetches", "fetch_seconds", "load_seconds"),
}
DW_VIEW_COLUMNS = {**{f"dw_{t.name}": tuple(c.name for c in t.cols) for t in _DW_TABLES}, **DW_STATUS_COLUMNS}
DW_BASE_TABLES = tuple(t.name for t in _DW_TABLES) + ("extract_runs", "extract_run_tables")  # in schema studio_dw: all denied
# Never in any dw view: the provenance stamp and the patient/doctor contact fields the extract must not carry (G-D4).
DW_FORBIDDEN_COLUMNS = ("_run_id", "email", "name_with_prefix", "mobile", "name", "patient_name", "patient_address", "free_text",
                        "bank_account__number", "tariffs", "amount", "net_amt")
FREE_TEXT_COLUMNS = (
    "packet_jsonb", "granted_by", "reviewer_id", "source_file", "uploaded_by",
    "file_data", "verified_by", "replied_by_profile_id", "replied_by_physician_id",
    "narrative", "evidence_urls", "reporter_name", "reporter_email", "patient_ref", "patient_rating", "submitter_user_id",
    "retraction_reason", "category", "target_physician_id",
    "citations_json", "patient_json", "cdmss_sync_error",
    "authored_by_profile_id", "doctor_uid", "content_hash", "queue_item_ref", "source_audit_id",
)
COLUMN_GRANT_ONLY = ("profiles", "profiles_with_roles")  # view: id, status, is_super_admin + the 0011 flags (is_sgc_member, is_site_medical_head, is_hr); profiles: id, must_change_pin
WRITES = {
    "insert": "INSERT INTO {t} SELECT * FROM {t} WHERE false",
    "update": "UPDATE {t} SET id = id WHERE false",
    "delete": "DELETE FROM {t} WHERE false",
}
DDL = (
    "CREATE TABLE lc1_probe_tbl (x int)",
    "CREATE SCHEMA lc1_probe_schema",
    "CREATE FUNCTION lc1_probe_fn() RETURNS int LANGUAGE sql AS 'SELECT 1'",
)


def attempt(sql: str) -> str:
    """'denied' only when Postgres refuses on PRIVILEGE; 'ALLOWED' otherwise. Always rolls back.

    The read-only flags are switched off first, so a ReadOnlySqlTransaction can never mask a missing
    privilege: only InsufficientPrivilege counts as denied (a ReadOnlySqlTransaction is a test failure).
    """
    with psycopg.connect(DSN, autocommit=False, prepare_threshold=None) as conn:
        try:
            conn.execute("SET transaction_read_only = off")
            conn.execute("SET default_transaction_read_only = off")
            conn.execute(sql)
            return "ALLOWED"
        except psycopg.errors.InsufficientPrivilege:
            return "denied"
        except psycopg.errors.ReadOnlySqlTransaction:
            return "READ-ONLY-FLAG-ONLY (privilege missing)"
        finally:
            conn.rollback()


def scalar(sql: str, params=()):
    with psycopg.connect(DSN, autocommit=False, prepare_threshold=None) as conn:
        try:
            return conn.execute(sql, params).fetchone()[0]
        finally:
            conn.rollback()


def test_role_attributes_grant_nothing_beyond_login():
    row = scalar(
        "SELECT row(rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication)::text FROM pg_roles WHERE rolname = current_user"
    )
    assert row == "(f,f,f,f,f)", row


def live_staff_sql():
    import re
    from pathlib import Path

    ts = Path(__file__).resolve().parents[2] / "app" / "src" / "lib" / "zone" / "live-staff.ts"
    m = re.search(r"export const LIVE_STAFF_SQL = `(.*?)`;", ts.read_text(), re.S)
    assert m, "LIVE_STAFF_SQL not found"
    return re.sub(r"\$1\b", "%s", m.group(1))


def test_live_staff_statement_runs_with_the_documented_column_grants():
    """The exact statement the studio app runs per request (zero rows for a random uuid is fine)."""
    import uuid

    with psycopg.connect(DSN, autocommit=False, prepare_threshold=None) as conn:
        try:
            assert conn.execute(live_staff_sql(), (str(uuid.uuid4()),)).fetchall() == []
        finally:
            conn.rollback()


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT password_hash FROM profiles WHERE false",
        "SELECT email FROM profiles WHERE false",
        "SELECT * FROM profiles WHERE false",
        "SELECT password_hash FROM profiles_with_roles WHERE false",
        "SELECT email FROM profiles_with_roles WHERE false",
        "SELECT * FROM profiles_with_roles WHERE false",
    ],
)
def test_credential_columns_are_denied_on_profiles_and_its_view(sql):
    """Column grants only: password_hash and email must stay unreadable (the view is SELECT p.*)."""
    assert attempt(sql) == "denied"


def test_no_table_wide_select_on_profiles_or_its_view():
    for rel in ("profiles", "profiles_with_roles"):
        assert scalar("SELECT has_table_privilege(current_user, %s, 'SELECT')", (rel,)) is False, rel
        assert scalar("SELECT has_column_privilege(current_user, %s, 'password_hash', 'SELECT')", (rel,)) is False, rel


def test_zone_role_view_is_readable():
    """The Studio middleware re-reads roles from profiles_with_roles on the same RO connection."""
    assert scalar("SELECT count(id) >= 0 FROM profiles_with_roles") is True  # column grant: never count(*)/p.*
    # 0011 (role flags for the per-screen access): required with STUDIO_EXPECT_VIEWS=1 (all files applied); the credential columns above stay denied
    granted = scalar("SELECT has_column_privilege(current_user, 'profiles_with_roles', 'is_hr', 'SELECT')")
    if os.environ.get("STUDIO_EXPECT_VIEWS") == "1":
        assert granted is True, "0011_profiles_role_flags.sql is not applied"
    if granted:
        assert scalar("SELECT count(is_sgc_member) + count(is_site_medical_head) + count(is_hr) >= 0 FROM profiles_with_roles") is True


@pytest.mark.parametrize("table", GOV_TABLES)
def test_select_works(table):
    assert scalar(f"SELECT count(*) >= 0 FROM {table}") is True


@pytest.mark.parametrize("table", GOV_TABLES)
@pytest.mark.parametrize("kind", sorted(WRITES))
def test_writes_on_governance_tables_are_denied(table, kind):
    assert attempt(WRITES[kind].format(t=table)) == "denied"


@pytest.mark.parametrize("sql", DDL)
def test_ddl_is_denied(sql):
    assert attempt(sql) == "denied"


NON_SYSTEM = "n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%%' AND n.nspname NOT LIKE 'pg_temp%%'"


def test_no_write_privilege_on_any_table_in_any_schema():
    """INSERT/UPDATE use has_any_column_privilege: has_table_privilege ignores column-level grants
    (GRANT UPDATE (status) ON incidents would slip through it)."""
    writable = scalar(
        f"""SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE {NON_SYSTEM} AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
             AND (has_any_column_privilege(c.oid, 'INSERT') OR has_any_column_privilege(c.oid, 'UPDATE')
                  OR has_table_privilege(c.oid, 'DELETE') OR has_table_privilege(c.oid, 'TRUNCATE'))"""
    )
    assert writable == 0


def test_no_usage_or_update_on_any_sequence_in_any_schema():
    """USAGE allows nextval(), which is a write; check both USAGE and UPDATE."""
    for priv in ("USAGE", "UPDATE"):
        n = scalar(
            f"""SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE c.relkind = 'S' AND {NON_SYSTEM}
                 AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(c.oid, '{priv}') ELSE false END"""
        )
        assert n == 0, priv


def test_no_executable_security_definer_function_outside_system_schemas():
    """A SECURITY DEFINER function runs with its owner's rights: if the role may EXECUTE one, it can
    write however read-only its own grants are (PUBLIC gets EXECUTE on new functions by default)."""
    n = scalar(
        f"""SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE p.prosecdef AND {NON_SYSTEM} AND has_function_privilege(p.oid, 'EXECUTE')"""
    )
    assert n == 0


def test_no_create_on_database_or_any_schema():
    assert scalar("SELECT has_database_privilege(current_database(), 'CREATE')") is False
    assert (
        scalar(
            """SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('pg_catalog', 'information_schema')
               AND nspname NOT LIKE 'pg_%%' AND has_schema_privilege(oid, 'CREATE')"""
        )
        == 0
    )


def test_session_read_only_is_on_when_the_studio_connects():
    """Exercises the agent's own connect_read_only(): the session must report read-only."""
    import asyncio

    os.environ["GOV_RO_DATABASE_URL"] = DSN
    try:
        from src.studio_db import connect_read_only

        async def check():
            conn = await connect_read_only()
            try:
                cur = await conn.execute("SHOW transaction_read_only")
                return (await cur.fetchone())["transaction_read_only"]
            finally:
                await conn.close()

        assert asyncio.run(check()) == "on"
    finally:
        os.environ.pop("GOV_RO_DATABASE_URL", None)


def test_temp_privilege_is_not_granted_to_the_role_itself():
    """CREATE TEMP TABLE only works through PUBLIC's default TEMPORARY on the database (session-local,
    nothing shared); the role must hold no direct grant of it, and CREATE on the database is false."""
    direct = scalar(
        """SELECT count(*) FROM aclexplode((SELECT datacl FROM pg_database WHERE datname = current_database())) a
           WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)"""
    )
    assert direct == 0


def test_role_has_no_memberships():
    assert scalar("SELECT count(*) FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = current_user)") == 0


def _relations():
    """(schema, relation) for every table/view/matview/foreign table in every non-system schema."""
    with psycopg.connect(DSN, autocommit=False, prepare_threshold=None) as conn:
        try:
            return [
                (r[0], r[1])
                for r in conn.execute(
                    f"""SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE {NON_SYSTEM} AND c.relkind IN ('r', 'p', 'v', 'm', 'f') ORDER BY 1, 2"""
                ).fetchall()
            ]
        finally:
            conn.rollback()


def test_the_catalogue_is_enumerated_and_the_named_examples_exist():
    public = {r for s_, r in _relations() if s_ == "public"}
    for named in ("profile_hospital_roles", "gov_capture_gaps", "incident_replies"):
        assert named in public, named


def test_every_relation_in_every_schema_outside_the_grant_list_is_denied():
    granted = {("public", t) for t in GOV_TABLES} | {("studio_ro", v) for v in expected_views() if views_installed()}
    checked = 0
    for schema, rel in _relations():
        if (schema, rel) in granted:
            continue
        # profiles / profiles_with_roles have column grants only, so a whole-row read is denied too.
        assert attempt(f'SELECT * FROM "{schema}"."{rel}" WHERE false') == "denied", f"{schema}.{rel}"
        checked += 1
    assert checked >= 3


def dw_installed() -> bool:
    return bool(scalar("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'studio_dw')"))


def expected_views() -> dict:
    """Every studio_ro view that must exist: the original ones, plus the studio_dw ones once 0012 is applied (or always with STUDIO_EXPECT_DW=1)."""
    if dw_installed() or os.environ.get("STUDIO_EXPECT_DW") == "1":
        return {**ALL_VIEW_COLUMNS, **DW_VIEW_COLUMNS}
    return dict(ALL_VIEW_COLUMNS)


def views_installed() -> bool:
    return bool(scalar("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'studio_ro')"))


# The views are installed by separate owner steps (0003_studio_views.sql, 0007_docaudits_views.sql). Without STUDIO_EXPECT_VIEWS=1 a
# database that has not had it yet skips these; with it, a missing schema is a FAILURE.
def _need_views():
    if views_installed():
        return
    if os.environ.get("STUDIO_EXPECT_VIEWS") == "1":
        pytest.fail("studio_ro views are not installed (0003_studio_views.sql / 0007_docaudits_views.sql was not run)")
    pytest.skip("studio_ro views not installed in this database")


@pytest.mark.parametrize("view", sorted(ALL_VIEW_COLUMNS))
def test_view_select_works(view):
    _need_views()
    assert scalar(f"SELECT count(*) >= 0 FROM studio_ro.{view}") is True


@pytest.mark.parametrize("view", sorted(ALL_VIEW_COLUMNS))
def test_view_exposes_exactly_the_reviewed_columns_and_no_free_text(view):
    _need_views()
    with psycopg.connect(DSN, autocommit=False, prepare_threshold=None) as conn:
        try:
            cols = tuple(d.name for d in conn.execute(f"SELECT * FROM studio_ro.{view} WHERE false").description)
        finally:
            conn.rollback()
    assert cols == ALL_VIEW_COLUMNS[view]
    assert not set(cols) & set(FREE_TEXT_COLUMNS)


def _need_dw():
    """True when the dw expectations apply. A database without 0012 and without STUDIO_EXPECT_DW=1 passes these vacuously (no
    skip: other harnesses require a skip-free probe run); with STUDIO_EXPECT_DW=1 a missing schema is a failure."""
    _need_views()
    if dw_installed():
        return True
    if os.environ.get("STUDIO_EXPECT_DW") == "1":
        pytest.fail("studio_dw / studio_ro.dw_* views are not installed (0012_studio_dw.sql was not run)")
    return False


@pytest.mark.parametrize("view", sorted(DW_VIEW_COLUMNS))
def test_dw_view_select_works_and_exposes_exactly_the_generated_columns(view):
    if not _need_dw():
        return
    assert scalar(f"SELECT count(*) >= 0 FROM studio_ro.{view}") is True
    with psycopg.connect(DSN, autocommit=False, prepare_threshold=None) as conn:
        try:
            cols = tuple(d.name for d in conn.execute(f"SELECT * FROM studio_ro.{view} WHERE false").description)
        finally:
            conn.rollback()
    assert cols == DW_VIEW_COLUMNS[view]
    assert not set(cols) & set(DW_FORBIDDEN_COLUMNS)


@pytest.mark.parametrize("table", DW_BASE_TABLES)
def test_studio_dw_tables_stay_denied_and_the_schema_is_unreachable(table):
    if not _need_dw():
        return
    assert attempt(f"SELECT * FROM studio_dw.{table} WHERE false") == "denied"
    # by oid: a text 'studio_dw.x' cast to regclass would itself need USAGE on the schema
    assert scalar("""SELECT has_any_column_privilege(c.oid, 'SELECT') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = 'studio_dw' AND c.relname = %s""", (table,)) is False
    assert scalar("SELECT has_schema_privilege(current_user, 'studio_dw', 'USAGE')") is False


@pytest.mark.parametrize("table", VIEW_BASE_TABLES)
def test_base_tables_behind_the_views_stay_denied(table):
    _need_views()
    assert attempt(f"SELECT * FROM public.{table} WHERE false") == "denied"
    assert scalar("SELECT has_any_column_privilege(current_user, %s, 'SELECT')", (f"public.{table}",)) is False


def test_views_are_security_barrier_owner_run_and_not_owned_by_the_role():
    _need_views()
    n = scalar(
        """SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'studio_ro' AND c.relkind = 'v'
             AND COALESCE(c.reloptions, '{}') @> ARRAY['security_barrier=true']
             AND NOT COALESCE(c.reloptions, '{}') @> ARRAY['security_invoker=true']
             AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)"""
    )
    assert n == len(expected_views())
    assert scalar("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'studio_ro'") == len(expected_views())


def test_views_are_read_only_for_the_role_and_the_schema_has_no_create():
    _need_views()
    # Catalogue, not an attempted write: a view over a join is "not updatable" before Postgres checks privileges.
    for view in expected_views():
        rel = f"studio_ro.{view}"
        assert scalar("SELECT has_any_column_privilege(current_user, %s, 'INSERT') OR has_any_column_privilege(current_user, %s, 'UPDATE')", (rel, rel)) is False, view
        assert scalar("SELECT has_table_privilege(current_user, %s, 'DELETE') OR has_table_privilege(current_user, %s, 'TRUNCATE')", (rel, rel)) is False, view
        assert scalar("SELECT has_table_privilege(current_user, %s, 'SELECT')", (rel,)) is True, view
    assert scalar("SELECT has_schema_privilege(current_user, 'studio_ro', 'CREATE')") is False
    assert scalar("SELECT has_schema_privilege(current_user, 'studio_ro', 'USAGE')") is True


def test_connection_limit_and_timeouts_are_set():
    assert scalar("SELECT rolconnlimit FROM pg_roles WHERE rolname = current_user") == 20
    assert scalar("SELECT current_setting('statement_timeout')") == "15s"
    assert scalar("SELECT current_setting('idle_in_transaction_session_timeout')") == "30s"
    assert scalar("SELECT current_setting('default_transaction_read_only')") == "on"


def test_no_server_side_egress_primitives_dblink_postgres_fdw():
    """CREATE EXTENSION dblink / postgres_fdw must fail with InsufficientPrivilege; neither installed or
    callable; no CREATE on the database or any schema; no foreign servers or FDW usage."""
    from tests.egress import assert_no_egress

    with psycopg.connect(DSN, autocommit=False, prepare_threshold=None) as conn:
        assert_no_egress(conn, "studio_gov_ro")
