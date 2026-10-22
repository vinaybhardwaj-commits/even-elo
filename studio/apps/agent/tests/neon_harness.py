"""Shared harness for the Neon role scripts: a scratch PG with a Neon-like role layout (emulated), a mock
Neon API v2, and subprocess helpers. Nothing here talks to Neon.

Emulated Neon: neon_superuser (NOLOGIN CREATEDB CREATEROLE BYPASSRLS, member of pg_read_all_data) and a
NON-superuser owner `neondb_owner` (LOGIN CREATEDB CREATEROLE BYPASSRLS, member of neon_superuser) that owns
the databases. Roles created through the (mock) API get neon_superuser; roles created by SQL do not."""

import importlib.util
import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import psycopg
import pytest

from tests.pg_teardown import start_server, stop_server
from tests.test_studio_live_staff_sql import migrations

AGENT = Path(__file__).resolve().parents[1]
REPO = Path(__file__).resolve().parents[4]
OPS = REPO / "ops" / "neon"
RUN_ROLES = OPS / "run-roles.sh"
NEON_ROLE = OPS / "neon-role.sh"
SQL_GOV = OPS / "0001_roles.sql"
SQL_APP = OPS / "0002_studio_app_role.sql"
SQL_LOGIN = OPS / "0003_login.sql"
PROBE = AGENT / "tests" / "test_lc1_live_probe.py"
APP_PROBE = AGENT / "tests" / "test_studio_app_role_probe.py"
PROJECT, BRANCH = "proj-quiet-1234", "br-main-5678"
# A second Neon project (the CDMSS database): a default branch + a non-default one, each with a read_write endpoint.
CDMSS_PROJECT, CDMSS_BRANCH, CDMSS_BRANCH_DEV = "proj-cdmss-9999", "br-cdmss-main-1111", "br-cdmss-dev-2222"
CDMSS_HOST = "ep-cdmss-main-1.ap-south-1.aws.neon.tech"
GOV_HOST = "ep-gov-main-1.ap-south-1.aws.neon.tech"  # the governance project's read_write endpoint (branch BRANCH)
API_KEY = "napi_KEY_do_not_leak_0123456789abcdef"

needs_pg = pytest.mark.skipif(importlib.util.find_spec("pgserver") is None or not OPS.exists(), reason="needs pgserver and ops/neon")


class Cluster:
    def __init__(self):
        import pgserver

        self.server = start_server("neon-emu")
        self.su = self.server.get_uri()  # superuser url (harness only)
        self.sock = self.su.split("host=")[1]
        self.psql = str(Path(pgserver.__file__).parent / "pginstall" / "bin" / "psql")
        with psycopg.connect(self.su, autocommit=True) as c:
            self.pgdata = Path(c.execute("SHOW data_directory").fetchone()[0])
            hba = Path(c.execute("SHOW hba_file").fetchone()[0])
            c.execute("CREATE ROLE neon_superuser NOLOGIN CREATEDB CREATEROLE BYPASSRLS")
            c.execute("GRANT pg_read_all_data TO neon_superuser")
            c.execute("CREATE ROLE neondb_owner LOGIN CREATEDB CREATEROLE BYPASSRLS")
            c.execute("GRANT neon_superuser TO neondb_owner")
            for db in ("neondb", "studiodb"):
                c.execute(f'CREATE DATABASE {db} OWNER neondb_owner')
            c.execute("ALTER SYSTEM SET password_encryption = 'scram-sha-256'")
            c.execute("ALTER SYSTEM SET log_statement = 'all'")
            c.execute("ALTER SYSTEM SET log_min_error_statement = 'error'")
            hba.write_text("local all studio_gov_ro,studio_app,studio_dw_writer scram-sha-256\n" + hba.read_text())
            c.execute("SELECT pg_reload_conf()")
        self.log = self.pgdata / "log"
        self.owner_url = self.url("neondb_owner", "neondb")
        self.studio_owner_url = self.url("neondb_owner", "studiodb")
        with psycopg.connect(self.owner_url, autocommit=True) as conn:
            assert conn.execute("SELECT rolsuper FROM pg_roles WHERE rolname = current_user").fetchone()[0] is False
            for _mid, sql in migrations():
                conn.execute(sql.replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", ""), prepare=False)

    def url(self, user, db, password=None):
        return f"postgresql://{user}:{password or ''}@/{db}?host={self.sock}"

    def su_exec(self, sql, db=None):
        uri = self.su if db is None else self.su.replace("@/postgres?", f"@/{db}?")
        with psycopg.connect(uri, autocommit=True) as c:
            return c.execute(sql).fetchall() if sql.lstrip().upper().startswith("SELECT") else c.execute(sql)

    def allow_signal(self):
        """Let the emulated owner end the roles' sessions (what Neon's owner may or may not have: UNVERIFIED)."""
        self.su_exec("GRANT pg_signal_backend TO neondb_owner")

    def owner_exec(self, sql, db="neondb"):
        with psycopg.connect(self.url("neondb_owner", db), autocommit=True) as c:
            return c.execute(sql)

    def acl(self, rel, db="neondb"):
        return self.su_exec(f"SELECT coalesce(relacl::text, '') FROM pg_class WHERE relname = '{rel}'", db=db)

    def log_mark(self):
        return self.log.stat().st_size

    def log_since(self, mark):
        return self.log.read_bytes()[mark:].decode(errors="replace")

    def stop(self):
        stop_server(self.server)


@pytest.fixture
def cluster():
    if importlib.util.find_spec("pgserver") is None:
        pytest.skip("pgserver not installed (uv run --with pgserver python -m pytest)")
    c = Cluster()
    yield c
    c.stop()


def owner_file(tmp_path, url, tag="owner"):
    f = tmp_path / f"{tag}-url"
    f.write_text(url + "\n")
    f.chmod(0o600)
    return f


def run_roles(cluster, tmp_path, *flags, url=None, sql_file=None, tag="rr", extra_env=None):
    """Run run-roles.sh as the emulated Neon owner. Returns (CompletedProcess, tmpfs scratch dir)."""
    scratch = tmp_path / f"scratch-{tag}-{uuid.uuid4().hex[:4]}"
    scratch.mkdir()
    env = {"PATH": os.environ["PATH"], "PSQL": cluster.psql, "XDG_RUNTIME_DIR": str(scratch), **(extra_env or {})}
    if sql_file:
        env["SQL_FILE"] = str(sql_file)
    f = owner_file(tmp_path, url or cluster.owner_url, tag)
    r = subprocess.run(["bash", str(RUN_ROLES), *flags, str(f)], capture_output=True, text=True, env=env)
    return r, scratch


def role_row(cluster, name):
    with psycopg.connect(cluster.owner_url, autocommit=True) as c:
        return c.execute(
            "SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit, rolconnlimit, rolconfig FROM pg_roles WHERE rolname = %s",
            (name,),
        ).fetchone()


def memberships(cluster, name):
    return [r[0] for r in cluster.su_exec(f"SELECT roleid::regrole::text FROM pg_auth_members WHERE member = '{name}'::regrole")] if role_row(cluster, name) else []


def non_comment_sql(path: Path) -> str:
    return "\n".join(l for l in path.read_text().splitlines() if not l.lstrip().startswith("--"))


class MockNeon:
    """Neon API v2 subset on localhost. reset_password issues a server-side password and (emulating Neon)
    sets it on the role in the scratch DB; `add_superuser_on_reset` additionally grants neon_superuser, as
    Neon does for roles it manages. `hidden` roles are not listed (and not resettable)."""

    def __init__(self, cluster=None):
        self.cluster, self.requests, self.hidden, self.add_superuser_on_reset = cluster, [], set(), False
        self.projects_fail_reason = None
        self.visible_extra = set()
        # Neon (live, 22 Oct): reset_password answers HTTP 422 for a NOLOGIN role (authentication_method "no_login"). Opt-in so the older
        # primitive tests (reset before LOGIN) keep their meaning; the wrapper fixtures turn it on.
        self.reject_reset_for_nologin, self.reset_422_message, self.passworded = False, "role has no login privilege", set()
        self.force_reset_status, self.reset_log = None, []   # force_reset_status: answer reset_password with this HTTP status; reset_log: (role, can_login) per call
        self.issued = {}
        self.reset_delay = 0.0  # seconds to hold the response AFTER the server-side rotation (kill tests)
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _handle(self):
                n = int(self.headers.get("content-length") or 0)
                body = self.rfile.read(n).decode() if n else ""
                outer.requests.append((self.command, self.path, self.headers.get("authorization"), body))
                if self.headers.get("authorization") != f"Bearer {API_KEY}":
                    return self._send(401, {"message": "unauthorized"})
                path = self.path.split("?")[0]
                mp = re.match(r"/api/v2/projects/([^/]+)/branches/([^/]+)/roles", path)
                pair = (mp.group(1), mp.group(2)) if mp else None
                base = f"/api/v2/projects/{pair[0]}/branches/{pair[1]}" if pair in ((PROJECT, BRANCH), (CDMSS_PROJECT, CDMSS_BRANCH), (CDMSS_PROJECT, CDMSS_BRANCH_DEV)) else f"/api/v2/projects/{PROJECT}/branches/{BRANCH}"
                if self.command == "GET" and path == "/api/v2/projects" and outer.projects_fail_reason:
                    self.send_response(500, outer.projects_fail_reason)
                    self.send_header("content-length", "0")
                    self.end_headers()
                    return
                if self.command == "GET" and path == f"/api/v2/projects/{PROJECT}/endpoints":
                    return self._send(200, {"endpoints": [{"id": "ep-gov-main-1", "branch_id": BRANCH, "type": "read_write", "host": GOV_HOST}]})
                if self.command == "GET" and path == "/api/v2/projects":
                    return self._send(200, {"projects": [{"id": PROJECT, "name": "Even Studio", "region_id": "aws-ap-south-1", "owner": {"email": "x@y"}},
                                                          {"id": CDMSS_PROJECT, "name": "Even CDMSS", "region_id": "aws-ap-south-1", "owner": {"email": "x@y"}}]})
                if self.command == "GET" and path == f"/api/v2/projects/{PROJECT}/branches":
                    return self._send(200, {"branches": [{"id": BRANCH, "name": "main", "connection_uri": "postgres://SECRET"}]})
                if self.command == "GET" and path == f"/api/v2/projects/{CDMSS_PROJECT}/branches":
                    return self._send(200, {"branches": [{"id": CDMSS_BRANCH, "name": "main", "default": True, "connection_uri": "postgres://SECRET"},
                                                         {"id": CDMSS_BRANCH_DEV, "name": "dev", "default": False, "connection_uri": "postgres://SECRET"}]})
                if self.command == "GET" and path == f"/api/v2/projects/{CDMSS_PROJECT}/endpoints":
                    return self._send(200, {"endpoints": [{"id": "ep-cdmss-main-1", "branch_id": CDMSS_BRANCH, "type": "read_write", "host": CDMSS_HOST, "password_hash": "SECRET"},
                                                          {"id": "ep-cdmss-main-ro", "branch_id": CDMSS_BRANCH, "type": "read_only", "host": "ep-cdmss-ro.ap-south-1.aws.neon.tech"},
                                                          {"id": "ep-cdmss-dev-1", "branch_id": CDMSS_BRANCH_DEV, "type": "read_write", "host": "ep-cdmss-dev-1.ap-south-1.aws.neon.tech"}]})
                if self.command == "GET" and path == f"{base}/roles":
                    names = ["neondb_owner"]
                    if outer.cluster:
                        names = [r[0] for r in outer.cluster.su_exec("SELECT rolname FROM pg_roles WHERE rolname IN (" + ",".join(f"'{n}'" for n in ['neondb_owner','studio_gov_ro','studio_app','studio_cdmss_ro','studio_dw_writer', *outer.visible_extra]) + ") ORDER BY 1")]
                    return self._send(200, {"roles": [{"name": x, "password": "LISTED-PW", "authentication_method": outer.auth_method(x)} for x in names if x not in outer.hidden]})
                m = re.fullmatch(re.escape(base) + r"/roles/([a-z_0-9]+)/reset_password", path)
                if self.command == "POST" and m:
                    role = m.group(1)
                    if role in outer.hidden:
                        return self._send(404, {"message": "role not found"})
                    if outer.cluster:
                        outer.reset_log.append((role, outer.can_login(role)))
                    if outer.force_reset_status:
                        return self._send(outer.force_reset_status, {"code": "", "message": outer.reset_422_message})
                    if outer.cluster and outer.reject_reset_for_nologin and not outer.can_login(role):
                        return self._send(422, {"code": "", "message": outer.reset_422_message})
                    pw = "Is5ued/" + uuid.uuid4().hex + "+X@" + str(len(outer.issued))
                    outer.issued[role] = pw
                    if outer.cluster:
                        outer.cluster.su_exec(f"ALTER ROLE {role} PASSWORD '{pw}'")  # what Neon does server-side
                        if outer.add_superuser_on_reset:
                            outer.cluster.su_exec(f"GRANT neon_superuser TO {role}")
                    if outer.reset_delay:
                        time.sleep(outer.reset_delay)
                    return self._send(200, {"role": {"name": role, "password": pw}, "operations": []})
                return self._send(404, {"message": "no such route"})

            do_GET = do_POST = _handle

        self.server = HTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/api/v2"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def can_login(self, role):
        rows = self.cluster.su_exec(f"SELECT rolcanlogin FROM pg_roles WHERE rolname = '{role}'")
        return bool(rows and rows[0][0])

    def auth_method(self, role):
        """What the API says about a role: no_login (NOLOGIN), else a password method once a password was issued, else no_password."""
        if not self.cluster:
            return "password"
        if not self.can_login(role):
            return "no_login"
        return "scram-sha-256" if (role in self.issued or role in self.passworded) else "no_password"

    def stop(self):
        self.server.shutdown()

    @property
    def posts(self):
        return [r for r in self.requests if r[0] == "POST"]


@pytest.fixture
def neon(cluster):
    m = MockNeon(cluster)
    yield m
    m.stop()


@pytest.fixture
def keyfile(tmp_path):
    f = tmp_path / "api-key"
    f.write_text(API_KEY + "\n")
    f.chmod(0o600)
    return f


class NeonRun:
    """Runs neon-role.sh with a recording curl wrapper and ps sampling of the script's process tree."""

    def __init__(self, tmp_path, neon_url, tag):
        self.scratch = tmp_path / f"nscratch-{tag}"
        self.scratch.mkdir()
        self.home = tmp_path / f"home-{tag}"
        self.home.mkdir()
        self.log = tmp_path / f"curl-argv-{tag}.log"
        wrapper_dir = tmp_path / f"bin-{tag}"
        wrapper_dir.mkdir()
        real = shutil.which("curl")
        w = wrapper_dir / "curl"
        w.write_text(f'#!/bin/bash\n{{ printf "ARGV:"; printf " [%s]" "$@"; echo; env; }} >> "{self.log}"\nexec {real} "$@"\n')
        w.chmod(0o755)
        self.env = {"PATH": f"{wrapper_dir}:{os.environ['PATH']}", "HOME": str(self.home), "XDG_RUNTIME_DIR": str(self.scratch), "NEON_API_BASE": neon_url}
        self.ps = []

    def run(self, *args, env=None):
        proc = subprocess.Popen(["bash", str(NEON_ROLE), *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env={**self.env, **(env or {})})
        stop = threading.Event()

        def snapshot():
            rows = subprocess.run(["ps", "-eo", "pid=,ppid=,args="], capture_output=True, text=True).stdout.splitlines()
            kids = {}
            for row in rows:
                parts = row.split(None, 2)
                if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
                    kids.setdefault(int(parts[1]), []).append((int(parts[0]), parts[2] if len(parts) > 2 else ""))
            todo, seen, lines = [proc.pid], {proc.pid}, []
            while todo:
                for pid, a in kids.get(todo.pop(), []):
                    if pid not in seen:
                        seen.add(pid)
                        todo.append(pid)
                        lines.append(a)
            return "\n".join(lines)

        def poll():
            while not stop.is_set():
                self.ps.append(snapshot())
                time.sleep(0.002)

        t = threading.Thread(target=poll, daemon=True)
        t.start()
        try:
            out, err = proc.communicate()
        finally:
            stop.set()
            t.join(2)
        return subprocess.CompletedProcess(proc.args, proc.returncode, out, err)

    def haystacks(self):
        yield "ps snapshots", "\n".join(self.ps)
        if self.log.exists():
            yield "curl argv+env log", self.log.read_text()
        for f in self.home.rglob("*"):
            if f.is_file():
                yield f"HOME file {f.name}", f.read_text(errors="replace")
        for f in self.scratch.rglob("*"):
            if f.is_file():
                yield f"tmpfs leftover {f.name}", f.read_text(errors="replace")


def assert_nowhere(run, result, *secrets, extra=()):
    hay = list(run.haystacks()) + [("stdout", result.stdout), ("stderr", result.stderr), *extra]
    for label, text in hay:
        for secret in secrets:
            assert secret not in text, f"secret leaked into {label}"


def full_flow(cluster, neon, tmp_path, keyfile, role="studio_gov_ro", db="neondb", tag="flow", owner_url=None):
    """setup -> reset-password -> login. Returns (setup, reset, login) results and the DSN out file."""
    owner_url = owner_url or (cluster.owner_url if db == "neondb" else cluster.studio_owner_url)
    flags = [] if role == "studio_gov_ro" else ["--role", role]
    s, _ = run_roles(cluster, tmp_path, *flags, url=owner_url, tag=f"{tag}s")
    nr = NeonRun(tmp_path, neon.url, tag)
    out = tmp_path / f"dsn-{role}-{tag}"
    of = owner_file(tmp_path, owner_url, f"{tag}o")
    r = nr.run("reset-password", str(keyfile), PROJECT, BRANCH, role, str(out), "--dsn-from", str(of))
    return s, r, nr, out


def incident_view_ddl(table: str = "public.incidents") -> str:
    """The studio_ro.incident_register DDL exactly as 0009_incidents_view.sql defines it (for tests on a plain superuser schema)."""
    sql = (OPS / "0009_incidents_view.sql").read_text()
    ddl = re.search(r"CREATE OR REPLACE VIEW studio_ro\.incident_register.*?;", sql, re.S).group(0)
    return "CREATE SCHEMA IF NOT EXISTS studio_ro; " + ddl.replace("public.incidents", table)
