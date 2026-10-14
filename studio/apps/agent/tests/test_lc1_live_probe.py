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

import pytest

psycopg = pytest.importorskip("psycopg")
DSN = os.environ.get("GOV_RO_DATABASE_URL", "")
pytestmark = pytest.mark.skipif(not DSN, reason="GOV_RO_DATABASE_URL not set (live L-C1 probe)")

GOV_TABLES = ("physicians", "physician_engagements", "hospitals", "gov_signal_snapshots", "gov_interventions", "incidents")
COLUMN_GRANT_ONLY = ("profiles", "profiles_with_roles")  # id/status/is_super_admin and id/must_change_pin only
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


def test_no_write_privilege_on_any_table_or_sequence():
    writable = scalar(
        """SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%%'
             AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
             AND (has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE')
                  OR has_table_privilege(c.oid, 'DELETE') OR has_table_privilege(c.oid, 'TRUNCATE'))"""
    )
    assert writable == 0
    seq = scalar(
        """SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind = 'S' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
             AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(c.oid, 'UPDATE') ELSE false END"""
    )
    assert seq == 0


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


def _public_tables():
    with psycopg.connect(DSN, autocommit=False, prepare_threshold=None) as conn:
        try:
            return [
                r[0]
                for r in conn.execute(
                    """SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f') ORDER BY 1"""
                ).fetchall()
            ]
        finally:
            conn.rollback()


def test_the_catalogue_is_enumerated_and_the_named_examples_exist():
    tables = _public_tables()
    for named in ("profile_hospital_roles", "gov_capture_gaps", "incident_replies"):
        assert named in tables, named


def test_every_public_relation_outside_the_grant_list_is_denied():
    granted = set(GOV_TABLES)
    checked = 0
    for rel in _public_tables():
        if rel in granted:
            continue
        # profiles / profiles_with_roles have column grants only, so a whole-row read is denied too.
        assert attempt(f'SELECT * FROM "{rel}" WHERE false') == "denied", rel
        checked += 1
    assert checked >= 3


def test_connection_limit_and_timeouts_are_set():
    assert scalar("SELECT rolconnlimit FROM pg_roles WHERE rolname = current_user") == 5
    assert scalar("SELECT current_setting('statement_timeout')") == "15s"
    assert scalar("SELECT current_setting('idle_in_transaction_session_timeout')") == "30s"
    assert scalar("SELECT current_setting('default_transaction_read_only')") == "on"
