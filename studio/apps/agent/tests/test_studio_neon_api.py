"""ops/neon/neon-role.sh against a LOCAL mock of the Neon API v2, and run-roles.sh --password-preset on a
scratch Postgres with a pre-created role (what the API leaves behind). Never talks to Neon."""

import json
import os
import re
import shutil
import stat
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import quote

import psycopg
import pytest

from tests.test_studio_roles import AGENT, PROBE, SCRIPT, SQL, REPO, _owner_db, _wrap, pg_ns  # noqa: F401

NEON_ROLE = REPO / "ops" / "neon" / "neon-role.sh"
API_KEY = "napi_KEY_do_not_leak_0123456789abcdef"
PROJECT, BRANCH = "proj-quiet-1234", "br-main-5678"
pytestmark = pytest.mark.skipif(not NEON_ROLE.exists() or shutil.which("jq") is None or shutil.which("curl") is None, reason="needs jq and curl")


class MockNeon:
    def __init__(self):
        self.requests, self.password = [], "Pa55/w+rd@Gen0001"
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
                base = f"/api/v2/projects/{PROJECT}/branches/{BRANCH}"
                path = self.path
                if self.command == "GET" and path == "/api/v2/projects":
                    return self._send(200, {"projects": [{"id": PROJECT, "name": "Even Studio", "region_id": "aws-ap-south-1", "owner": {"email": "x@y"}}]})
                if self.command == "GET" and path == f"/api/v2/projects/{PROJECT}/branches":
                    return self._send(200, {"branches": [{"id": BRANCH, "name": "main", "connection_uri": "postgres://SECRET"}]})
                if self.command == "GET" and path == f"{base}/roles":
                    return self._send(200, {"roles": [{"name": "owner_role", "password": "LISTED-PW"}, {"name": "studio_app"}]})
                if self.command == "POST" and path == f"{base}/roles":
                    name = json.loads(body)["role"]["name"]
                    if name == "exists_already":
                        return self._send(409, {"message": "role exists"})
                    return self._send(201, {"role": {"name": name, "password": outer.password, "protected": False}, "operations": [{"id": "op1"}]})
                m = re.fullmatch(re.escape(base) + r"/roles/([a-z_0-9]+)/reset_password", path)
                if self.command == "POST" and m:
                    return self._send(200, {"role": {"name": m.group(1), "password": outer.password + "-reset"}, "operations": []})
                return self._send(404, {"message": "no such route"})

            do_GET = do_POST = _handle

        self.server = HTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/api/v2"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self):
        self.server.shutdown()


@pytest.fixture
def neon(tmp_path):
    m = MockNeon()
    yield m
    m.stop()


@pytest.fixture
def keyfile(tmp_path):
    f = tmp_path / "api-key"
    f.write_text(API_KEY + "\n")
    f.chmod(0o600)
    return f


class Run:
    def __init__(self, tmp_path, neon, tag):
        self.scratch = tmp_path / f"tmp-{tag}"
        self.scratch.mkdir()
        self.home = tmp_path / f"home-{tag}"
        self.home.mkdir()
        self.log = tmp_path / f"curl-argv-{tag}.log"
        wrapper_dir = tmp_path / f"bin-{tag}"
        wrapper_dir.mkdir()
        real = shutil.which("curl")
        # A curl in front of PATH that records argv and the environment of every call, then runs the real one.
        w = wrapper_dir / "curl"
        w.write_text(f'#!/bin/bash\n{{ printf "ARGV:"; printf " [%s]" "$@"; echo; env; }} >> "{self.log}"\nexec {real} "$@"\n')
        w.chmod(0o755)
        self.env = {
            "PATH": f"{wrapper_dir}:{os.environ['PATH']}",
            "HOME": str(self.home),
            "XDG_RUNTIME_DIR": str(self.scratch),
            "NEON_API_BASE": neon.url,
        }
        self.ps = []

    def run(self, *args, env=None):
        """Run the script; sample `ps` and keep only the script's own process tree (the pytest/agent
        processes elsewhere on the machine are not part of what we are proving)."""
        proc = subprocess.Popen(["bash", str(NEON_ROLE), *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env={**self.env, **(env or {})})
        stop = threading.Event()

        def snapshot():
            rows = subprocess.run(["ps", "-eo", "pid=,ppid=,args="], capture_output=True, text=True).stdout.splitlines()
            tree, kids = {proc.pid}, {}
            for row in rows:
                parts = row.split(None, 2)
                if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
                    kids.setdefault(int(parts[1]), []).append((int(parts[0]), parts[2] if len(parts) > 2 else ""))
            todo, lines = [proc.pid], []
            while todo:
                for pid, args_ in kids.get(todo.pop(), []):
                    if pid not in tree:
                        tree.add(pid)
                        todo.append(pid)
                        lines.append(args_)
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


def assert_nowhere(run, result, *secrets):
    hay = list(run.haystacks()) + [("stdout", result.stdout), ("stderr", result.stderr)]
    for label, text in hay:
        for secret in secrets:
            assert secret not in text, f"secret leaked into {label}"


def test_discover_lists_ids_and_role_names_only(tmp_path, neon, keyfile):
    run = Run(tmp_path, neon, "disc")
    r = run.run("discover", str(keyfile))
    assert r.returncode == 0, r.stderr
    assert f"project {PROJECT}" in r.stdout and f"branch {BRANCH}" in r.stdout and "roles: owner_role, studio_app" in r.stdout
    for hidden in ("SECRET", "LISTED-PW", "x@y", "aws-ap-south-1", "connection_uri"):
        assert hidden not in r.stdout + r.stderr
    assert_nowhere(run, r, API_KEY)


def test_create_writes_only_the_password_to_a_0600_file_and_it_appears_nowhere_else(tmp_path, neon, keyfile):
    run = Run(tmp_path, neon, "create")
    out = tmp_path / "pw-studio_gov_ro"
    r = run.run("create", str(keyfile), PROJECT, BRANCH, "studio_gov_ro", str(out))
    assert r.returncode == 0, r.stderr
    assert out.read_text() == neon.password + "\n" and stat.S_IMODE(out.stat().st_mode) == 0o600
    method, path, auth, body = neon.requests[-1]
    assert (method, path, auth) == ("POST", f"/api/v2/projects/{PROJECT}/branches/{BRANCH}/roles", f"Bearer {API_KEY}")
    assert json.loads(body) == {"role": {"name": "studio_gov_ro"}}
    assert not list(run.scratch.iterdir())  # curl config (holds the key) and temp dir are gone
    assert_nowhere(run, r, neon.password, API_KEY)


def test_create_with_dsn_builds_the_url_from_the_owner_host_and_encodes_the_password(tmp_path, neon, keyfile):
    run = Run(tmp_path, neon, "dsn")
    owner = tmp_path / "owner-url"
    owner.write_text("postgresql://owner_role:OWNERPW@ep-cool-1234.ap-south-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require\n")
    owner.chmod(0o600)
    out = tmp_path / "dsn-studio_app"
    r = run.run("create", str(keyfile), PROJECT, BRANCH, "studio_app", str(out), "--dsn-from", str(owner))
    assert r.returncode == 0, r.stderr
    assert out.read_text().strip() == f"postgresql://studio_app:{quote(neon.password, safe='')}@ep-cool-1234.ap-south-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
    assert "OWNERPW" not in out.read_text() and stat.S_IMODE(out.stat().st_mode) == 0o600
    assert_nowhere(run, r, neon.password, quote(neon.password, safe=""), API_KEY, "OWNERPW")


def test_reset_password_uses_the_reset_endpoint(tmp_path, neon, keyfile):
    run = Run(tmp_path, neon, "reset")
    out = tmp_path / "pw-reset"
    r = run.run("reset-password", str(keyfile), PROJECT, BRANCH, "studio_app", str(out))
    assert r.returncode == 0, r.stderr
    assert out.read_text() == neon.password + "-reset\n"
    assert neon.requests[-1][:3] == ("POST", f"/api/v2/projects/{PROJECT}/branches/{BRANCH}/roles/studio_app/reset_password", f"Bearer {API_KEY}")
    assert_nowhere(run, r, neon.password, API_KEY)


def test_refusals_and_failures_leave_nothing_behind(tmp_path, neon, keyfile):
    run = Run(tmp_path, neon, "bad")
    out = tmp_path / "out"
    out.write_text("existing")
    r = run.run("create", str(keyfile), PROJECT, BRANCH, "studio_gov_ro", str(out))
    assert r.returncode == 2 and "refusing to overwrite" in r.stderr and out.read_text() == "existing"
    assert neon.requests == []  # refused before any API call
    new = tmp_path / "new"
    for args, needle in [
        (("create", str(keyfile), "proj;rm", BRANCH, "r", str(new)), "invalid project"),
        (("create", str(keyfile), PROJECT, BRANCH, "Bad-Role", str(new)), "invalid role"),
        (("create", str(keyfile), PROJECT, BRANCH, "r", str(new), "--dsn-from", str(tmp_path / "nope")), "owner url file"),
        (("create", str(tmp_path / "nokey"), PROJECT, BRANCH, "r", str(new)), "API key file"),
    ]:
        r = run.run(*args)
        assert r.returncode == 2 and needle in r.stderr and not new.exists(), args
    loose = tmp_path / "loose-key"
    loose.write_text(API_KEY)
    loose.chmod(0o644)
    r = run.run("discover", str(loose))
    assert r.returncode == 2 and "mode 600" in r.stderr and API_KEY not in r.stdout + r.stderr
    r = run.run("create", str(keyfile), PROJECT, BRANCH, "exists_already", str(new))  # HTTP 409
    assert r.returncode != 0 and not new.exists() and API_KEY not in r.stdout + r.stderr and not list(run.scratch.iterdir())
    wrong = tmp_path / "wrong-key"
    wrong.write_text("some-other-key\n")
    wrong.chmod(0o600)
    r = run.run("create", str(wrong), PROJECT, BRANCH, "studio_gov_ro", str(new))
    assert r.returncode != 0 and not new.exists()
    r = run.run("discover", str(keyfile), env={"NEON_API_BASE": "http://example.com/api/v2"})
    assert r.returncode == 2 and "https" in r.stderr
    r = run.run("--allow-disk-tmp-not-a-flag")
    assert r.returncode == 2


def test_disk_backed_temp_is_refused_unless_allowed(tmp_path, neon, keyfile):
    run = Run(tmp_path, neon, "disk")
    env = {"XDG_RUNTIME_DIR": "", "STUDIO_ROLES_SHM": str(tmp_path / "no-shm"), "TMPDIR": str(tmp_path)}
    out = tmp_path / "o1"
    r = run.run("create", str(keyfile), PROJECT, BRANCH, "studio_gov_ro", str(out), env=env)
    assert r.returncode == 2 and "tmpfs" in r.stderr and not out.exists() and neon.requests == []
    r = run.run("--allow-disk-tmp", "create", str(keyfile), PROJECT, BRANCH, "studio_gov_ro", str(out), env=env)
    assert r.returncode == 0 and out.read_text() == neon.password + "\n" and not list(tmp_path.glob("neon-role.*"))


# ----- run-roles.sh --password-preset on a scratch server (the role pre-exists, as after the API call) -----


def _preset_env(pg_ns, tmp_path, tag):
    uri, psql = pg_ns
    owner, owner_uri = _owner_db(pg_ns, tag, "CREATEROLE")
    name = re.search(r"@/([^?]+)\?", owner_uri).group(1)
    sock = uri.split("host=")[1]
    preset_pw = "preset-from-the-api-0000"
    with psycopg.connect(owner_uri, autocommit=True) as c:  # what POST /roles leaves: LOGIN, password, no grants
        c.execute(f"CREATE ROLE studio_gov_ro LOGIN PASSWORD '{preset_pw}'")
    with psycopg.connect(uri, autocommit=True) as c:
        pgdata = Path(c.execute("SHOW data_directory").fetchone()[0])
        hba = Path(c.execute("SHOW hba_file").fetchone()[0])
        c.execute("ALTER SYSTEM SET password_encryption = 'scram-sha-256'")
        c.execute("ALTER SYSTEM SET log_statement = 'all'")
        hba.write_text("local all studio_gov_ro scram-sha-256\n" + hba.read_text())
        c.execute("SELECT pg_reload_conf()")
    return owner_uri, name, sock, preset_pw, pgdata / "log", uri


def test_password_preset_applies_grants_without_touching_the_password(pg_ns, tmp_path):
    owner_uri, name, sock, preset_pw, log, su = _preset_env(pg_ns, tmp_path, "pre")
    with psycopg.connect(su, autocommit=True) as c:
        stored_before = c.execute("SELECT rolpassword FROM pg_authid WHERE rolname = 'studio_gov_ro'").fetchone()[0]
    mark = log.stat().st_size
    r, out, scratch = _wrap(pg_ns, owner_uri, tmp_path, "pre", "--password-preset", no_out=True)
    assert r.returncode == 0, r.stderr
    assert "password preset" in r.stdout and not list(scratch.iterdir())
    with psycopg.connect(su, autocommit=True) as c:
        assert c.execute("SELECT rolpassword FROM pg_authid WHERE rolname = 'studio_gov_ro'").fetchone()[0] == stored_before
        attrs = c.execute("SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit, rolconnlimit FROM pg_roles WHERE rolname = 'studio_gov_ro'").fetchone()
    assert attrs == (True, False, False, False, False, False, False, 5)
    # Statement order in the server log (the NOLOGIN is dynamic SQL inside a DO block, so compare positions in the text):
    text = log.read_bytes()[mark:].decode(errors="replace")
    i_nologin = text.index("ALTER ROLE studio_gov_ro NOLOGIN")
    i_grant = text.index("GRANT SELECT ON physicians")
    i_login = text.rindex("ALTER ROLE studio_gov_ro LOGIN")
    assert i_nologin < i_grant < i_login
    assert "PASSWORD" not in text and preset_pw not in text  # no password statement of any kind
    # The API's password still logs in, and the amended probe passes as the role.
    psycopg.connect(host=sock, dbname=name, user="studio_gov_ro", password=preset_pw).close()
    url = f"postgresql://studio_gov_ro:{preset_pw}@/{name}?host={sock}"
    probe = subprocess.run([os.sys.executable, "-m", "pytest", str(PROBE), "-q", "-p", "no:cacheprovider"], cwd=AGENT, env={**os.environ, "GOV_RO_DATABASE_URL": url}, capture_output=True, text=True)
    assert probe.returncode == 0 and "skipped" not in probe.stdout and "failed" not in probe.stdout, probe.stdout[-2500:]


def test_password_preset_requires_an_existing_role_and_creates_nothing(pg_ns, tmp_path):
    owner, owner_uri = _owner_db(pg_ns, "nopre", "CREATEROLE")
    r, _, scratch = _wrap(pg_ns, owner_uri, tmp_path, "nopre", "--password-preset", no_out=True)
    assert r.returncode != 0 and "does not exist" in r.stderr and not list(scratch.iterdir())
    with psycopg.connect(owner_uri, autocommit=True) as c:
        assert c.execute("SELECT count(*) FROM pg_roles WHERE rolname = 'studio_gov_ro'").fetchone()[0] == 0


def test_password_preset_failure_rolls_back_and_nothing_is_half_configured(pg_ns, tmp_path):
    owner_uri, name, sock, preset_pw, log, su = _preset_env(pg_ns, tmp_path, "prefail")
    with psycopg.connect(owner_uri, autocommit=True) as c:
        before = c.execute("SELECT rolcanlogin, rolinherit, rolconnlimit, rolconfig FROM pg_roles WHERE rolname = 'studio_gov_ro'").fetchone()
    failing = tmp_path / "fail.sql"
    failing.write_text(SQL.read_text().replace("GRANT SELECT (id, must_change_pin) ON profiles", "GRANT SELECT (id, no_such_column) ON profiles"))
    r, _, scratch = _wrap(pg_ns, owner_uri, tmp_path, "prefail", "--password-preset", no_out=True, sql_file=failing)
    assert r.returncode != 0 and not list(scratch.iterdir())
    with psycopg.connect(owner_uri, autocommit=True) as c:
        assert c.execute("SELECT rolcanlogin, rolinherit, rolconnlimit, rolconfig FROM pg_roles WHERE rolname = 'studio_gov_ro'").fetchone() == before
        assert c.execute("SELECT has_table_privilege('studio_gov_ro', 'physicians', 'SELECT')").fetchone()[0] is False


def test_preset_mode_argument_validation(pg_ns, tmp_path):
    _, owner_uri = _owner_db(pg_ns, "args", "CREATEROLE")
    r = subprocess.run(["bash", str(SCRIPT), "--password-preset"], capture_output=True, text=True)
    assert r.returncode == 2 and "usage" in r.stderr
    f = tmp_path / "owner"
    f.write_text(owner_uri)
    r = subprocess.run(["bash", str(SCRIPT), "--password-preset", str(f), str(tmp_path / "extra")], capture_output=True, text=True)
    assert r.returncode == 2 and "usage" in r.stderr
