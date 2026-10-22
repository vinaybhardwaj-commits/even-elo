"""ops/neon/run-dw-writer-login-mini.sh on Linux with stubs (hdiutil/diskutil/rm -P stubs, local Neon API mock, scratch Postgres with the
governance schema and 0012 applied by the emulated non-superuser owner). Same style as test_cdmss_login_mini.py: secret scans, env attacks
(the v3/v4/v5 repros), pooled and permission refusals, signal wipe, and a failed post-check that leaves no writer-url. Never touches Neon,
the Mini or a real host."""

import os
import re
import shutil
import signal
import stat
import subprocess
import time
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlsplit

import psycopg
import pytest

from tests.neon_harness import API_KEY, BRANCH, GOV_HOST, OPS, PROJECT, RUN_ROLES, SQL_GOV, MockNeon, cluster, keyfile, run_roles  # noqa: F401  (fixtures)
from tests.test_studio_views import world  # noqa: F401  (0001, 0003, 0007..0011 applied)

WRAPPER = OPS / "run-dw-writer-login-mini.sh"
SQL_DW = OPS / "0012_studio_dw.sql"
ROLE = "studio_dw_writer"
pytestmark = pytest.mark.skipif(shutil.which("jq") is None or shutil.which("curl") is None or not WRAPPER.exists(), reason="needs jq, curl and the wrapper")


@pytest.fixture
def dw(world, tmp_path, keyfile):
    cluster, _, _ = world
    r, _ = run_roles(cluster, tmp_path, sql_file=SQL_DW, tag="dw0012")
    assert r.returncode == 0, r.stderr
    neon = MockNeon(cluster)
    stub = tmp_path / "stub"
    stub.mkdir()
    slog = tmp_path / "stub.log"
    mount = tmp_path / "vol" / "dwwriterram"
    (tmp_path / "vol").mkdir()
    (stub / "hdiutil").write_text(f'#!/bin/bash\necho "hdiutil $*" >> "{slog}"\nif [[ $1 == attach ]]; then echo "/dev/diskSTUB   Apple_partition_scheme"; fi\n'
                                  f'if [[ $1 == detach ]]; then rm -rf "{mount}"; fi\n')
    (stub / "diskutil").write_text(f'#!/bin/bash\necho "diskutil $*" >> "{slog}"\nmkdir -p "{mount}"\n')
    (stub / "secure-rm").write_text(f'#!/bin/bash\nfor f in "$@"; do echo "wipe $(basename "$f")" >> "{slog}"; rm -f "$f"; done\n')
    for f in stub.iterdir():
        f.chmod(0o755)
    owner_url = cluster.owner_url.replace("@/", f"@{GOV_HOST}/", 1)  # authority host = the mock endpoint; ?host=<socket> still routes libpq
    owner_src = tmp_path / "owner.url"
    owner_src.write_text(owner_url + "\n")
    owner_src.chmod(0o600)
    w = type("W", (), {})()
    w.cluster, w.neon, w.tmp, w.mount, w.slog, w.owner_src, w.owner_url, w.stub = cluster, neon, tmp_path, mount, slog, owner_src, owner_url, stub
    w.dest = tmp_path / "home" / ".config" / "studio-dw-extract" / "writer-url"
    w.log = tmp_path / "dw.log"
    w.env = {
        "PATH": f"{stub}:{os.environ['PATH']}", "HOME": str(tmp_path / "home"), "PSQL": cluster.psql, "NEON_API_BASE": neon.url,
        "LOGIN_MINI_TEST": "1", "LOGIN_MINI_SKIP_GIT": "1", "LOGIN_MINI_REPO": str(OPS.parent.parent), "LOGIN_MINI_MOUNT": str(mount),
        "LOGIN_MINI_SECURE_RM": str(stub / "secure-rm"), "LOGIN_MINI_NEON_KEY": str(keyfile), "LOGIN_MINI_LOG": str(w.log),
        "LOGIN_MINI_OWNER_URL": str(owner_src), "LOGIN_MINI_DEST": str(w.dest),
    }
    yield w
    neon.stop()
    cluster.su_exec(f"ALTER ROLE {ROLE} NOLOGIN")


def run(w, *args, env=None, direct=True):
    cmd = [str(WRAPPER)] if direct else ["bash", str(WRAPPER)]
    return subprocess.run([*cmd, *args], capture_output=True, text=True, env={**w.env, **(env or {})}, timeout=180)


def stublog(w):
    return w.slog.read_text() if w.slog.exists() else ""


def can_login(w):
    return w.cluster.su_exec(f"SELECT rolcanlogin FROM pg_roles WHERE rolname='{ROLE}'")[0][0]


def no_secrets(w, r, *extra):
    pw = w.neon.issued.get(ROLE)
    hay = r.stdout + r.stderr + (w.log.read_text() if w.log.exists() else "")
    for secret in (w.owner_url, API_KEY, *( [pw] if pw else []), *extra):
        assert secret not in hay, "a secret reached the terminal or the log"


def clean_env(w):
    return {k: v for k, v in w.env.items() if not k.startswith("LOGIN_MINI_") and k not in ("NEON_API_BASE", "PSQL")}


def nothing_ran(w):
    return w.neon.requests == [] and stublog(w) == "" and not w.mount.exists() and not w.dest.exists()


# ---------------------------------------------------------------- success


def other_roles(w):
    return w.cluster.su_exec(f"SELECT rolname, rolcanlogin, rolsuper, rolconfig::text, rolconnlimit, "
                             f"(SELECT array_agg(roleid::regrole::text ORDER BY 1) FROM pg_auth_members m WHERE m.member = r.oid), "
                             f"(SELECT count(*) FROM pg_class c WHERE c.relacl::text LIKE '%' || r.rolname || '=%') "
                             f"FROM pg_roles r WHERE rolname <> '{ROLE}' AND rolname NOT LIKE 'pg\\_%' ORDER BY 1")


def test_success_installs_the_url_atomically_and_proves_the_writer_is_fenced(dw):
    before_roles = other_roles(dw)
    dw.dest.parent.mkdir(parents=True)
    dw.dest.write_text("STALE-OLD-URL\n")
    r = run(dw)
    assert r.returncode == 0, r.stderr
    assert len(r.stdout.strip().splitlines()) == 1 and r.stdout.startswith(f"OK {ROLE}") and str(dw.dest) in r.stdout
    assert stat.S_IMODE(dw.dest.stat().st_mode) == 0o600 and stat.S_IMODE(dw.dest.parent.stat().st_mode) == 0o700
    assert sorted(p.name for p in dw.dest.parent.iterdir()) == ["writer-url"]          # no temp file left beside it
    assert "STALE" not in dw.dest.read_text()
    dsn = dw.dest.read_text().strip()
    assert urlsplit(dsn).username == ROLE and urlsplit(dsn).hostname == GOV_HOST       # direct host from the API (--host auto)
    log = stublog(dw)
    assert "hdiutil detach /dev/diskSTUB" in log and not dw.mount.exists()
    for f in ("owner-url", "project.env", "branch.id", "writer-url", "writer.svc", "check.sql"):
        assert f"wipe {f}" in log, f
    assert can_login(dw)
    # the installed file really authenticates as the writer, and the fence holds
    q = dict(parse_qsl(urlsplit(dsn).query))
    u = urlsplit(dsn)
    with psycopg.connect(host=q["host"], user=u.username, password=unquote(u.password), dbname=u.path.lstrip("/"), autocommit=True) as c:
        assert c.execute("SELECT current_user").fetchone()[0] == ROLE
        c.execute("BEGIN")
        c.execute("INSERT INTO studio_dw.extract_runs (run_id, mode, started_at, status) VALUES (gen_random_uuid(), 'full', now(), 'running')")
        c.execute("ROLLBACK")
        for stmt in ("SELECT 1 FROM public.physicians", "SELECT 1 FROM studio_ro.dw_doctors"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                c.execute(stmt)
    no_secrets(dw, r, "STALE-OLD-URL")
    # nothing in Neon other than the one reset on the one role
    assert [p for m, p, _, _ in dw.neon.requests if m == "POST"] == [f"/api/v2/projects/{PROJECT}/branches/{BRANCH}/roles/{ROLE}/reset_password"]
    # no grant and no other role was touched
    assert other_roles(dw) == before_roles, "another role changed"


def test_the_project_is_discovered_from_the_owner_url_host_not_typed(dw):
    r = run(dw)
    assert r.returncode == 0, r.stderr
    paths = [p for _, p, _, _ in dw.neon.requests]
    assert "/api/v2/projects" in paths and f"/api/v2/projects/{PROJECT}/endpoints" in paths


# ---------------------------------------------------------------- refusals


def test_a_loose_owner_url_file_is_refused_before_anything_runs(dw):
    dw.owner_src.chmod(0o644)
    r = run(dw)
    assert r.returncode == 2 and "mode 600" in r.stderr and nothing_ran(dw)


def test_a_loose_neon_key_file_is_refused(dw):
    Path(dw.env["LOGIN_MINI_NEON_KEY"]).chmod(0o644)
    r = run(dw)
    assert r.returncode == 2 and "not mode 600" in r.stderr and nothing_ran(dw)


def test_a_pooled_owner_url_is_refused_before_any_neon_call(dw):
    dw.owner_src.write_text("postgresql://neondb_owner:OWNERPW@ep-gov-main-1-pooler.ap-south-1.aws.neon.tech/neondb?sslmode=require\n")
    r = run(dw)
    assert r.returncode == 3 and "POOLED" in r.stderr and dw.neon.requests == [] and not dw.dest.exists()
    log = stublog(dw)
    assert "wipe owner-url" in log and "hdiutil detach /dev/diskSTUB" in log and not dw.mount.exists() and not can_login(dw)
    no_secrets(dw, r, "OWNERPW")


def test_an_owner_url_that_matches_no_neon_endpoint_is_refused_and_nothing_is_reset(dw):
    dw.owner_src.write_text(dw.owner_url.replace(GOV_HOST, "ep-someone-else-9.ap-south-1.aws.neon.tech") + "\n")
    r = run(dw)
    assert r.returncode == 2 and "could not discover" in r.stderr and dw.neon.posts == [] and not dw.dest.exists() and not can_login(dw)
    assert "hdiutil detach /dev/diskSTUB" in stublog(dw)


def test_a_role_neon_cannot_see_exits_4_and_leaves_an_existing_url_alone(dw):
    dw.dest.parent.mkdir(parents=True)
    dw.dest.write_text("EXISTING\n")
    dw.neon.hidden.add(ROLE)
    r = run(dw)
    assert r.returncode == 4 and "cannot see" in r.stderr and dw.neon.posts == []
    assert dw.dest.read_text() == "EXISTING\n"                       # nothing was reset, so the old url is still valid
    assert not dw.mount.exists() and not can_login(dw)


def test_a_second_run_is_refused_while_a_ram_disk_is_still_mounted(dw):
    dw.mount.mkdir(parents=True)
    r = run(dw)
    assert r.returncode == 2 and "already exists" in r.stderr and dw.neon.requests == []


# ---------------------------------------------------------------- failures leave no url and no LOGIN


def test_a_failed_post_check_removes_the_url_and_contains_the_role(dw):
    dw.dest.parent.mkdir(parents=True)
    dw.dest.write_text("OLD-URL-NOW-DEAD\n")
    dw.cluster.su_exec("GRANT SELECT ON public.physicians TO studio_dw_writer", db="neondb")   # a leak the post-check must catch
    r = run(dw)
    assert r.returncode == 1 and "post-check as the writer FAILED" in r.stderr
    assert not dw.dest.exists() and sorted(p.name for p in dw.dest.parent.iterdir()) == []   # the reset killed the old password: no url at all
    assert not can_login(dw) and not dw.mount.exists()
    log = stublog(dw)
    assert "wipe owner-url" in log and "wipe writer-url" in log and "hdiutil detach /dev/diskSTUB" in log
    no_secrets(dw, r)


def test_a_login_refusal_after_neon_adds_neon_superuser_leaves_no_url(dw):
    dw.neon.add_superuser_on_reset = True
    r = run(dw)
    assert r.returncode != 0 and "FAILED" in r.stderr and not dw.dest.exists() and not can_login(dw)
    dw.cluster.su_exec("REVOKE neon_superuser FROM studio_dw_writer")


def test_a_signal_mid_run_wipes_detaches_and_leaves_no_url(dw):
    dw.neon.reset_delay = 3.0
    proc = subprocess.Popen([str(WRAPPER)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=dw.env)
    deadline = time.time() + 40
    while not dw.neon.posts and time.time() < deadline:
        time.sleep(0.05)
    assert dw.neon.posts
    proc.send_signal(signal.SIGTERM)
    out, err = proc.communicate(timeout=60)
    assert proc.returncode == 143
    log = stublog(dw)
    assert "wipe owner-url" in log and "hdiutil detach /dev/diskSTUB" in log and not dw.mount.exists()
    assert not dw.dest.exists() and not can_login(dw)
    no_secrets(dw, subprocess.CompletedProcess([], 0, out, err))


# ---------------------------------------------------------------- environment attacks (v3 / v4 / v5 repros)


def run_clean(w, extra, direct=False):
    cmd = [str(WRAPPER)] if direct else ["bash", str(WRAPPER)]
    return subprocess.run(cmd, capture_output=True, text=True, env={**clean_env(w), **extra})


def test_the_v3_newline_bypass_repro_exits_2_with_nothing_run(dw):
    r = run_clean(dw, {"AAA": "a\nCURL_-x=1", "PGHOST": "evil", "DYLD_INSERT_LIBRARIES": "/x"})
    assert r.returncode == 2 and re.search(r"(PGHOST|DYLD_INSERT_LIBRARIES) redirects", r.stderr), r.stderr
    assert nothing_ran(dw)
    r = run_clean(dw, {"AAA": "a\nCURL_-x=1"})
    assert r.returncode == 2 and "odd entries" in r.stderr and nothing_ran(dw)


@pytest.mark.parametrize("name", ["SHELLOPTS", "BASHOPTS", "PS4", "BASH_XTRACEFD", "PROMPT_COMMAND", "BASH_ENV", "ENV"])
def test_shell_control_variables_are_refused_outside_test_mode(dw, name):
    r = run_clean(dw, {name: "xtrace" if name != "BASH_XTRACEFD" else "9"})
    assert r.returncode == 2 and name in r.stderr and nothing_ran(dw)


@pytest.mark.parametrize("name", ["NEON_API_BASE", "SQL_FILE", "PSQL", "LOGIN_MINI_LOG", "LOGIN_MINI_OWNER_URL", "LOGIN_MINI_DEST", "STUDIO_DW_DSN_FILE",
                                  "PGHOST", "PGSERVICEFILE", "HTTPS_PROXY", "CURL_CA_BUNDLE", "PYTHONPATH", "GIT_DIR", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"])
def test_every_redirect_variable_is_refused_outside_test_mode(dw, name):
    r = run_clean(dw, {name: "/tmp/evil"})
    assert r.returncode == 2 and name in r.stderr and nothing_ran(dw)


def test_exported_bash_functions_are_refused(dw):
    for fn in ("uname", "hdiutil", "install"):
        r = run_clean(dw, {f"BASH_FUNC_{fn}%%": "() { echo pwned; }"})
        assert r.returncode == 2 and "exported bash functions" in r.stderr and nothing_ran(dw)


@pytest.mark.parametrize("direct", [True, False], ids=["shebang", "bash-script"])
def test_xtrace_never_prints_the_owner_url_or_the_password(dw, direct):
    r = run(dw, env={"SHELLOPTS": "xtrace"}, direct=direct)
    assert r.returncode == 0, r.stderr
    assert "+ raw" not in r.stderr and "postgres" not in r.stderr
    no_secrets(dw, r)


def test_ps4_code_execution_is_neutralised_by_the_shebang(dw, tmp_path):
    f = tmp_path / "F"
    r = run(dw, env={"SHELLOPTS": "xtrace", "PS4": f"$(touch {f})"})
    assert r.returncode == 0, r.stderr
    assert not f.exists()
    no_secrets(dw, r)


def test_an_unknown_variable_never_reaches_a_child_process(dw, tmp_path):
    dump = tmp_path / "envdump"
    for tool in ("hdiutil", "diskutil"):
        p = dw.stub / tool
        p.write_text(p.read_text().replace("#!/bin/bash\n", f'#!/bin/bash\nenv | cut -d= -f1 >> "{dump}"\n', 1))
    r = run(dw, env={"FOO_EVIL": "1", "EDITOR": "evil"})
    assert r.returncode == 0, r.stderr
    names = set(dump.read_text().split())
    assert names and not {"FOO_EVIL", "EDITOR", "SHELLOPTS"} & names
    assert names <= {"PATH", "HOME", "USER", "LOGNAME", "LANG", "TERM", "PWD", "SHLVL", "_", "OLDPWD", "LOGIN_MINI_TEST", "LOGIN_MINI_LOG", "LOGIN_MINI_REPO",
                     "LOGIN_MINI_SKIP_GIT", "LOGIN_MINI_MOUNT", "LOGIN_MINI_SECURE_RM", "LOGIN_MINI_NEON_KEY", "LOGIN_MINI_OWNER_URL", "LOGIN_MINI_DEST",
                     "NEON_API_BASE", "PSQL", "XDG_RUNTIME_DIR", "STUDIO_ROLES_SHM"}, names


def test_python_stderr_and_git_output_reach_the_log_only_through_the_filter(dw):
    dw.neon.projects_fail_reason = "postgres://leak:SECRETPW@h/db password=abc bearer xyz"
    r = run(dw)
    assert r.returncode == 2 and "could not discover" in r.stderr
    log = dw.log.read_text()
    for leak in ("SECRETPW", "postgres://", "password", "bearer"):
        assert leak not in log and leak not in r.stdout + r.stderr, leak
    assert "Traceback" in log
    assert not dw.dest.exists() and "wipe py.err" in stublog(dw) and not dw.mount.exists()
    # git output
    dw.neon.projects_fail_reason = None
    (dw.stub / "git").write_text('#!/bin/bash\necho "fatal: postgres://u:SECRETPW@h/db password token bearer" >&2\necho "visible git line" >&2\nexit 1\n')
    (dw.stub / "git").chmod(0o755)
    env = {k: v for k, v in dw.env.items() if k != "LOGIN_MINI_SKIP_GIT"}
    r = subprocess.run([str(WRAPPER)], capture_output=True, text=True, env=env)
    assert r.returncode == 2 and "git fetch/checkout" in r.stderr
    log = dw.log.read_text()
    assert "SECRETPW" not in log and "visible git line" in log


# ---------------------------------------------------------------- static


def test_static_guarantees():
    t = WRAPPER.read_text()
    code = "\n".join(l for l in t.splitlines() if not l.lstrip().startswith("#"))
    assert t.startswith("#!/bin/bash -p\n") and os.access(WRAPPER, os.X_OK)
    assert code.index("exec /usr/bin/env -i") < code.index("umask 077") < code.index("hdiutil attach")
    assert "set +x" in code.split("exec /usr/bin/env -i")[0]
    assert not re.search(r"=\$\(<\s*\"?\$MOUNT/(owner-url|writer-url)", code) and not re.search(r"\$\(<\s*\"?\$OWNER_SRC", code)
    assert not re.search(r"\b(GRANT|REVOKE|CREATE ROLE|ALTER ROLE|DROP ROLE)\b", code), "the wrapper grants and alters nothing"
    assert "--host auto" in code and 'run-roles.sh" --role "$ROLE" --login' in code and "mv -f" in code and "umask 077" in code
    assert re.search(r"trap 'exit 129' HUP\ntrap 'exit 130' INT\ntrap 'exit 143' TERM", t)


def test_run_roles_accepts_the_writer_and_nothing_broader():
    r = subprocess.run(["bash", str(RUN_ROLES), "--role", ROLE, "--login", "--dry-run"], capture_output=True, text=True)
    assert r.returncode == 0 and 'ALTER ROLE :"role" LOGIN' in r.stdout
    r = subprocess.run(["bash", str(RUN_ROLES), "--role", "studio_other", "--dry-run"], capture_output=True, text=True)
    assert r.returncode == 2 and "studio_dw_writer" in r.stderr
