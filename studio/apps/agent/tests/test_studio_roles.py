"""ops/neon/0001_roles.sql + run-roles.sh against a throw-away local Postgres (never Neon).

Applies all 40 even-elo migrations, runs the wrapper, then runs the live L-C1 probe AS the new role.
Needs `pgserver` importable (or PSQL + STUDIO_TEST_PG_URI); otherwise the DB tests skip.
"""

import importlib.util
import os
import re
import stat
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

import psycopg
import pytest

from src import studio_tools
from tests.test_studio_live_staff_sql import migrations

REPO = Path(__file__).resolve().parents[4]
SQL = REPO / "ops" / "neon" / "0001_roles.sql"
SCRIPT = REPO / "ops" / "neon" / "run-roles.sh"
PROBE = Path(__file__).with_name("test_lc1_live_probe.py")
AGENT = Path(__file__).resolve().parents[1]

pytestmark = pytest.mark.skipif(not SQL.exists(), reason="even-elo ops/ not available")


def test_grant_list_agrees_across_sql_tools_and_probe():
    sql = SQL.read_text()
    m = re.search(r"GRANT SELECT ON ([a-z_, ]+) TO studio_gov_ro;", sql)
    granted = tuple(t.strip() for t in m.group(1).split(","))
    # tables the tools' SQL actually reads (FROM / JOIN), minus profile tables used by the app's live read
    used = set()
    for q in studio_tools.ALL_SQL.values():
        used |= set(re.findall(r"\b(?:FROM|JOIN)\s+([a-z_]+)\b", q))
    used -= {"jsonb_array_elements", "generate_series"}
    probe = re.search(r"GOV_TABLES = \(([^)]*)\)", PROBE.read_text()).group(1)
    probe_tables = tuple(t.strip().strip('"') for t in probe.split(",") if t.strip())
    assert set(granted) == set(studio_tools.GOVERNANCE_TABLES) == set(probe_tables) == used
    assert len(granted) == 6
    # column grants: exactly the two documented, nothing else granted
    assert re.findall(r"GRANT SELECT \(([a-z_, ]+)\) ON ([a-z_]+) TO studio_gov_ro;", sql) == [
        ("id, status, is_super_admin", "profiles_with_roles"),
        ("id, must_change_pin", "profiles"),
    ]
    assert len(re.findall(r"^GRANT ", sql, re.M)) == 4  # schema usage, tables, two column grants


def test_role_attributes_in_sql():
    sql = SQL.read_text()
    assert sql.count("NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5") == 2
    for setting in ("default_transaction_read_only = on", "statement_timeout = '15s'", "idle_in_transaction_session_timeout = '30s'"):
        assert setting in sql
    assert "PASSWORD :'pw'" in sql and not re.search(r"PASSWORD\s+'", sql)
    assert sql.index("REVOKE ALL ON ALL TABLES") < sql.index("GRANT USAGE")


def test_dry_run_prints_statements_without_connecting_or_a_password(tmp_path):
    out = subprocess.run(["bash", str(SCRIPT), "--dry-run"], capture_output=True, text=True, check=True, env={"PATH": os.environ["PATH"], "PSQL": "/nonexistent/psql"})
    assert "CREATE ROLE studio_gov_ro" in out.stdout
    assert "openssl rand" in out.stdout
    assert "PASSWORD '********'" in out.stdout and ":'pw'" not in out.stdout  # masked, no variable shown
    assert not list(tmp_path.iterdir())


def test_wrapper_validates_its_arguments(tmp_path):
    r = subprocess.run(["bash", str(SCRIPT)], capture_output=True, text=True)
    assert r.returncode == 2 and "usage" in r.stderr
    out = tmp_path / "out"
    r = subprocess.run(["bash", str(SCRIPT), str(tmp_path / "missing"), str(out)], capture_output=True, text=True)
    assert r.returncode == 2 and not out.exists()


@pytest.fixture(scope="module")
def pg():
    if importlib.util.find_spec("pgserver") is None:
        pytest.skip("pgserver not installed")
    import pgserver

    server = pgserver.get_server(tempfile.mkdtemp(prefix="studio-roles-"))
    psql = Path(pgserver.__file__).parent / "pginstall" / "bin" / "psql"
    yield server.get_uri(), str(psql)
    server.cleanup()


@pytest.fixture(scope="module")
def evenelo(pg):
    uri, _ = pg
    name = "evenelo_" + uuid.uuid4().hex[:8]
    with psycopg.connect(uri, autocommit=True) as c:
        c.execute(f'CREATE DATABASE "{name}"')
    owner_uri = uri.replace("@/postgres?", f"@/{name}?")  # a URL (the wrapper takes URLs), not a conninfo string
    assert name in owner_uri
    with psycopg.connect(owner_uri, autocommit=True) as conn:
        for _mid, sql in migrations():
            conn.execute(sql.replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", ""), prepare=False)
    return name, owner_uri


def run_wrapper(pg, owner_uri, tmp_path, tag):
    _, psql = pg
    owner_file = tmp_path / f"owner-{tag}"
    owner_file.write_text(owner_uri + "\n")
    owner_file.chmod(0o600)
    out_file = tmp_path / f"gov-ro-{tag}"
    scratch = tmp_path / f"tmp-{tag}"
    scratch.mkdir()
    r = subprocess.run(
        ["bash", str(SCRIPT), str(owner_file), str(out_file)],
        capture_output=True, text=True, env={"PATH": os.environ["PATH"], "PSQL": psql, "TMPDIR": str(scratch)},
    )
    return r, out_file, scratch


def role_state(owner_uri):
    with psycopg.connect(owner_uri, autocommit=True) as c:
        attrs = c.execute(
            "SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolconnlimit, rolconfig FROM pg_roles WHERE rolname = 'studio_gov_ro'"
        ).fetchone()
        acl = c.execute(
            "SELECT c.relname, c.relacl::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relacl IS NOT NULL ORDER BY 1"
        ).fetchall()
        cols = c.execute(
            "SELECT c.relname, a.attname, a.attacl::text FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE a.attacl IS NOT NULL AND c.relnamespace = 'public'::regnamespace ORDER BY 1, 2"
        ).fetchall()
        pw = c.execute("SELECT rolpassword FROM pg_authid WHERE rolname = 'studio_gov_ro'").fetchone()[0]
    return attrs, acl, cols, pw


def test_wrapper_applies_roles_and_the_amended_probe_passes_as_the_new_role(pg, evenelo, tmp_path):
    _, owner_uri = evenelo
    r, out_file, scratch = run_wrapper(pg, owner_uri, tmp_path, "1")
    assert r.returncode == 0, r.stderr
    url = out_file.read_text().strip()
    assert stat.S_IMODE(out_file.stat().st_mode) == 0o600
    password = re.match(r"postgres(?:ql)?://studio_gov_ro:([0-9a-f]{48})@", url).group(1)
    assert password not in r.stdout + r.stderr  # never echoed
    assert not list(scratch.iterdir())  # temp files shredded on exit

    attrs, acl, cols, pw = role_state(owner_uri)
    assert attrs[:8] == (True, False, False, False, False, False, False, 5)
    assert sorted(attrs[8]) == sorted(["default_transaction_read_only=on", "statement_timeout=15s", "idle_in_transaction_session_timeout=30s"])
    assert pw and pw.startswith("SCRAM-SHA-256$")

    env = {**os.environ, "GOV_RO_DATABASE_URL": url}
    probe = subprocess.run([sys.executable, "-m", "pytest", str(PROBE), "-q", "-p", "no:cacheprovider"], cwd=AGENT, env=env, capture_output=True, text=True)
    assert probe.returncode == 0, probe.stdout[-3000:]
    assert " passed" in probe.stdout and "skipped" not in probe.stdout and "failed" not in probe.stdout


def test_second_run_is_a_no_op_except_password_rotation(pg, evenelo, tmp_path):
    _, owner_uri = evenelo
    r1, out1, _ = run_wrapper(pg, owner_uri, tmp_path, "a")
    before = role_state(owner_uri)
    r2, out2, scratch = run_wrapper(pg, owner_uri, tmp_path, "b")
    assert r1.returncode == 0 and r2.returncode == 0, r2.stderr
    after = role_state(owner_uri)
    assert before[:3] == after[:3]  # attributes, table ACLs, column ACLs unchanged
    assert before[3] != after[3]  # password rotated
    assert out1.read_text() != out2.read_text()
    assert not list(scratch.iterdir())


def test_wrapper_refuses_to_overwrite_the_output_file(pg, evenelo, tmp_path):
    _, owner_uri = evenelo
    r, out, _ = run_wrapper(pg, owner_uri, tmp_path, "x")
    assert r.returncode == 0
    owner_file = tmp_path / "owner-x"
    again = subprocess.run(["bash", str(SCRIPT), str(owner_file), str(out)], capture_output=True, text=True)
    assert again.returncode == 2 and "refusing to overwrite" in again.stderr


def test_a_failing_sql_run_still_shreds_its_temp_files_and_writes_no_url(pg, evenelo, tmp_path):
    _, owner_uri = evenelo
    bad = tmp_path / "bad.sql"
    bad.write_text("SELECT * FROM table_that_does_not_exist;\n")
    owner_file = tmp_path / "owner-bad"
    owner_file.write_text(owner_uri + "\n")
    owner_file.chmod(0o600)
    out_file = tmp_path / "out-bad"
    scratch = tmp_path / "tmp-bad"
    scratch.mkdir()
    r = subprocess.run(
        ["bash", str(SCRIPT), str(owner_file), str(out_file)],
        capture_output=True, text=True, env={"PATH": os.environ["PATH"], "PSQL": pg[1], "TMPDIR": str(scratch), "SQL_FILE": str(bad)},
    )
    assert r.returncode != 0 and not out_file.exists() and not list(scratch.iterdir())
