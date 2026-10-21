"""Migration tests.

Static checks always run. The Postgres checks run against a throw-away local server: set
STUDIO_TEST_PG_URI to a SUPERUSER uri of a scratch database, or have `pgserver` importable
(`uv run --python 3.12 --with pgserver python -m pytest tests/test_studio_migration.py`). Otherwise they skip.
Nothing here ever touches a real database.
"""

import asyncio
import importlib.util
import os
import re
import tempfile
import uuid
from pathlib import Path

import psycopg
import pytest

import apply_migration
from src import studio_tools
from src.studio_auth import PostgresNonceStore

SQL_FILE = Path(apply_migration.MIGRATIONS) / "0001_studio.sql"
SQL = SQL_FILE.read_text()


def test_migration_defines_the_studio_tables_and_append_only_audit():
    for table in ("studio_audit", "studio_nonce", "studio_threads"):
        assert f"CREATE TABLE IF NOT EXISTS {table}" in SQL
    assert re.search(r"jti\s+text PRIMARY KEY", SQL)
    assert "archived" in SQL
    assert "REVOKE ALL ON studio_audit FROM {{app_role}}" in SQL
    assert "GRANT SELECT, INSERT ON studio_audit TO {{app_role}}" in SQL
    assert re.search(r"BEFORE UPDATE OR DELETE ON studio_audit", SQL)
    assert re.search(r"BEFORE TRUNCATE ON studio_audit", SQL)
    assert not re.search(r"GRANT[^;]*\b(UPDATE|DELETE)\b[^;]*studio_audit", SQL)


def test_migration_has_no_secrets_or_role_creation():
    assert not re.search(r"CREATE\s+(ROLE|USER)|PASSWORD|postgres(ql)?://", SQL, re.IGNORECASE)


def test_render_validates_the_role_identifier():
    assert '"studio_app"' in apply_migration.render(SQL, "studio_app")
    assert "{{" not in apply_migration.render(SQL, "studio_app")
    for bad in ('x"; DROP TABLE y; --', "Studio", "a b", "", "1abc"):
        with pytest.raises(ValueError):
            apply_migration.render(SQL, bad)


def test_runner_needs_a_dsn_env_name_and_never_prints_the_value(monkeypatch, capsys):
    monkeypatch.delenv("SOME_DSN", raising=False)
    assert apply_migration.main(["--dsn-env", "SOME_DSN"]) == 2
    monkeypatch.setenv("SOME_DSN", "postgresql://user:hunter2@host/db")
    monkeypatch.setattr(apply_migration, "apply", lambda dsn, role: ["0001_studio"])
    assert apply_migration.main(["--dsn-env", "SOME_DSN"]) == 0
    out = capsys.readouterr()
    assert "hunter2" not in out.out + out.err


# ----------------------------------------------------------------------------------------------
# Real Postgres (local, scratch)
# ----------------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def pg_uri():
    uri = os.environ.get("STUDIO_TEST_PG_URI")
    server = None
    if not uri:
        if importlib.util.find_spec("pgserver") is None:
            pytest.skip("no local Postgres (set STUDIO_TEST_PG_URI or install pgserver)")
        import pgserver

        server = pgserver.get_server(tempfile.mkdtemp(prefix="studio-pg-"))
        uri = server.get_uri()
    try:
        yield uri
    finally:
        if server:
            server.cleanup()


@pytest.fixture(scope="module")
def migrated(pg_uri):
    with psycopg.connect(pg_uri, autocommit=True) as c:
        c.execute("DROP ROLE IF EXISTS studio_app")
        c.execute("CREATE ROLE studio_app NOLOGIN")
    apply_migration.apply(pg_uri, "studio_app")
    return pg_uri


def as_app(uri):
    c = psycopg.connect(uri, autocommit=True)
    c.execute("SET ROLE studio_app")
    return c


def test_apply_is_idempotent_and_requires_the_role(migrated, pg_uri):
    again = apply_migration.apply(pg_uri, "studio_app")
    assert again == ["0001_studio"]
    with pytest.raises(SystemExit, match="does not exist"):
        apply_migration.apply(pg_uri, "no_such_role")
    with psycopg.connect(pg_uri) as c:
        names = {r[0] for r in c.execute("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")}
        assert {"studio_audit", "studio_nonce", "studio_threads", "checkpoints", "checkpoint_blobs", "checkpoint_writes", "checkpoint_migrations"} <= names
        assert c.execute("SELECT count(*) FROM studio_migrations WHERE id = '0001_studio'").fetchone()[0] == 1


def test_app_role_can_append_and_read_audit_but_never_change_or_remove(migrated):
    with as_app(migrated) as c:
        c.execute("INSERT INTO studio_audit (staff_id, tool, params_hash, row_count, duration_ms, mode) VALUES ('s','t','h',1,2,'live')")
        assert c.execute("SELECT count(*) FROM studio_audit").fetchone()[0] >= 1
        for stmt in ("UPDATE studio_audit SET tool = 'x'", "DELETE FROM studio_audit", "TRUNCATE studio_audit"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                c.execute(stmt)
        with pytest.raises(psycopg.errors.CheckViolation):
            c.execute("INSERT INTO studio_audit (staff_id, tool, params_hash, row_count, duration_ms, mode) VALUES ('s','t','h',1,2,'other')")


def test_trigger_blocks_even_the_table_owner(migrated):
    with psycopg.connect(migrated, autocommit=True) as c:
        c.execute("INSERT INTO studio_audit (staff_id, tool, params_hash, row_count, duration_ms, mode) VALUES ('o','t','h',0,0,'live')")
        for stmt in ("UPDATE studio_audit SET tool = 'x'", "DELETE FROM studio_audit", "TRUNCATE studio_audit"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege, match="append-only"):
                c.execute(stmt)


def test_nonce_insert_or_fail(migrated):
    async def go():
        async def connect():
            c = await psycopg.AsyncConnection.connect(migrated, autocommit=True)
            await c.execute("SET ROLE studio_app")
            return c

        store = PostgresNonceStore(connect)
        jti = uuid.uuid4().hex
        assert await store.claim(jti, 0) is True
        assert await store.claim(jti, 0) is False  # replay, even from "another instance"

    asyncio.run(go())


def test_checkpointer_works_for_the_app_role(migrated):
    from langgraph.checkpoint.postgres import PostgresSaver
    from langgraph.checkpoint.base import empty_checkpoint

    with as_app(migrated) as conn:
        saver = PostgresSaver(conn)
        cfg = {"configurable": {"thread_id": "staff:t", "checkpoint_ns": ""}}
        saver.put(cfg, empty_checkpoint(), {"source": "input", "step": 0, "parents": {}}, {})
        assert saver.get_tuple(cfg) is not None


def test_runner_refuses_when_the_migrating_role_is_the_app_role(migrated, pg_uri):
    with psycopg.connect(pg_uri, autocommit=True) as c:
        me = c.execute("SELECT current_user").fetchone()[0]
    with pytest.raises(SystemExit, match="same"):
        apply_migration.apply(pg_uri, me)


def test_runner_refuses_a_member_of_the_migrating_role_and_privileged_app_roles(migrated, pg_uri):
    with psycopg.connect(pg_uri, autocommit=True) as c:
        me = c.execute("SELECT current_user").fetchone()[0]
        for r in ("app_in_owner", "app_super", "app_rls"):
            c.execute(f"DROP ROLE IF EXISTS {r}")
        c.execute("CREATE ROLE app_in_owner NOLOGIN")
        c.execute(f'GRANT "{me}" TO app_in_owner')
        c.execute("CREATE ROLE app_super NOLOGIN SUPERUSER")
        c.execute("CREATE ROLE app_rls NOLOGIN BYPASSRLS")
    with pytest.raises(SystemExit, match="member of the migrating role"):
        apply_migration.apply(pg_uri, "app_in_owner")
    with pytest.raises(SystemExit, match="SUPERUSER or BYPASSRLS"):
        apply_migration.apply(pg_uri, "app_super")
    with pytest.raises(SystemExit, match="SUPERUSER or BYPASSRLS"):
        apply_migration.apply(pg_uri, "app_rls")
    # The plain, unprivileged app role still works.
    assert apply_migration.apply(pg_uri, "studio_app") == ["0001_studio"]


def test_audit_has_an_outcome_column_defaulting_to_ok(migrated):
    with as_app(migrated) as c:
        c.execute("INSERT INTO studio_audit (staff_id, tool, params_hash, row_count, duration_ms, mode, outcome) VALUES ('s','t','h',0,1,'live','error')")
        assert c.execute("SELECT outcome FROM studio_audit WHERE staff_id = 's' AND outcome = 'error' LIMIT 1").fetchone()[0] == "error"
        with pytest.raises(psycopg.errors.CheckViolation):
            c.execute("INSERT INTO studio_audit (staff_id, tool, params_hash, row_count, duration_ms, mode, outcome) VALUES ('s','t','h',0,1,'live','weird')")


def test_connect_read_only_is_really_read_only_even_for_a_write_capable_role(pg_uri, monkeypatch):
    """The superuser can write anywhere; through connect_read_only() it still must not."""
    from src import studio_db

    async def go():
        monkeypatch.setenv("GOV_RO_DATABASE_URL", pg_uri)
        conn = await studio_db.connect_read_only()
        try:
            cur = await conn.execute("SHOW transaction_read_only")
            assert (await cur.fetchone())["transaction_read_only"] == "on"
            for stmt in ("CREATE TABLE ro_probe (x int)", "CREATE TEMP TABLE ro_probe_t (x int)", "INSERT INTO studio_audit (staff_id, tool, params_hash, row_count, duration_ms, mode) VALUES ('x','x','x',0,0,'live')"):
                with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
                    await conn.execute(stmt)
                await conn.rollback()
            assert (await (await conn.execute("SELECT 1 AS one")).fetchone())["one"] == 1
        finally:
            await conn.close()

    asyncio.run(go())


def test_threads_archive_flag_defaults_false(migrated):
    with as_app(migrated) as c:
        c.execute("INSERT INTO studio_threads (thread_id, staff_id) VALUES (%s, 's')", (uuid.uuid4().hex,))
        assert c.execute("SELECT archived FROM studio_threads LIMIT 1").fetchone()[0] is False


# A minimal copy of the even-elo columns the read tools touch (src/lib/migrations.ts).
SCHEMA = """
CREATE TABLE hospitals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE, name text NOT NULL, is_active boolean NOT NULL DEFAULT true);
CREATE TABLE physicians (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), full_name text NOT NULL, preferred_name text, primary_specialty text,
  registration_council text, registration_expiry date, date_joined_network date, current_status text NOT NULL DEFAULT 'active', cdmss_doctor_uid text);
CREATE TABLE physician_engagements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), physician_id uuid NOT NULL REFERENCES physicians(id),
  hospital_id uuid NOT NULL REFERENCES hospitals(id), category text NOT NULL, status text NOT NULL DEFAULT 'active');
CREATE TABLE incidents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), submitted_at timestamptz NOT NULL DEFAULT now(), status text NOT NULL DEFAULT 'open',
  polarity text NOT NULL DEFAULT 'negative', severity text);
CREATE TABLE gov_signal_snapshots (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source text NOT NULL DEFAULT 'cdmss_opd', day date NOT NULL, period text NOT NULL DEFAULT 'day', payload jsonb NOT NULL);
CREATE TABLE gov_interventions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), signal_key text NOT NULL, signal_label text, kind text NOT NULL, physician_id uuid REFERENCES physicians(id),
  done_on date NOT NULL DEFAULT current_date, created_at timestamptz NOT NULL DEFAULT now(), action text, note text, cdmss_sync_state text);
"""


def test_read_tool_sql_runs_against_the_real_schema_shape(pg_uri):
    pid = str(uuid.uuid4())
    with psycopg.connect(pg_uri, autocommit=True) as c:
        c.execute("DROP SCHEMA IF EXISTS tools CASCADE")
        c.execute("CREATE SCHEMA tools")
        c.execute("SET search_path TO tools")
        c.execute(SCHEMA)
        h = c.execute("INSERT INTO hospitals (code, name) VALUES ('H1','Hosp') RETURNING id").fetchone()[0]
        c.execute("INSERT INTO physicians (id, full_name, primary_specialty, cdmss_doctor_uid) VALUES (%s, 'Dr 50%% Sample', 'Cardiology', 'uid-1')", (pid,))
        c.execute("INSERT INTO physician_engagements (physician_id, hospital_id, category) VALUES (%s, %s, 'active')", (pid, h))
        c.execute("INSERT INTO incidents (severity) VALUES ('low'), ('high')")
        c.execute(
            "INSERT INTO gov_signal_snapshots (day, payload) VALUES (current_date, %s::jsonb)",
            ['{"report":{"signals":[{"label":"S1","severity":"watch","trend":"flat","scope":"mixed","n":10,"affected":[{"uid":"uid-1","n":4,"mean":2.5}]},{"label":"S2","n":3}]}}'],
        )
        c.execute("INSERT INTO gov_interventions (signal_key, kind, physician_id) VALUES ('k','huddle_briefing', %s)", (pid,))
        like = studio_tools.like_pattern
        cases = {
            "list_physicians": (None, None, like("cardio"), like("cardio"), like("50%"), like("50%"), "H1", "H1", 10, 0),
            "physician_profile": (pid,),
            "signal_snapshots": (pid, 7, pid, 50),
            "interventions": (pid, pid, 50),
            "incident_summary": (30, 200),
            "overview_counts": (),
        }
        results = {}
        for name, params in cases.items():
            sql = studio_tools.ALL_SQL[name]
            studio_tools.assert_read_only(sql)
            results[name] = c.execute(sql, params).fetchall()
        assert len(results["list_physicians"]) == 1 and results["list_physicians"][0][5] == "H1"
        assert len(results["physician_profile"]) == 1
        rows = results["signal_snapshots"]
        assert len(rows) == 1 and rows[0][2] == "S1" and rows[0][3] == "watch"  # only the signal naming this physician
        assert sum(r[3] for r in results["incident_summary"]) == 2
        assert dict(results["overview_counts"])["physicians_total"] == 1
        # Without a physician filter both signals come back.
        assert len(c.execute(studio_tools.ALL_SQL["signal_snapshots"], (None, 7, None, 50)).fetchall()) == 2
        # A read-only session cannot write even through the real driver.
        c.execute("SET default_transaction_read_only = on")
        with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
            c.execute("INSERT INTO hospitals (code, name) VALUES ('H2','x')")
        c.execute("SET default_transaction_read_only = off")
        c.execute("DROP SCHEMA tools CASCADE")


def test_studio_app_role_has_no_create_and_no_server_side_egress_after_migration(migrated, pg_uri):
    """Simulate PG14-style defaults (CREATE on public for PUBLIC, CREATE on the database for the role),
    re-run the idempotent migration, then run the egress checks as studio_app."""
    from tests.egress import assert_no_egress

    with psycopg.connect(pg_uri, autocommit=True) as c:
        c.execute("GRANT CREATE ON SCHEMA public TO PUBLIC")
        c.execute("SELECT 1")
        db = c.execute("SELECT current_database()").fetchone()[0]
        c.execute(f'GRANT CREATE ON DATABASE "{db}" TO studio_app')
    apply_migration.apply(pg_uri, "studio_app")
    with as_app(pg_uri) as c:
        c.autocommit = False
        assert_no_egress(c, "studio_app")


def test_egress_checks_catch_a_role_that_may_create(migrated, pg_uri):
    """Sensitivity: the owner/superuser (CREATE everywhere, may CREATE EXTENSION) must FAIL the checks."""
    from tests.egress import assert_no_egress

    with psycopg.connect(pg_uri, autocommit=False) as c:
        with pytest.raises(AssertionError, match="CREATE"):
            assert_no_egress(c, "superuser")
    with psycopg.connect(pg_uri, autocommit=True) as c:
        c.execute("DROP ROLE IF EXISTS egress_probe")
        c.execute("CREATE ROLE egress_probe NOLOGIN")
        c.execute("GRANT CREATE ON SCHEMA public TO egress_probe")
    with psycopg.connect(pg_uri, autocommit=False) as c:
        c.execute("SET ROLE egress_probe")
        with pytest.raises(AssertionError, match="CREATE on"):
            assert_no_egress(c, "egress_probe")


def test_create_extension_is_refused_for_the_app_role_when_the_extension_exists(migrated, pg_uri):
    """Uses pgvector (shipped with the scratch server, not trusted) to prove the mechanism for a role
    without superuser: CREATE EXTENSION raises InsufficientPrivilege. dblink/postgres_fdw are contrib and
    absent from the scratch server; the live probe covers them against the real role."""
    with as_app(pg_uri) as c:
        avail = c.execute("SELECT count(*) FROM pg_available_extensions WHERE name = 'vector'").fetchone()[0]
        if not avail:
            pytest.skip("no stand-in extension on this server")
        c.autocommit = False
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute("CREATE EXTENSION vector")
