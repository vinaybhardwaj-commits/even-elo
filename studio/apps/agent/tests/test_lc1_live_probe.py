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
WRITES = {
    "insert": "INSERT INTO {t} SELECT * FROM {t} WHERE false",
    "update": "UPDATE {t} SET id = id WHERE false",
    "delete": "DELETE FROM {t} WHERE false",
}
DDL = (
    "CREATE TABLE lc1_probe_tbl (x int)",
    "CREATE TEMP TABLE lc1_probe_tmp (x int)",
    "CREATE SCHEMA lc1_probe_schema",
    "CREATE FUNCTION lc1_probe_fn() RETURNS int LANGUAGE sql AS 'SELECT 1'",
)


def attempt(sql: str) -> str:
    """'denied' when Postgres refuses on privilege; 'ALLOWED' otherwise. Always rolls back."""
    with psycopg.connect(DSN, autocommit=False, prepare_threshold=None) as conn:
        try:
            conn.execute(sql)
            return "ALLOWED"
        except (psycopg.errors.InsufficientPrivilege, psycopg.errors.ReadOnlySqlTransaction):
            return "denied"
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


def test_zone_role_view_is_readable():
    """The Studio middleware re-reads roles from profiles_with_roles on the same RO connection."""
    assert scalar("SELECT count(*) >= 0 FROM profiles_with_roles") is True


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
    assert scalar("SELECT has_database_privilege(current_database(), 'TEMPORARY')") is False
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
