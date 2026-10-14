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
    # NOSUPERUSER only in CREATE ROLE (a non-superuser CREATEROLE owner cannot mention it in ALTER);
    # LOGIN enabled by the very last statement; one transaction (run-roles.sh passes --single-transaction).
    assert sql.count("NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5") == 1
    assert not re.search(r"ALTER ROLE[^;]*NOSUPERUSER", sql)
    assert "CREATE ROLE studio_gov_ro NOLOGIN" in sql
    assert sql.rstrip().splitlines()[-1] == "ALTER ROLE studio_gov_ro LOGIN;"
    assert sql.count("LOGIN;") == 1 and "--single-transaction" in SCRIPT.read_text()
    for setting in ("default_transaction_read_only = on", "statement_timeout = '15s'", "idle_in_transaction_session_timeout = '30s'"):
        assert setting in sql
    assert "PASSWORD :'rolepw'" in sql and not re.search(r"PASSWORD\s+'", sql) and ":'pw'" not in sql
    assert sql.index("REVOKE ALL ON ALL TABLES") < sql.index("GRANT USAGE")


def test_dry_run_prints_statements_without_connecting_or_a_password(tmp_path):
    out = subprocess.run(["bash", str(SCRIPT), "--dry-run"], capture_output=True, text=True, check=True, env={"PATH": os.environ["PATH"], "PSQL": "/nonexistent/psql"})
    assert "CREATE ROLE studio_gov_ro" in out.stdout
    assert "openssl rand" in out.stdout
    assert "PASSWORD :'rolepw'" in out.stdout and "SCRAM-SHA-256" in out.stdout  # a variable, never a literal password
    assert "--neon-plaintext-password" in out.stdout
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
        capture_output=True, text=True, env={"PATH": os.environ["PATH"], "PSQL": psql, "XDG_RUNTIME_DIR": str(scratch)},
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
        capture_output=True, text=True, env={"PATH": os.environ["PATH"], "PSQL": pg[1], "XDG_RUNTIME_DIR": str(scratch), "SQL_FILE": str(bad)},
    )
    assert r.returncode != 0 and not out_file.exists() and not list(scratch.iterdir())


# ----- R7: the plaintext password never reaches the server -----


def scram_verifier_matches(verifier: str, password: str) -> bool:
    """Independent RFC 5802/7677 check: StoredKey/ServerKey recomputed from the password and the salt."""
    import base64
    import hashlib
    import hmac

    m = re.fullmatch(r"SCRAM-SHA-256\$(\d+):([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)", verifier)
    assert m, verifier
    iters, salt, stored, server = int(m.group(1)), base64.b64decode(m.group(2)), m.group(3), m.group(4)
    assert iters == 4096 and len(salt) == 16
    salted = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iters, 32)
    ck = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    return (
        base64.b64encode(hashlib.sha256(ck).digest()).decode() == stored
        and base64.b64encode(hmac.new(salted, b"Server Key", hashlib.sha256).digest()).decode() == server
    )


def _enable_scram_login(pg_server, owner_uri):
    """Make the scratch server really check passwords for studio_gov_ro (trust is the pgserver default)."""
    with psycopg.connect(owner_uri, autocommit=True) as c:
        hba = Path(c.execute("SHOW hba_file").fetchone()[0])
        c.execute("ALTER SYSTEM SET password_encryption = 'scram-sha-256'")
        c.execute("ALTER SYSTEM SET log_statement = 'all'")
        c.execute("ALTER SYSTEM SET log_min_error_statement = 'error'")
        c.execute("ALTER SYSTEM SET log_min_duration_statement = 0")
        hba.write_text("local all studio_gov_ro scram-sha-256\n" + hba.read_text())
        c.execute("SELECT pg_reload_conf()")


class ActivityPoller:
    """Samples pg_stat_activity.query while the wrapper runs (what any other session could see)."""

    def __init__(self, owner_uri):
        import threading

        self.uri, self.seen, self.stop = owner_uri, [], threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        with psycopg.connect(self.uri, autocommit=True) as c:
            while not self.stop.is_set():
                self.seen += [r[0] for r in c.execute("SELECT query FROM pg_stat_activity WHERE pid <> pg_backend_pid()").fetchall() if r[0]]

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *a):
        self.stop.set()
        self.thread.join(5)


def test_plaintext_password_never_reaches_the_server_logs_or_activity(pg, evenelo, tmp_path):
    import psycopg.errors

    uri, psql = pg
    name, owner_uri = evenelo
    import pgserver  # noqa: F401  (pg fixture already required it)

    with psycopg.connect(owner_uri) as c:
        pgdata = Path(c.execute("SHOW data_directory").fetchone()[0])
    log = pgdata / "log"
    _enable_scram_login(None, owner_uri)

    # 1) Normal run, with the statement log on 'all' and a poller watching pg_stat_activity.
    mark = log.stat().st_size
    with ActivityPoller(owner_uri) as poller:
        r, out_file, scratch = run_wrapper(pg, owner_uri, tmp_path, "scram")
    assert r.returncode == 0, r.stderr
    url = out_file.read_text().strip()
    password = re.match(r"postgres(?:ql)?://studio_gov_ro:([0-9a-f]{48})@", url).group(1)
    server_log = log.read_bytes()[mark:].decode(errors="replace")
    assert "ALTER ROLE studio_gov_ro PASSWORD" in server_log  # the statement IS logged (log_statement=all)...
    assert password not in server_log  # ...but only with the verifier
    assert all(password not in q for q in poller.seen)
    assert password not in r.stdout + r.stderr

    # 2) The stored verifier is SCRAM-SHA-256 and matches the plaintext only the output file holds.
    with psycopg.connect(owner_uri) as c:
        stored = c.execute("SELECT rolpassword FROM pg_authid WHERE rolname = 'studio_gov_ro'").fetchone()[0]
    assert stored.startswith("SCRAM-SHA-256$")
    assert scram_verifier_matches(stored, password)
    assert not scram_verifier_matches(stored, password[::-1])

    # 3) Login with the plaintext really works (scram enforced in pg_hba), a wrong password does not.
    sock = owner_uri.split("host=")[1]
    ok = psycopg.connect(host=sock, dbname=name, user="studio_gov_ro", password=password)
    assert ok.execute("SELECT current_user").fetchone()[0] == "studio_gov_ro"
    ok.close()
    with pytest.raises(psycopg.OperationalError):
        psycopg.connect(host=sock, dbname=name, user="studio_gov_ro", password="0" * 48)

    # 4) A FAILING ALTER ROLE ... PASSWORD (error path; log_min_error_statement=error logs "STATEMENT: ...").
    failing = tmp_path / "failing.sql"
    failing.write_text(SQL.read_text().replace("PASSWORD :'rolepw';", "PASSWORD :'rolepw' VALID UNTIL 'not-a-timestamp';"))
    mark = log.stat().st_size
    owner_file = tmp_path / "owner-fail"
    owner_file.write_text(owner_uri + "\n")
    owner_file.chmod(0o600)
    out2 = tmp_path / "out-fail"
    scratch2 = tmp_path / "tmp-fail"
    scratch2.mkdir()
    r2 = subprocess.run(
        ["bash", str(SCRIPT), str(owner_file), str(out2)],
        capture_output=True, text=True, env={"PATH": os.environ["PATH"], "PSQL": psql, "XDG_RUNTIME_DIR": str(scratch2), "SQL_FILE": str(failing)},
    )
    assert r2.returncode != 0 and not out2.exists() and not list(scratch2.iterdir())
    fail_log = log.read_bytes()[mark:].decode(errors="replace")
    assert "STATEMENT:  ALTER ROLE studio_gov_ro PASSWORD" in fail_log and "ERROR" in fail_log  # the failing statement was logged...
    assert "SCRAM-SHA-256$4096:" in fail_log  # ...with the verifier
    pw2 = re.findall(r"[0-9a-f]{48}", fail_log)
    assert pw2 == []  # no 48-hex plaintext anywhere in the log of the failure

    # 5) Negative control: the OLD plaintext form WOULD have leaked on the same path (the harness can see it).
    leak = "f" * 48
    leak_sql = tmp_path / "leak.sql"
    leak_sql.write_text(f"ALTER ROLE studio_gov_ro PASSWORD '{leak}' VALID UNTIL 'not-a-timestamp';\n")
    mark = log.stat().st_size
    subprocess.run([psql, "-X", "-q", "-f", str(leak_sql), owner_uri], capture_output=True, text=True)
    assert leak in log.read_bytes()[mark:].decode(errors="replace")


def test_temp_dir_is_tmpfs_only_unless_allowed(pg, evenelo, tmp_path):
    _, psql = pg
    _, owner_uri = evenelo
    owner_file = tmp_path / "owner-tmpfs"
    owner_file.write_text(owner_uri + "\n")
    owner_file.chmod(0o600)
    env = {"PATH": os.environ["PATH"], "PSQL": psql, "STUDIO_ROLES_SHM": str(tmp_path / "no-such-shm"), "TMPDIR": str(tmp_path)}
    out = tmp_path / "o1"
    r = subprocess.run(["bash", str(SCRIPT), str(owner_file), str(out)], capture_output=True, text=True, env=env)
    assert r.returncode == 2 and "tmpfs" in r.stderr and not out.exists()
    assert not list(tmp_path.glob("studio-roles.*"))  # nothing was written to the disk-backed dir
    out2 = tmp_path / "o2"
    r = subprocess.run(["bash", str(SCRIPT), "--allow-disk-tmp", str(owner_file), str(out2)], capture_output=True, text=True, env=env)
    assert r.returncode == 0 and out2.exists() and not list(tmp_path.glob("studio-roles.*"))
    # XDG_RUNTIME_DIR wins over /dev/shm.
    xdg = tmp_path / "xdg"
    xdg.mkdir()
    out3 = tmp_path / "o3"
    r = subprocess.run(["bash", str(SCRIPT), str(owner_file), str(out3)], capture_output=True, text=True, env={**env, "XDG_RUNTIME_DIR": str(xdg)})
    assert r.returncode == 0 and not list(xdg.iterdir())


# ----- R10: a NON-superuser CREATEROLE owner (Neon owners are never superusers) -----


@pytest.fixture
def pg_ns():
    """A SEPARATE cluster: roles are cluster-wide and studio_gov_ro must not pre-exist (a role created by
    another owner cannot be altered by a CREATEROLE owner without ADMIN OPTION)."""
    if importlib.util.find_spec("pgserver") is None:
        pytest.skip("pgserver not installed")
    import pgserver

    server = pgserver.get_server(tempfile.mkdtemp(prefix="studio-roles-ns-"))
    yield server.get_uri(), str(Path(pgserver.__file__).parent / "pginstall" / "bin" / "psql")
    server.cleanup()


def _owner_db(pg, tag, attrs):
    """A non-superuser owner role `attrs` (e.g. 'CREATEROLE') that OWNS a fresh database with the even-elo schema."""
    uri, _ = pg
    owner, name = f"own_{tag}_{uuid.uuid4().hex[:5]}", f"evenelo_{tag}_{uuid.uuid4().hex[:5]}"
    with psycopg.connect(uri, autocommit=True) as c:
        c.execute(f'CREATE ROLE "{owner}" LOGIN NOSUPERUSER {attrs}')
        c.execute(f'CREATE DATABASE "{name}" OWNER "{owner}"')
    sock = uri.split("host=")[1]
    owner_uri = f"postgresql://{owner}:@/{name}?host={sock}"
    with psycopg.connect(owner_uri, autocommit=True) as conn:
        assert conn.execute("SELECT rolsuper FROM pg_roles WHERE rolname = current_user").fetchone()[0] is False
        for _mid, sql in migrations():
            conn.execute(sql.replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", ""), prepare=False)
    return owner, owner_uri


def test_wrapper_works_for_a_non_superuser_createrole_owner(pg_ns, tmp_path):
    """Owner holds CREATEROLE + CREATEDB (so the ALTER re-asserts NOCREATEDB too); it owns the database."""
    pg = pg_ns
    owner, owner_uri = _owner_db(pg, "ns", "CREATEROLE CREATEDB")
    r, out_file, scratch = run_wrapper(pg, owner_uri, tmp_path, "ns")
    assert r.returncode == 0, r.stderr
    assert not list(scratch.iterdir())
    with psycopg.connect(owner_uri, autocommit=True) as c:
        a = c.execute(
            "SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit, rolconnlimit FROM pg_roles WHERE rolname = 'studio_gov_ro'"
        ).fetchone()
    assert a == (True, False, False, False, False, False, False, 5)
    probe = subprocess.run(
        [sys.executable, "-m", "pytest", str(PROBE), "-q", "-p", "no:cacheprovider"],
        cwd=AGENT, env={**os.environ, "GOV_RO_DATABASE_URL": out_file.read_text().strip()}, capture_output=True, text=True,
    )
    assert probe.returncode == 0 and "skipped" not in probe.stdout and "failed" not in probe.stdout, probe.stdout[-2500:]
    # Second run: no-op except the password.
    r2, out2, _ = run_wrapper(pg, owner_uri, tmp_path, "ns2")
    assert r2.returncode == 0, r2.stderr
    assert out_file.read_text() != out2.read_text()


def test_the_r5_alter_with_nosuperuser_really_fails_for_a_non_superuser_owner(pg_ns):
    pg = pg_ns
    """Regression guard for the verdict: mentioning NOSUPERUSER/NOREPLICATION/... in ALTER needs the attribute."""
    _, owner_uri = _owner_db(pg, "old", "CREATEROLE")
    with psycopg.connect(owner_uri, autocommit=True) as c:
        c.execute("CREATE ROLE old_style NOLOGIN")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute("ALTER ROLE old_style LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5")


def test_a_failure_part_way_leaves_no_loginable_role_without_grants(pg_ns, tmp_path):
    pg = pg_ns
    for attrs, tag in (("CREATEROLE", "atom1"),):
        owner, owner_uri = _owner_db(pg, tag, attrs)
        failing = tmp_path / f"fail-{tag}.sql"
        text = SQL.read_text().replace("GRANT SELECT (id, must_change_pin) ON profiles", "GRANT SELECT (id, no_such_column) ON profiles")
        failing.write_text(text)
        owner_file = tmp_path / f"owner-{tag}"
        owner_file.write_text(owner_uri + "\n")
        owner_file.chmod(0o600)
        scratch = tmp_path / f"tmp-{tag}"
        scratch.mkdir()
        r = subprocess.run(
            ["bash", str(SCRIPT), str(owner_file), str(tmp_path / f"out-{tag}")],
            capture_output=True, text=True,
            env={"PATH": os.environ["PATH"], "PSQL": pg[1], "XDG_RUNTIME_DIR": str(scratch), "SQL_FILE": str(failing)},
        )
        assert r.returncode != 0 and not (tmp_path / f"out-{tag}").exists() and not list(scratch.iterdir())
        with psycopg.connect(owner_uri, autocommit=True) as c:
            # Everything rolled back: the role does not exist at all (first run), so it cannot be LOGIN-able.
            assert c.execute("SELECT count(*) FROM pg_roles WHERE rolname = 'studio_gov_ro'").fetchone()[0] == 0


def test_a_failing_rerun_keeps_the_previous_state_and_never_exposes_a_half_configured_login(pg_ns, tmp_path):
    pg = pg_ns
    owner, owner_uri = _owner_db(pg, "atom2", "CREATEROLE")
    r, out_file, _ = run_wrapper(pg, owner_uri, tmp_path, "atom2")
    assert r.returncode == 0
    with psycopg.connect(owner_uri, autocommit=True) as c:
        before = c.execute("SELECT rolcanlogin, rolconnlimit, rolconfig FROM pg_roles WHERE rolname = 'studio_gov_ro'").fetchone()
        acl_before = c.execute("SELECT relacl::text FROM pg_class WHERE relname = 'physicians'").fetchone()
    failing = tmp_path / "fail-atom2.sql"
    failing.write_text(SQL.read_text().replace("GRANT SELECT (id, must_change_pin) ON profiles", "GRANT SELECT (id, no_such_column) ON profiles"))
    owner_file = tmp_path / "owner-atom2"
    owner_file.write_text(owner_uri + "\n")
    owner_file.chmod(0o600)
    scratch = tmp_path / "tmp-atom2b"
    scratch.mkdir()
    r = subprocess.run(
        ["bash", str(SCRIPT), str(owner_file), str(tmp_path / "out-atom2b")],
        capture_output=True, text=True, env={"PATH": os.environ["PATH"], "PSQL": pg[1], "XDG_RUNTIME_DIR": str(scratch), "SQL_FILE": str(failing)},
    )
    assert r.returncode != 0
    with psycopg.connect(owner_uri, autocommit=True) as c:
        after = c.execute("SELECT rolcanlogin, rolconnlimit, rolconfig FROM pg_roles WHERE rolname = 'studio_gov_ro'").fetchone()
        assert after == before and c.execute("SELECT relacl::text FROM pg_class WHERE relname = 'physicians'").fetchone() == acl_before


# ----- R11: --neon-plaintext-password (Neon's control plane rejects SCRAM verifiers) -----


def _wrap(pg, owner_uri, tmp_path, tag, *flags, sql_file=None):
    owner_file = tmp_path / f"owner-{tag}"
    owner_file.write_text(owner_uri + "\n")
    owner_file.chmod(0o600)
    out = tmp_path / f"out-{tag}"
    scratch = tmp_path / f"tmp-{tag}"
    scratch.mkdir()
    env = {"PATH": os.environ["PATH"], "PSQL": pg[1], "XDG_RUNTIME_DIR": str(scratch)}
    if sql_file:
        env["SQL_FILE"] = str(sql_file)
    r = subprocess.run(["bash", str(SCRIPT), *flags, str(owner_file), str(out)], capture_output=True, text=True, env=env)
    return r, out, scratch


def test_password_alter_is_the_last_statement_before_login():
    stmts = [l for l in SQL.read_text().splitlines() if l.startswith(("ALTER ROLE", "\\endif"))]
    assert stmts[-3:] == ["ALTER ROLE studio_gov_ro PASSWORD :'rolepw';", "\\endif", "ALTER ROLE studio_gov_ro LOGIN;"]


def test_flag_is_documented_and_unknown_flags_are_rejected(pg, evenelo, tmp_path):
    assert "--neon-plaintext-password" in SCRIPT.read_text()
    r, out, _ = _wrap(pg, evenelo[1], tmp_path, "badflag", "--bogus")
    assert r.returncode == 2 and "unknown option" in r.stderr and not out.exists()


def test_plaintext_mode_logs_in_with_the_plaintext_and_verifier_mode_stays_unchanged(pg_ns, tmp_path):
    uri, psql = pg_ns
    owner, owner_uri = _owner_db(pg_ns, "ptx", "CREATEROLE")
    name = re.search(r"@/([^?]+)\?", owner_uri).group(1)
    sock = uri.split("host=")[1]
    with psycopg.connect(uri, autocommit=True) as c:
        pgdata = Path(c.execute("SHOW data_directory").fetchone()[0])
        hba = Path(c.execute("SHOW hba_file").fetchone()[0])
        c.execute("ALTER SYSTEM SET password_encryption = 'scram-sha-256'")
        c.execute("ALTER SYSTEM SET log_statement = 'all'")
        hba.write_text("local all studio_gov_ro scram-sha-256\n" + hba.read_text())
        c.execute("SELECT pg_reload_conf()")
    log = pgdata / "log"

    # Plaintext mode: the server receives the plaintext (so Neon accepts it) and hashes it itself.
    mark = log.stat().st_size
    r, out, scratch = _wrap(pg_ns, owner_uri, tmp_path, "plain", "--neon-plaintext-password")
    assert r.returncode == 0, r.stderr
    password = re.match(r"postgres(?:ql)?://studio_gov_ro:([0-9a-f]{48})@", out.read_text().strip()).group(1)
    assert password not in r.stdout + r.stderr and not list(scratch.iterdir())
    conn = psycopg.connect(host=sock, dbname=name, user="studio_gov_ro", password=password)
    assert conn.execute("SELECT current_user").fetchone()[0] == "studio_gov_ro"
    conn.close()
    with pytest.raises(psycopg.OperationalError):
        psycopg.connect(host=sock, dbname=name, user="studio_gov_ro", password="0" * 48)
    with psycopg.connect(uri, autocommit=True) as c:
        stored = c.execute("SELECT rolpassword FROM pg_authid WHERE rolname = 'studio_gov_ro'").fetchone()[0]
    assert stored.startswith("SCRAM-SHA-256$") and scram_verifier_matches(stored, password)  # server-side hash
    assert password in log.read_bytes()[mark:].decode(errors="replace")  # the documented trade-off: statement log holds it

    # Verifier mode (default) on the same cluster: unchanged. New password, never in the log.
    mark = log.stat().st_size
    r2, out2, _ = _wrap(pg_ns, owner_uri, tmp_path, "verif")
    assert r2.returncode == 0, r2.stderr
    pw2 = re.match(r"postgres(?:ql)?://studio_gov_ro:([0-9a-f]{48})@", out2.read_text().strip()).group(1)
    assert pw2 != password and pw2 not in log.read_bytes()[mark:].decode(errors="replace")
    ok = psycopg.connect(host=sock, dbname=name, user="studio_gov_ro", password=pw2)
    ok.close()
    with pytest.raises(psycopg.OperationalError):
        psycopg.connect(host=sock, dbname=name, user="studio_gov_ro", password=password)  # rotated away


def test_plaintext_mode_failure_before_the_password_alter_never_logs_the_password(pg_ns, tmp_path):
    uri, _ = pg_ns
    owner, owner_uri = _owner_db(pg_ns, "ptf", "CREATEROLE")
    with psycopg.connect(uri, autocommit=True) as c:
        pgdata = Path(c.execute("SHOW data_directory").fetchone()[0])
        c.execute("ALTER SYSTEM SET log_statement = 'all'")
        c.execute("ALTER SYSTEM SET log_min_error_statement = 'error'")
        c.execute("SELECT pg_reload_conf()")
    log = pgdata / "log"
    failing = tmp_path / "fail-before.sql"
    failing.write_text(SQL.read_text().replace("GRANT SELECT (id, must_change_pin) ON profiles", "GRANT SELECT (id, no_such_column) ON profiles"))
    mark = log.stat().st_size
    r, out, scratch = _wrap(pg_ns, owner_uri, tmp_path, "ptf", "--neon-plaintext-password", sql_file=failing)
    assert r.returncode != 0 and not out.exists() and not list(scratch.iterdir())
    text = log.read_bytes()[mark:].decode(errors="replace")
    assert "no_such_column" in text  # the failing statement was logged...
    assert not re.findall(r"[0-9a-f]{48}", text)  # ...and no password was ever sent
