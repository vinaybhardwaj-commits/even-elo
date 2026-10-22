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
        self.owner_url, self.requests, self.fail_reason = owner_url, [], None
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                outer.requests.append((self.path, self.headers.get("authorization")))
                if self.headers.get("authorization") != f"Bearer {VERCEL_TOKEN}":
                    return self._send(403, {"error": "forbidden"})
                if outer.fail_reason and self.path.startswith("/v9/"):
                    self.send_response(500, outer.fail_reason)
                    self.send_header("content-length", "0")
                    self.end_headers()
                    return
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
    clean = {k: v for k, v in world.env.items() if not k.startswith("LOGIN_MINI_") and k not in ("VERCEL_API_BASE", "NEON_API_BASE", "PSQL")}
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


HOST_OR_FILE_ENV = {
    "NEON_API_BASE": "https://evil.example/api/v2", "SQL_FILE": "/tmp/x.sql", "PSQL": "/tmp/evil-psql", "LOGIN_MINI_LOG": "/tmp/x.log",
    "LOGIN_MINI_RELAY_HOST": "pooled", "STUDIO_ROLES_SHM": "/tmp", "XDG_RUNTIME_DIR": "/tmp", "CDMSS_ALLOW_TEST_POSTCHECK": "1",
    "PGHOST": "evil.example", "PGSERVICEFILE": "/tmp/svc", "PGSYSCONFDIR": "/tmp", "HTTPS_PROXY": "http://evil.example:3128",
    "https_proxy": "http://evil.example:3128", "CURL_CA_BUNDLE": "/tmp/ca", "PYTHONPATH": "/tmp", "PYTHONSTARTUP": "/tmp/s.py",
    "GIT_DIR": "/tmp/g", "BASH_ENV": "/tmp/b", "LD_PRELOAD": "/tmp/l.so", "DYLD_INSERT_LIBRARIES": "/tmp/l.dylib",
}


@pytest.mark.parametrize("name", sorted(HOST_OR_FILE_ENV))
def test_every_host_file_or_binary_redirect_is_refused_outside_test_mode(world, name):
    clean = {k: v for k, v in world.env.items() if not k.startswith("LOGIN_MINI_") and k not in ("VERCEL_API_BASE", "NEON_API_BASE", "PSQL")}
    r = subprocess.run(["bash", str(WRAPPER)], capture_output=True, text=True, env={**clean, name: HOST_OR_FILE_ENV[name]})
    assert r.returncode == 2 and name in r.stderr and ("refusing" in r.stderr), r.stderr
    assert world.vercel.requests == [] and world.neon.requests == [] and stublog(world) == ""   # nothing ran, no secret sent anywhere


def test_readme_names_exactly_the_refused_variables_and_the_code_refuses_them():
    code = WRAPPER.read_text()
    loop = re.search(r"for v in (LOGIN_MINI_REPO.*?); do\n    if \[\[ -n", code, re.S).group(1).replace("\\\n", " ")
    refused = set(loop.split())
    readme = (OPS / "README.md").read_text()
    section = readme[readme.index("## Test-only overrides"):]
    documented = set(re.findall(r"\b[A-Z][A-Z0-9_]{2,}\b", section.split("and every variable")[0]))
    assert refused <= documented
    assert {"LOGIN_MINI_LOG", "LOGIN_MINI_RELAY_HOST", "NEON_API_BASE", "SQL_FILE", "PSQL"} <= refused
    assert "LOGIN_MINI_RELAY_HOST=pooled|owner" not in readme   # the README no longer advertises a knob the code refuses


def test_python_stderr_reaches_the_log_only_through_the_filter(world):
    secret_reason = "postgres://leak:SECRETPW@h/db password=abc bearer xyz"
    world.vercel.fail_reason = secret_reason
    r = run(world)
    assert r.returncode == 2 and "could not pull" in r.stderr
    log = world.log.read_text()
    for leak in ("SECRETPW", "postgres://", "password", "bearer", VERCEL_TOKEN):
        assert leak not in log and leak not in r.stdout + r.stderr, leak
    assert "Traceback" in log                                    # the rest of python's stderr is still there for debugging
    assert not (world.mount / "py.err").exists() and "wipe py.err" in stublog(world) and not world.mount.exists()


def test_nologin_mode_pulls_the_owner_url_itself_runs_nologin_and_wipes_everything(world):
    world.cdmss.su_exec(f"ALTER ROLE {ROLE} LOGIN")
    r = run(world, "--nologin")
    assert r.returncode in (0, 5), r.stderr
    assert not role_login(world)
    log = stublog(world)
    assert "wipe owner-url" in log and "hdiutil detach /dev/diskSTUB" in log and not world.mount.exists() and world.neon.posts == []
    assert "relay-url" not in log
    assert r.returncode == 5 or "NOLOGIN" in r.stdout
    no_secrets(world, r)


def test_nologin_mode_refuses_a_pooled_url_too(world):
    world.vercel.owner_url = "postgresql://o:p@ep-x-pooler.ap-south-1.aws.neon.tech/db"
    world.cdmss.su_exec(f"ALTER ROLE {ROLE} LOGIN")
    r = run(world, "--nologin")
    assert r.returncode == 3 and role_login(world)   # nothing ran, so the role was not touched


def clean_env(world):
    return {k: v for k, v in world.env.items() if not k.startswith("LOGIN_MINI_") and k not in ("VERCEL_API_BASE", "NEON_API_BASE", "PSQL")}


def run_clean(world, extra):
    return subprocess.run(["bash", str(WRAPPER)], capture_output=True, text=True, env={**clean_env(world), **extra})


def nothing_ran(world):
    return world.vercel.requests == [] and world.neon.requests == [] and stublog(world) == "" and not world.mount.exists()


def test_the_refuters_newline_bypass_repro_exits_2_with_nothing_run(world):
    """v3 bypass: an env value 'a<NL>CURL_-x=1' made `${!v}` abort the whole scan, so PGHOST/DYLD_* were never checked."""
    r = run_clean(world, {"AAA": "a\nCURL_-x=1", "PGHOST": "evil", "DYLD_INSERT_LIBRARIES": "/x"})
    assert r.returncode == 2 and re.search(r"(PGHOST|DYLD_INSERT_LIBRARIES) redirects", r.stderr), r.stderr  # either, whichever the scan meets first
    assert nothing_ran(world)
    # the newline entry alone is refused as well, and so is each redirect without it
    r = run_clean(world, {"AAA": "a\nCURL_-x=1"})
    assert r.returncode == 2 and "odd entries" in r.stderr and nothing_ran(world)
    r = run_clean(world, {"DYLD_INSERT_LIBRARIES": "/x"})
    assert r.returncode == 2 and "DYLD_INSERT_LIBRARIES redirects" in r.stderr and nothing_ran(world)
    # a clean environment still reaches the next gate (not macOS), proving the scan itself does not misfire
    r = run_clean(world, {})
    assert r.returncode == 2 and "Mac Mini" in r.stderr


def test_a_newline_in_any_value_is_refused_even_without_an_invalid_name(world):
    r = run_clean(world, {"NOTE": "line one\nline two"})
    assert r.returncode == 2 and "odd entries" in r.stderr and nothing_ran(world)


def test_exported_bash_functions_are_refused_outside_test_mode(world):
    """An exported function can replace any command (uname => Darwin passed on Linux in the refuter's run)."""
    r = run_clean(world, {"BASH_FUNC_uname%%": "() { echo Darwin; }"})
    assert r.returncode == 2 and "exported bash functions" in r.stderr and nothing_ran(world)
    r = run_clean(world, {"BASH_FUNC_hdiutil%%": "() { echo pwned; }"})
    assert r.returncode == 2 and "exported bash functions" in r.stderr and nothing_ran(world)


def test_git_output_reaches_the_log_only_through_the_filter(world):
    stub = Path(world.env["PATH"].split(":")[0])
    (stub / "git").write_text('#!/bin/bash\necho "fatal: unable to access postgres://u:SECRETPW@h/db: password rejected, token=abc bearer xyz" >&2\necho "visible git line" >&2\nexit 1\n')
    (stub / "git").chmod(0o755)
    env = {k: v for k, v in world.env.items() if k != "LOGIN_MINI_SKIP_GIT"}
    r = subprocess.run(["bash", str(WRAPPER)], capture_output=True, text=True, env=env)
    assert r.returncode == 2 and "git fetch/checkout" in r.stderr
    log = world.log.read_text()
    for leak in ("SECRETPW", "postgres://", "password", "token", "bearer"):
        assert leak not in log and leak not in r.stdout + r.stderr, leak
    assert "visible git line" in log and world.vercel.requests == [] and stublog(world) == ""


# ---------------------------------------------------------------- v5: the environment is allowlisted, not denylisted


def secrets_absent(world, r):
    pw = world.neon.issued.get(ROLE)
    hay = r.stdout + r.stderr + (world.log.read_text() if world.log.exists() else "")
    for secret in (world.cdmss.owner_url, VERCEL_TOKEN, API_KEY, *([pw, quote(pw, safe="")] if pw else [])):
        assert secret not in hay, "a secret reached the terminal or the log"


def run_direct(world, extra, via_bash=False):
    """Run the wrapper the way an attacker-influenced shell would: exec'd through its shebang (bash -p), or `bash script` (ignores -p)."""
    cmd = ["bash", str(WRAPPER)] if via_bash else [str(WRAPPER)]
    return subprocess.run(cmd, capture_output=True, text=True, env={**world.env, "LOGIN_MINI_RELAY_HOST": "owner", **extra}, timeout=120)


@pytest.mark.parametrize("via_bash", [False, True], ids=["shebang", "bash-script"])
def test_shelloptions_xtrace_never_traces_the_owner_url(world, via_bash):
    """Refuter repro 1: SHELLOPTS=xtrace printed `+ raw=postgresql://owner:PW@...` on the Mini. No variable holds the url now, and the
    re-exec drops SHELLOPTS before any secret exists."""
    r = run_direct(world, {"SHELLOPTS": "xtrace"}, via_bash)
    assert r.returncode == 0, r.stderr
    secrets_absent(world, r)
    assert "+ raw" not in r.stderr and "postgres" not in r.stderr
    run(world, "--detach")


def test_ps4_code_execution_is_neutralised_by_the_shebang_and_the_documented_invocation(world, tmp_path):
    """Refuter repro 2: SHELLOPTS=xtrace PS4='$(touch F)' ran code. The shebang `bash -p` ignores SHELLOPTS at startup; the documented
    `env -i ... bash` form never passes it. (`bash script` ignores the -p: that route is the README's stated residual.)"""
    f = tmp_path / "F-shebang"
    r = run_direct(world, {"SHELLOPTS": "xtrace", "PS4": f"$(touch {f})"})
    assert r.returncode == 0, r.stderr
    assert not f.exists(), "PS4 command substitution ran"
    secrets_absent(world, r)
    run(world, "--detach")
    g = tmp_path / "F-envi"
    args = [f"{k}={v}" for k, v in {**world.env, "LOGIN_MINI_RELAY_HOST": "owner"}.items()]
    r = subprocess.run(["/usr/bin/env", "-i", *args, "/bin/bash", "--noprofile", "--norc", str(WRAPPER)], capture_output=True, text=True,
                       env={"SHELLOPTS": "xtrace", "PS4": f"$(touch {g})"}, timeout=120)
    assert r.returncode == 0, r.stderr
    assert not g.exists()
    secrets_absent(world, r)
    run(world, "--detach")


def test_bashopts_extdebug_has_no_effect(world, tmp_path):
    """Refuter repro 3: BASHOPTS=extdebug makes bash source a debugger file. BASH_ENV/ENV pointing at a file must not run either
    (through the shebang; `bash script` sources BASH_ENV before the first line, the documented residual, but still leaks no secret)."""
    marker = tmp_path / "sourced"
    hook = tmp_path / "hook.sh"
    hook.write_text(f"touch {marker}\n")
    for via_bash in (False, True):
        r = run_direct(world, {"BASHOPTS": "extdebug", "BASH_ENV": str(hook), "ENV": str(hook)}, via_bash)
        assert r.returncode == 0, r.stderr
        if not via_bash:
            assert not marker.exists(), "a startup file ran through the shebang"
        else:
            marker.unlink(missing_ok=True)   # `bash script` sources BASH_ENV before line one: the README's stated residual
        secrets_absent(world, r)
        run(world, "--detach")


@pytest.mark.parametrize("name", ["SHELLOPTS", "BASHOPTS", "PS4", "BASH_XTRACEFD", "PROMPT_COMMAND", "BASH_ENV", "ENV"])
def test_shell_control_variables_are_refused_outside_test_mode(world, name):
    r = subprocess.run(["bash", str(WRAPPER)], capture_output=True, text=True, env={**clean_env(world), name: "xtrace" if name != "BASH_XTRACEFD" else "9"})
    assert r.returncode == 2 and name in r.stderr and "refusing" in r.stderr, r.stderr
    assert nothing_ran(world)


def test_an_unknown_variable_never_reaches_a_child_process(world, tmp_path):
    dump = tmp_path / "envdump"
    stub = Path(world.env["PATH"].split(":")[0])
    for tool in ("hdiutil", "diskutil"):
        old = (stub / tool).read_text()
        (stub / tool).write_text(old.replace("#!/bin/bash\n", f'#!/bin/bash\nenv | cut -d= -f1 >> "{dump}"\n', 1))
    r = run_direct(world, {"FOO_EVIL": "1", "ANOTHER_EVIL": "x", "EDITOR": "evil"})
    assert r.returncode == 0, r.stderr
    names = set(dump.read_text().split())
    assert names and not {"FOO_EVIL", "ANOTHER_EVIL", "EDITOR", "SHELLOPTS"} & names
    allowed = {"PATH", "HOME", "USER", "LOGNAME", "LANG", "TERM", "PWD", "SHLVL", "_", "OLDPWD", "LOGIN_MINI_TEST", "LOGIN_MINI_LOG", "LOGIN_MINI_REPO",
               "LOGIN_MINI_SKIP_GIT", "LOGIN_MINI_MOUNT", "LOGIN_MINI_SECURE_RM", "LOGIN_MINI_AUTH_JSON", "LOGIN_MINI_NEON_KEY",
               "LOGIN_MINI_RELAY_HOST", "VERCEL_API_BASE", "NEON_API_BASE", "PSQL"}
    assert names <= allowed, names - allowed
    run(world, "--detach")


def test_outside_test_mode_an_unknown_variable_is_dropped_not_refused_and_known_ones_still_refused(world):
    r = subprocess.run(["bash", str(WRAPPER)], capture_output=True, text=True, env={**clean_env(world), "FOO_EVIL": "1"})
    assert r.returncode == 2 and "Mac Mini" in r.stderr and "FOO_EVIL" not in r.stderr   # dropped by the allowlist, then the next gate
    r = subprocess.run(["bash", str(WRAPPER)], capture_output=True, text=True, env={**clean_env(world), "FOO_EVIL": "1", "PGHOST": "evil"})
    assert r.returncode == 2 and "PGHOST redirects" in r.stderr


def test_the_owner_url_is_never_read_into_a_shell_variable():
    code = "\n".join(l for l in WRAPPER.read_text().splitlines() if not l.lstrip().startswith("#"))
    assert not re.search(r"\$\(<\s*\"?\$MOUNT/owner-url", code) and not re.search(r"=\$\(<", code)
    assert "set +x" in code.split("exec /usr/bin/env -i")[0]                        # before anything else, in the first block
    assert code.index("exec /usr/bin/env -i") < code.index("umask 077") < code.index("hdiutil attach")
    assert WRAPPER.read_text().startswith("#!/bin/bash -p\n")
