"""ops/cdmss/run-login-mini.sh on Linux with stubs: hdiutil/diskutil/rm -P are stubs, Vercel and Neon are local mocks, the database is
the scratch Postgres. Proves the Mini wrapper's flow, its refusals (pooled url, test-only overrides), and its cleanup on every exit path
(success keeps ONLY the relay url on the still-attached RAM disk; failure and signals wipe everything and detach). Never touches a real
host, the Mac Mini or the Asus."""

import json
import os
import re
import shutil
import signal
import stat
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import quote, urlsplit

import psycopg
import pytest

from tests.cdmss_harness import OPS, ROLE, REPO, cdmss, needs_env  # noqa: F401  (fixture)
from tests.neon_harness import API_KEY, CDMSS_BRANCH, CDMSS_HOST, CDMSS_PROJECT, RUN_ROLES, MockNeon, keyfile  # noqa: F401  (fixtures)

WRAPPER = OPS / "run-login-mini.sh"
VERCEL_TOKEN = "vcp_TOKEN_do_not_leak_abcdef0123456789"
pytestmark = [needs_env, pytest.mark.skipif(shutil.which("jq") is None or shutil.which("curl") is None, reason="needs jq and curl")]


class MockVercel:
    def __init__(self, owner_url):
        self.owner_url, self.requests = owner_url, []
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                outer.requests.append((self.path, self.headers.get("authorization")))
                if self.headers.get("authorization") != f"Bearer {VERCEL_TOKEN}":
                    return self._send(403, {"error": "forbidden"})
                if re.fullmatch(r"/v9/projects/even-cdmss/env\?teamId=team_[A-Za-z0-9]+", self.path):
                    return self._send(200, {"envs": [
                        {"id": "e1", "key": "DATABASE_URL_UNPOOLED", "target": ["production"]},
                        {"id": "e2", "key": "NEON_PROJECT_ID", "target": ["production"]},
                        {"id": "e3", "key": "DATABASE_URL_UNPOOLED", "target": ["preview"]},
                    ]})
                m = re.fullmatch(r"/v1/projects/even-cdmss/env/(e[12])\?teamId=team_[A-Za-z0-9]+", self.path)
                if m:
                    return self._send(200, {"value": outer.owner_url if m.group(1) == "e1" else CDMSS_PROJECT})
                return self._send(404, {"error": "nope"})

            def _send(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = HTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def stop(self):
        self.server.shutdown()


@pytest.fixture
def world(tmp_path, cdmss, keyfile):
    neon = MockNeon(cdmss)
    vercel = MockVercel(cdmss.owner_url)
    stub = tmp_path / "stub"
    stub.mkdir()
    slog = tmp_path / "stub.log"
    mount = tmp_path / "vol" / "cdmssloginram"
    (tmp_path / "vol").mkdir()
    (stub / "hdiutil").write_text(f'#!/bin/bash\necho "hdiutil $*" >> "{slog}"\n'
                                  f'if [[ $1 == attach ]]; then echo "/dev/diskSTUB   Apple_partition_scheme"; fi\n'
                                  f'if [[ $1 == detach ]]; then rm -rf "{mount}"; fi\n')
    (stub / "diskutil").write_text(f'#!/bin/bash\necho "diskutil $*" >> "{slog}"\nmkdir -p "{mount}"\n')
    (stub / "secure-rm").write_text(f'#!/bin/bash\nfor f in "$@"; do echo "wipe $(basename "$f")" >> "{slog}"; rm -f "$f"; done\n')
    for f in stub.iterdir():
        f.chmod(0o755)
    auth = tmp_path / "auth.json"
    auth.write_text(json.dumps({"token": VERCEL_TOKEN}))
    w = type("W", (), {})()
    w.neon, w.vercel, w.mount, w.slog, w.tmp, w.cdmss, w.key = neon, vercel, mount, slog, tmp_path, cdmss, keyfile
    w.log = tmp_path / "login.log"
    w.env = {
        "PATH": f"{stub}:{os.environ['PATH']}", "HOME": str(tmp_path / "home"), "PSQL": cdmss.psql, "NEON_API_BASE": neon.url,
        "LOGIN_MINI_TEST": "1", "LOGIN_MINI_SKIP_GIT": "1", "LOGIN_MINI_REPO": str(REPO), "LOGIN_MINI_MOUNT": str(mount),
        "LOGIN_MINI_SECURE_RM": str(stub / "secure-rm"), "LOGIN_MINI_AUTH_JSON": str(auth), "LOGIN_MINI_NEON_KEY": str(keyfile),
        "VERCEL_API_BASE": vercel.url, "LOGIN_MINI_LOG": str(w.log),
    }
    yield w
    neon.stop()
    vercel.stop()
    cdmss.su_exec(f"ALTER ROLE {ROLE} NOLOGIN")


def run(w, *args, env=None):
    return subprocess.run(["bash", str(WRAPPER), *args], capture_output=True, text=True, env={**w.env, **(env or {})}, timeout=120)


def stublog(w):
    return w.slog.read_text() if w.slog.exists() else ""


def role_login(w):
    return w.cdmss.su_exec(f"SELECT rolcanlogin FROM pg_roles WHERE rolname='{ROLE}'")[0][0]


def no_secrets(w, r, *extra):
    hay = r.stdout + r.stderr + (w.log.read_text() if w.log.exists() else "")
    for secret in (VERCEL_TOKEN, API_KEY, w.cdmss.owner_url, *extra):
        assert secret not in hay
    for rec in w.neon.requests + w.vercel.requests:
        pass  # request headers carry the bearer by design; only the process side (argv/stdout/log) is asserted here


# ---------------------------------------------------------------- refusals


def test_refuses_test_overrides_and_non_mac_without_the_test_flag(world):
    r = run(world, env={"LOGIN_MINI_TEST": "0"})
    assert r.returncode == 2 and "test-only override" in r.stderr
    clean = {k: v for k, v in world.env.items() if not k.startswith("LOGIN_MINI_") and k != "VERCEL_API_BASE"}
    r = subprocess.run(["bash", str(WRAPPER)], capture_output=True, text=True, env=clean)
    assert r.returncode == 2 and "Mac Mini" in r.stderr and world.vercel.requests == [] and stublog(world) == ""
    r = subprocess.run(["bash", str(WRAPPER)], capture_output=True, text=True, env={**clean, "CDMSS_POSTCHECK_SQL": "/x"})
    assert r.returncode == 2 and "CDMSS_POSTCHECK_SQL" in r.stderr


def test_run_roles_refuses_the_postcheck_override_without_its_own_flag(world, tmp_path):
    owner = tmp_path / "o"
    owner.write_text(world.cdmss.owner_url + "\n")
    owner.chmod(0o600)
    env = {**os.environ, "PSQL": world.cdmss.psql, "XDG_RUNTIME_DIR": str(tmp_path), "CDMSS_POSTCHECK_SQL": "/dev/null"}
    r = subprocess.run(["bash", str(RUN_ROLES), "--role", ROLE, "--login", str(owner)], capture_output=True, text=True, env=env)
    assert r.returncode == 2 and "test-only" in r.stderr and not role_login(world)
    bad = tmp_path / "bad.sql"
    bad.write_text("DO $$ BEGIN RAISE EXCEPTION 'override ran'; END $$;\n")
    r = subprocess.run(["bash", str(RUN_ROLES), "--role", ROLE, "--login", str(owner)], capture_output=True, text=True,
                       env={**env, "CDMSS_POSTCHECK_SQL": str(bad), "CDMSS_ALLOW_TEST_POSTCHECK": "1"})
    assert r.returncode != 0 and "override ran" in r.stderr and not role_login(world)  # the override took effect and its failure contained LOGIN


def test_a_pooled_owner_url_is_refused_before_anything_runs(world):
    world.vercel.owner_url = "postgresql://neondb_owner:OWNERPW@ep-cool-1234-pooler.ap-south-1.aws.neon.tech/neondb?sslmode=require"
    r = run(world)
    assert r.returncode == 3 and "POOLED" in r.stderr
    assert world.neon.requests == [] and not role_login(world)  # no Neon call at all
    log = stublog(world)
    assert "wipe owner-url" in log and "wipe project.env" in log and "hdiutil detach /dev/diskSTUB" in log and not world.mount.exists()
    no_secrets(world, r, "OWNERPW")


# ---------------------------------------------------------------- success path


def test_success_leaves_only_the_relay_url_on_the_attached_ram_disk(world):
    r = run(world, env={"LOGIN_MINI_RELAY_HOST": "owner"})
    assert r.returncode == 0, r.stderr
    relay = world.mount / "relay-url"
    assert f"relay URL file: {relay}" in r.stdout and "LOGIN enabled" in r.stdout and len(r.stdout.strip().splitlines()) == 1
    assert stat.S_IMODE(relay.stat().st_mode) == 0o600 and (world.mount / ".device").read_text() == "/dev/diskSTUB"
    assert not (world.mount / "owner-url").exists() and not (world.mount / "project.env").exists()
    log = stublog(world)
    assert "diskutil erasevolume HFS+ cdmssloginram /dev/diskSTUB" in log and "hdiutil attach -nomount ram://65536" in log
    assert "wipe owner-url" in log and "wipe project.env" in log and "wipe relay-url" not in log and "hdiutil detach" not in log
    pw = world.neon.issued[ROLE]
    assert role_login(world) and quote(pw, safe="") in relay.read_text()
    with psycopg.connect(relay.read_text().strip(), autocommit=True) as c:  # the file really is the working url
        assert c.execute("SELECT count(*) FROM cdmss_ro.site_dim").fetchone()[0] >= 6
    # Vercel was asked for the production values of the named project, with the token only in the Authorization header
    assert [p.split("?")[0] for p, _ in world.vercel.requests] == ["/v9/projects/even-cdmss/env", "/v1/projects/even-cdmss/env/e1", "/v1/projects/even-cdmss/env/e2"]
    no_secrets(world, r, pw, quote(pw, safe=""))
    # the relay lane is done: --detach wipes it and detaches
    r2 = run(world, "--detach")
    assert r2.returncode == 0 and "wipe relay-url" in stublog(world) and "hdiutil detach /dev/diskSTUB" in stublog(world) and not world.mount.exists()


def test_default_host_is_the_api_discovered_endpoint(world):
    r = run(world)
    assert r.returncode == 0, r.stderr
    dsn = urlsplit((world.mount / "relay-url").read_text().strip())
    assert dsn.hostname == CDMSS_HOST and dsn.username == ROLE and dsn.path == "/cdmssdb"
    assert f"/api/v2/projects/{CDMSS_PROJECT}/endpoints" in [p for _, p, _, _ in world.neon.requests]
    run(world, "--detach")


def test_a_second_run_is_refused_while_the_ram_disk_is_still_there(world):
    assert run(world).returncode == 0
    r = run(world)
    assert r.returncode == 2 and "--detach" in r.stderr
    run(world, "--detach")


# ---------------------------------------------------------------- failure paths wipe everything


def assert_clean_failure(w):
    log = stublog(w)
    assert not w.mount.exists() and "hdiutil detach /dev/diskSTUB" in log and "wipe owner-url" in log
    assert not role_login(w)


def test_role_invisible_to_neon_exits_4_and_wipes(world):
    world.neon.hidden.add(ROLE)
    r = run(world)
    assert r.returncode == 4 and "cannot see" in r.stderr and world.neon.posts == []
    assert_clean_failure(world)


def test_login_failure_contains_the_role_and_removes_the_issued_url(world):
    with psycopg.connect(world.cdmss.owner_url, autocommit=True) as c:
        c.execute(f"GRANT SELECT (uid) ON public.opd_note_audits TO {ROLE}")
    try:
        r = run(world)
        assert r.returncode != 0 and "FAILED" in r.stderr
        assert_clean_failure(world)
        assert "wipe relay-url" in stublog(world)  # the url Neon had issued is wiped, not left behind
    finally:
        with psycopg.connect(world.cdmss.owner_url, autocommit=True) as c:
            c.execute(f"REVOKE ALL ON public.opd_note_audits FROM {ROLE}")


def test_a_signal_during_the_run_wipes_and_detaches(world):
    world.neon.reset_delay = 3.0
    proc = subprocess.Popen(["bash", str(WRAPPER)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=world.env)
    deadline = time.time() + 30
    while not world.neon.posts and time.time() < deadline:
        time.sleep(0.05)
    assert world.neon.posts, "the reset call never started"
    proc.send_signal(signal.SIGTERM)
    out, err = proc.communicate(timeout=60)
    assert proc.returncode == 143
    assert_clean_failure(world)
    no_secrets(world, subprocess.CompletedProcess([], 0, out, err))


def test_the_wrapper_never_puts_a_secret_on_a_command_line():
    t = WRAPPER.read_text()
    assert 'python3 - "$MOUNT/owner-url" "$MOUNT/project.env" <<' in t           # only file paths reach python
    assert not re.search(r"\bcurl\b", re.sub(r"#.*", "", t))                      # the Vercel call is python, key reads are files
    assert "TOKEN" not in re.sub(r"\n#.*", "", t.split("<<'PY'")[0])               # no token variable in the shell part
    assert t.index("umask 077") < t.index("hdiutil attach") and "/bin/rm -P" in t and "libexec/gnubin" in t
    assert re.search(r"trap 'exit 129' HUP\ntrap 'exit 130' INT\ntrap 'exit 143' TERM", t)
