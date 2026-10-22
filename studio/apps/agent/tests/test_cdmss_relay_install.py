"""ops/cdmss/relay-install.sh (the Mini mover) and ops/cdmss/asus-relay-apply.sh (its Asus half) on Linux with fakes: ssh runs the remote
command locally under a fake root, sudo/systemctl/the egress refresh are stubs, and the verification's psycopg is a scripted fake. No real
host, no Mini, no Asus, no Neon, no network. Proves: the flow and what it changes, secret scans (argv, stdout, logs, every file), a
rollback to the exact previous bytes on every failure, refusals of bad urls/modes/environments, bash-3.2 hygiene of the Mini script,
the relay render for the cdmss alias, and that the Squid allowlist and nft rules are unchanged except the pinned CDMSS addresses."""

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[4]
OPS = REPO / "ops" / "cdmss"
ASUS_OPS = REPO / "ops" / "asus"
MOVER = OPS / "relay-install.sh"
APPLY = OPS / "asus-relay-apply.sh"

PW = "NeonPw_Zz9xQ7LmKp2VbT4hN8cR1sXe"          # the Neon-issued password inside the relay url
HOST = "ep-quiet-dust-a1b2c3d4.ap-southeast-1.aws.neon.tech"
URL = f"postgresql://studio_cdmss_ro:{PW}@{HOST}/neondb?sslmode=require"

NEON_ENV0 = "GOV_NEON_URL=postgres://studio_gov_ro:govpw@gov.example.neon.tech/gov\nSTUDIO_NEON_URL=postgres://studio_app:studpw@gov.example.neon.tech/studio\n"
LOCAL_ENV0 = "AGENT_GOV_PW=aaaa\nAGENT_STUDIO_PW=bbbb\n"
AGENT_ENV0 = "STUDIO_LIVE_READS=0\nGOV_RO_DATABASE_URL=postgresql://agent_gov:aaaa@127.0.0.1:6432/gov?sslmode=disable\nCDMSS_RO_DATABASE_URL=\n"

pytestmark = pytest.mark.skipif(shutil.which("bash") is None or shutil.which("base64") is None, reason="needs bash and base64")


def write(path, text, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(mode)


FAKE_PSYCOPG = '''
import json, os, stat
LOG = os.environ["FAKE_PSYCOPG_LOG"]
MODE = os.environ.get("FAKE_PSYCOPG_MODE", "ok")
def log(**kw):
    with open(LOG, "a") as f:
        f.write(json.dumps(kw) + "\\n")
class Err(Exception):
    def __init__(self, sqlstate):
        super().__init__(sqlstate); self.sqlstate = sqlstate
class Cur:
    def __init__(self, v): self.v = v
    def fetchone(self): return (self.v,)
class Conn:
    def __init__(self): self.ro = True
    def execute(self, sql):
        s = " ".join(sql.split()).lower()
        log(sql=s)
        if s == "select current_user": return Cur("somebody_else" if MODE == "wrongrole" else "studio_cdmss_ro")
        if s.startswith("select count(*) from cdmss_ro."): return Cur(16)
        if s.startswith("set default_transaction_read_only"): return Cur(None)
        if s.startswith("delete from cdmss_ro."):
            if MODE == "writeok": return Cur(None)
            raise Err("42501")
        if s.startswith("select 1 from public."):
            if MODE == "baseok": return Cur(1)
            raise Err("42501")
        raise Err("XX000")
def connect(conninfo, autocommit=False):
    pf = os.environ.get("PGPASSFILE", "")
    ok = bool(pf) and os.path.exists(pf) and stat.S_IMODE(os.stat(pf).st_mode) == 0o600
    log(connect=conninfo, passfile_ok=ok, password_in_conninfo=("password" in conninfo.lower()))
    if MODE == "connectfail" or not ok:
        raise Err("08006")
    return Conn()
'''

FAKE_SSH = r'''#!/bin/bash
# fake ssh: records argv, copies stdin, runs the remote command here under the fake root.
set -u
D={d}
printf '%s\0' "$@" >> "$D/ssh.argv"
n=$(($# - 1)); host=${{@: -2:1}}; cmd=${{@: -1}}
cat > "$D/ssh.stdin.$(date +%s%N)"
last=$(ls "$D"/ssh.stdin.* | tail -1)
export ASUS_RELAY_TEST=1 ASUS_ROOT={root} ASUS_RUNAS= ASUS_VENV_PY={fakepy} PATH={bin}:$PATH FAKE_PSYCOPG_LOG={d}/psycopg.log
export FAKE_PSYCOPG_MODE=$(cat {d}/psycopg.mode 2>/dev/null || echo ok)
if [ -e "$D/ssh.fail" ]; then echo "ssh: connect to host failed" >&2; exit 255; fi
if [ -e "$D/ssh.drop" ] && ! grep -q rollback <<<"$cmd"; then
  rm -f "$D/ssh.drop"
  bash -c "$cmd" < "$last" > "$D/ssh.partial" 2>&1 &
  pid=$!
  for i in $(seq 200); do grep -q CDMSS_NEON_URL {root}/etc/studio-pgrelay/neon.env && break; sleep 0.05; done
  kill -HUP $pid 2>/dev/null; wait $pid 2>/dev/null
  echo "Connection to host closed." >&2; exit 255
fi
bash -c "$cmd" < "$last"
'''


@pytest.fixture
def world(tmp_path):
    d = tmp_path / "w"
    root = d / "asus"
    mount = d / "ram"
    bin_ = d / "bin"
    d.mkdir()
    for sub in ("run", "run/lock", "usr/local/sbin", "etc/studio-agent", "etc/studio-pgrelay"):
        (root / sub).mkdir(parents=True, exist_ok=True)
    mount.mkdir()
    bin_.mkdir()
    write(root / "etc/studio-pgrelay/neon.env", NEON_ENV0)
    write(root / "etc/studio-pgrelay/local.env", LOCAL_ENV0)
    write(root / "etc/studio-agent/env", AGENT_ENV0)
    # the installed scripts (stubs that carry the markers the precheck greps for)
    write(root / "usr/local/sbin/studio-pgrelay-render", "#!/bin/bash\n# CDMSS_NEON_URL alias supported\n", 0o755)
    write(root / "usr/local/sbin/studio-agent-egress-refresh", f"""#!/bin/bash
# neon-hosts.extra supported
echo "refresh extra=$(cat {root}/etc/studio-agent/neon-hosts.extra 2>/dev/null | tr '\\n' ',')" >> {d}/refresh.log
[ ! -e {d}/refresh.fail ] || {{ [ -e {root}/etc/studio-agent/neon-hosts.extra ] && exit 1; }}
exit 0
""", 0o755)
    write(bin_ / "systemctl", f"#!/bin/bash\necho \"$@\" >> {d}/systemctl.log\n[ \"$1\" = restart ] && [ -e {d}/restart.fail ] && exit 1\nexit 0\n", 0o755)
    write(bin_ / "sudo", "#!/bin/bash\n[ \"$1\" = -n ] && shift\nexec \"$@\"\n", 0o755)
    fakepy_dir = d / "fakepsycopg"
    fakepy_dir.mkdir()
    write(fakepy_dir / "psycopg.py", FAKE_PSYCOPG, 0o644)
    fakepy = d / "fakepy"
    write(fakepy, f"#!/bin/bash\nshift  # drop -I (it would ignore PYTHONPATH)\nexec env PYTHONPATH={fakepy_dir} {sys.executable} \"$@\"\n", 0o755)
    ssh = d / "ssh"
    write(ssh, FAKE_SSH.format(d=d, root=root, fakepy=fakepy, bin=bin_), 0o755)
    login = d / "login-mini"
    write(login, f"#!/bin/bash\necho \"$@\" >> {d}/login.log\nrm -f {mount}/relay-url\n", 0o755)
    write(mount / "relay-url", URL + "\n")
    w = type("W", (), {})()
    w.d, w.root, w.mount, w.ssh, w.login, w.bin = d, root, mount, ssh, login, bin_
    w.log = d / "mover.log"
    return w


def run_mover(w, *args, extra_env=None, url_file=True):
    env = {
        "PATH": os.environ["PATH"], "HOME": str(w.d), "RELAY_INSTALL_TEST": "1",
        "RELAY_INSTALL_MOUNT": str(w.mount), "RELAY_INSTALL_SSH": str(w.ssh), "RELAY_INSTALL_ASUS": "vinay@100.65.203.79",
        "RELAY_INSTALL_LOGIN_MINI": str(w.login), "RELAY_INSTALL_LOG": str(w.log), "RELAY_INSTALL_NOT_MAC": "1",
    }
    env.update(extra_env or {})
    return subprocess.run(["/bin/bash", "--noprofile", "--norc", str(MOVER), *args], env=env, capture_output=True, text=True, timeout=120)


def snapshot(w):
    out = {}
    for rel in ("etc/studio-pgrelay/neon.env", "etc/studio-pgrelay/local.env", "etc/studio-agent/env", "etc/studio-agent/neon-hosts.extra"):
        p = w.root / rel
        out[rel] = (p.read_bytes(), stat.S_IMODE(p.stat().st_mode)) if p.exists() else None
    return out


def all_files_text(w):
    """(path, bytes) of every file under the world, EXCLUDING the fake ssh's raw stdin capture (the test's own tap on the wire)."""
    for p in w.d.rglob("*"):
        if p.is_file() and not p.name.startswith("ssh.stdin."):
            yield p, p.read_bytes()


def combined(r):
    return r.stdout + r.stderr


# ------------------------------------------------------------------------------------------------------------- the happy path
def test_install_flow_changes_exactly_the_four_items_and_wipes(world):
    w = world
    before = snapshot(w)
    r = run_mover(w)
    assert r.returncode == 0, combined(r)
    out = combined(r)
    for line in ("asus url ok", f"asus host {HOST}", "asus config written", "asus egress refreshed, relay restarted",
                 "asus verify current_user ok current_user=studio_cdmss_ro", "asus verify select-count ok", "asus verify write-refused ok",
                 "asus verify base-table-refused ok", "asus relay ready", "mover: relay-url wiped"):
        assert line in out, (line, out)
    after = snapshot(w)
    # 1 neon.env: + CDMSS_NEON_URL only, same mode
    neon, mode = after["etc/studio-pgrelay/neon.env"]
    assert mode == 0o600
    assert neon.decode() == NEON_ENV0 + f"CDMSS_NEON_URL={URL}\n"
    # 2 local.env: + AGENT_CDMSS_PW (48 hex)
    local, mode = after["etc/studio-pgrelay/local.env"]
    assert mode == 0o600 and local.decode().startswith(LOCAL_ENV0)
    m = re.fullmatch(r"AGENT_CDMSS_PW=([0-9a-f]{48})\n", local.decode()[len(LOCAL_ENV0):])
    assert m, local
    lpw = m.group(1)
    # 3 agent env: only the CDMSS line changes, it points at the relay with the loopback password, same mode
    env, mode = after["etc/studio-agent/env"]
    assert mode == 0o600
    assert env.decode() == AGENT_ENV0.replace("CDMSS_RO_DATABASE_URL=\n", f"CDMSS_RO_DATABASE_URL=postgresql://agent_cdmss:{lpw}@127.0.0.1:6432/cdmss?sslmode=disable\n")
    # 4 the pinned host
    assert after["etc/studio-agent/neon-hosts.extra"] == (HOST.encode() + b"\n", 0o644)
    # runtime: refresh ran with the host present, the relay was restarted, the agent was not touched
    assert f"extra={HOST}," in (w.d / "refresh.log").read_text()
    sc = (w.d / "systemctl.log").read_text()
    assert "restart studio-pgrelay.service" in sc and "studio-agent" not in sc.replace("studio-agent-egress", "")
    # the detach ran, and only after success
    assert (w.d / "login.log").read_text().strip() == "--detach"
    assert not (w.mount / "relay-url").exists()
    assert before["etc/studio-agent/neon-hosts.extra"] is None


def test_verification_runs_as_the_agent_over_the_relay_without_the_password_in_the_dsn(world):
    w = world
    assert run_mover(w).returncode == 0
    lines = [json.loads(l) for l in (w.d / "psycopg.log").read_text().splitlines()]
    conn = [l for l in lines if "connect" in l][0]
    assert conn["connect"].startswith("host=127.0.0.1 port=6432 dbname=cdmss user=agent_cdmss")
    assert conn["passfile_ok"] is True and conn["password_in_conninfo"] is False
    sqls = [l["sql"] for l in lines if "sql" in l]
    assert sqls == ["select current_user", "select count(*) from cdmss_ro.ams_formulary", "set default_transaction_read_only = off",
                    "delete from cdmss_ro.ams_formulary where false", "select 1 from public.formulary limit 1"]


def test_the_scratch_pgpass_is_gone_afterwards(world):
    w = world
    assert run_mover(w).returncode == 0
    assert not list((w.root / "run").glob("studio-cdmss-*")), list((w.root / "run").iterdir())


# --------------------------------------------------------------------------------------------------------------- secret scans
def test_secret_scan_argv_output_logs_and_files(world):
    w = world
    r = run_mover(w)
    assert r.returncode == 0, combined(r)
    lpw = re.search(r"AGENT_CDMSS_PW=([0-9a-f]{48})", (w.root / "etc/studio-pgrelay/local.env").read_text()).group(1)
    argv = (w.d / "ssh.argv").read_bytes()
    assert PW.encode() not in argv and lpw.encode() not in argv and b"postgres" not in argv.replace(b"postgres", b"") + b""  # (see next line)
    assert b"postgresql://" not in argv and b"relay-url" not in argv
    for secret in (PW, lpw):
        assert secret not in combined(r)
        assert secret not in w.log.read_text()
    hits = {}
    for p, data in all_files_text(w):
        for name, secret in (("neon-pw", PW), ("local-pw", lpw)):
            if secret.encode() in data:
                hits.setdefault(name, []).append(str(p.relative_to(w.d)))
    hits = {k: sorted(v) for k, v in hits.items()}
    assert hits == {"neon-pw": ["asus/etc/studio-pgrelay/neon.env"],
                    "local-pw": ["asus/etc/studio-agent/env", "asus/etc/studio-pgrelay/local.env"]}, {k: sorted(v) for k, v in hits.items()}
    # the stdin tap really carried the url (the fake wire), and nothing else did
    taps = list(w.d.glob("ssh.stdin.*"))
    assert len(taps) == 1 and taps[0].read_text() == URL + "\n"


def test_no_url_shaped_text_reaches_the_terminal_even_if_the_asus_prints_one(world):
    w = world
    # a hostile/buggy Asus line: shown only with the "asus " prefix and never if it holds a url
    apply = w.d / "apply-evil.sh"
    apply.write_text("#!/bin/bash\necho 'asus oops postgresql://u:secret@h/db'\necho 'asus fine line'\nexit 0\n")
    r = run_mover(w, extra_env={"RELAY_INSTALL_APPLY": str(apply)})
    assert "secret@h" not in combined(r) and "asus fine line" in combined(r)


# ------------------------------------------------------------------------------------------------------- failure rollback
@pytest.mark.parametrize("mode,needle", [("writeok", "write-refused FAIL"), ("baseok", "base-table-refused FAIL"),
                                         ("wrongrole", "current_user FAIL"), ("connectfail", "connect FAIL")])
def test_failed_verification_rolls_back_to_the_exact_previous_bytes(world, mode, needle):
    w = world
    (w.d / "psycopg.mode").write_text(mode)
    before = snapshot(w)
    r = run_mover(w)
    assert r.returncode == 5, combined(r)
    assert needle in combined(r) and "asus verification FAILED" in combined(r) and "asus rolled back" in combined(r)
    assert snapshot(w) == before
    assert not (w.root / "etc/studio-agent/neon-hosts.extra").exists()
    # refreshed and restarted twice (apply, then undo), and the relay-url was NOT wiped
    assert (w.d / "refresh.log").read_text().count("refresh") == 2
    assert (w.d / "refresh.log").read_text().splitlines()[-1] == "refresh extra="
    assert (w.mount / "relay-url").exists() and not (w.d / "login.log").exists()
    assert PW not in combined(r)


def test_refresh_failure_rolls_back(world):
    w = world
    (w.d / "refresh.fail").write_text("1")
    before = snapshot(w)
    r = run_mover(w)
    assert r.returncode == 5 and "asus egress refresh failed" in combined(r)
    assert snapshot(w) == before and (w.mount / "relay-url").exists() and not (w.d / "login.log").exists()


def test_relay_restart_failure_rolls_back(world):
    w = world
    (w.d / "restart.fail").write_text("1")
    before = snapshot(w)
    r = run_mover(w)
    assert r.returncode in (5, 9), combined(r)
    assert snapshot(w) == before


def test_reinstall_over_a_previous_install_restores_the_previous_values_on_failure(world):
    w = world
    assert run_mover(w).returncode == 0
    first = snapshot(w)
    write(w.mount / "relay-url", URL.replace(PW, "SecondPw_Qq1w2e3r4t5y6u7i8o9p0aS") + "\n")
    (w.d / "psycopg.mode").write_text("writeok")
    r = run_mover(w)
    assert r.returncode == 5
    assert snapshot(w) == first      # the first install is back, byte for byte (same local pw reused, same url)


def test_ssh_unreachable_changes_nothing_and_keeps_the_ram_disk(world):
    w = world
    (w.d / "ssh.fail").write_text("1")
    before = snapshot(w)
    r = run_mover(w)
    assert r.returncode == 6, combined(r)
    assert snapshot(w) == before and (w.mount / "relay-url").exists() and not (w.d / "login.log").exists()


def test_ssh_link_dropping_midway_ends_in_the_previous_state(world):
    w = world
    (w.d / "ssh.drop").write_text("1")
    before = snapshot(w)
    r = run_mover(w)
    assert r.returncode == 6, combined(r)
    assert snapshot(w) == before
    assert (w.mount / "relay-url").exists() and not (w.d / "login.log").exists()


def test_preconditions_missing_support_changes_nothing(world):
    w = world
    write(w.root / "usr/local/sbin/studio-pgrelay-render", "#!/bin/bash\n# old render\n", 0o755)
    before = snapshot(w)
    r = run_mover(w)
    assert r.returncode == 5 and "predate CDMSS support" in combined(r) and "refused before changing anything" in combined(r)
    assert snapshot(w) == before and not (w.d / "refresh.log").exists() and (w.mount / "relay-url").exists()


def test_rollback_mode_removes_everything(world):
    w = world
    before = snapshot(w)
    assert run_mover(w).returncode == 0
    write(w.mount / "relay-url", URL + "\n")     # (the fake detach removed it)
    r = run_mover(w, "--rollback")
    assert r.returncode == 0 and "asus rollback done: no CDMSS url, password, env line or pinned host remains" in combined(r)
    assert snapshot(w) == before
    assert (w.d / "refresh.log").read_text().splitlines()[-1] == "refresh extra="
    taps = sorted(w.d.glob("ssh.stdin.*"))
    assert taps[-1].read_bytes() == b""          # rollback sends no url


def test_second_concurrent_run_is_refused(world):
    w = world
    import fcntl
    lockf = w.root / "run/lock/studio-cdmss-relay.lock"
    lockf.parent.mkdir(parents=True, exist_ok=True)
    fh = open(lockf, "w")
    fcntl.flock(fh, fcntl.LOCK_EX)
    try:
        before = snapshot(w)
        r = run_mover(w)
        assert r.returncode == 5 and "another relay-apply is running" in combined(r)
        assert snapshot(w) == before
    finally:
        fh.close()


# ------------------------------------------------------------------------------------------------------------------ refusals
@pytest.mark.parametrize("bad", [
    URL.replace("studio_cdmss_ro", "studio_gov_ro"),
    URL.replace(HOST, "ep-quiet-dust-a1b2c3d4-pooler.ap-southeast-1.aws.neon.tech"),
    URL.replace(f"@{HOST}", f"@{HOST}:6543"),
    URL.replace("sslmode=require", "options=-csearch_path%3Dx"),
    "mysql://studio_cdmss_ro:x@h.example.com/db",
    URL + "\n" + URL,
])
def test_bad_urls_are_refused_before_ssh(world, bad):
    w = world
    write(w.mount / "relay-url", bad + "\n")
    r = run_mover(w)
    assert r.returncode == 3, combined(r)
    assert not (w.d / "ssh.argv").exists()
    assert "refusing, nothing sent" in combined(r)


def test_bad_url_is_refused_by_the_asus_half_too(world):
    """Defence in depth: the Asus script validates on its own (the Mini check could be bypassed)."""
    w = world
    before = snapshot(w)
    for bad, why in ((URL.replace("studio_cdmss_ro", "x"), "user"), (URL.replace(HOST, "a-pooler.b.neon.tech"), "POOLED"), (URL.replace(f"@{HOST}", "@10.0.0.5"), "DNS name"),
                     (URL.replace("sslmode=require", "host=evil"), "query")):
        r = subprocess.run(["bash", str(APPLY), "install"], input=bad + "\n", capture_output=True, text=True,
                           env={**os.environ, "ASUS_RELAY_TEST": "1", "ASUS_ROOT": str(w.root), "PATH": f"{w.bin}:{os.environ['PATH']}"})
        assert r.returncode == 3 and why in r.stdout, (bad, r.stdout, r.stderr)
        assert PW not in r.stdout + r.stderr
    assert snapshot(w) == before


def test_wrong_mode_or_symlink_url_file_is_refused(world):
    w = world
    (w.mount / "relay-url").chmod(0o644)
    assert run_mover(w).returncode == 2
    (w.mount / "relay-url").chmod(0o600)
    real = w.d / "elsewhere"
    real.write_text(URL + "\n")
    real.chmod(0o600)
    (w.mount / "relay-url").unlink()
    (w.mount / "relay-url").symlink_to(real)
    r = run_mover(w)
    assert r.returncode == 2 and not (w.d / "ssh.argv").exists()


def test_test_only_overrides_and_redirecting_variables_are_refused_in_a_normal_run(world):
    w = world
    for var, val in (("RELAY_INSTALL_SSH", "/bin/true"), ("PGHOST", "evil"), ("SSH_ASKPASS", "/x"), ("LD_PRELOAD", "/x"), ("SHELLOPTS", "xtrace"), ("HTTPS_PROXY", "http://x")):
        env = {"PATH": os.environ["PATH"], "HOME": str(w.d), var: val}
        r = subprocess.run(["/bin/bash", "--noprofile", "--norc", str(MOVER)], env=env, capture_output=True, text=True, timeout=30)
        assert r.returncode == 2, (var, r.stdout, r.stderr)
        assert not (w.d / "ssh.argv").exists()


# ------------------------------------------------------------------------------------------------------ static hygiene
def test_mover_is_bash_3_2_clean_and_never_touches_the_url_by_argv_or_variable():
    s = MOVER.read_text()
    assert subprocess.run(["bash", "-n", str(MOVER)]).returncode == 0
    assert s.startswith("#!/bin/bash -p\n")
    for banned in (r"declare\s+-A", r"\bmapfile\b", r"\breadarray\b", r"\$\{[A-Za-z_]+,,\}", r"\$\{[A-Za-z_]+\^\^\}", r"&>>", r"\|&", r"\[\[\s+-v\s", r"local\s+-n", r"coproc", r"\$EPOCHSECONDS"):
        assert not re.search(banned, s), banned
    assert "set -x" not in s.replace("set +x", "")
    # the url file is only ever a redirected stdin or a stat/test/python argument (a path), never cat'ed, read into a variable or echoed
    for m in re.finditer(r"relay-url|RELAY_URL", s):
        line = s[s.rfind("\n", 0, m.start()) + 1:s.find("\n", m.end())]
        assert not re.search(r"\$\(\s*(cat|<)|read\s+-r|cat\s+\S*RELAY_URL|(echo|printf)\s+\S*\$\(", line), line
    assert "ssh" in s and '< "$1"' in s
    assert (os.stat(MOVER).st_mode & stat.S_IXUSR) and (os.stat(APPLY).st_mode & stat.S_IXUSR)


def test_prologue_matches_run_login_mini_where_it_must():
    a = MOVER.read_text()
    b = (OPS / "run-login-mini.sh").read_text()
    assert 'exec /usr/bin/env -i "${_args[@]}" /bin/bash --noprofile --norc -p "$0" "$@"' in a and 'exec /usr/bin/env -i "${_args[@]}" /bin/bash --noprofile --norc -p "$0" "$@"' in b
    assert "PATH=/opt/homebrew/opt/coreutils/libexec/gnubin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" in a
    for frag in ("exported bash functions are in the environment", "environment holds odd entries", "shell tracing/startup control"):
        assert frag in a


# ------------------------------------------------------------------------------------------------ relay render (cdmss alias)
def _render_py():
    src = (ASUS_OPS / "studio-pgrelay-render.sh").read_text()
    return re.search(r"python3 - <<'PY'\n(.*?)\nPY\n", src, re.S).group(1)


def _render(tmp_path, neon, local, pins):
    run = tmp_path / "run"
    run.mkdir()
    (tmp_path / "neon.env").write_text(neon)
    (tmp_path / "local.env").write_text(local)
    (tmp_path / "pins.json").write_text(json.dumps(pins))
    env = {**os.environ, "NEON_ENV": str(tmp_path / "neon.env"), "LOCAL_ENV": str(tmp_path / "local.env"), "PINS": str(tmp_path / "pins.json"),
           "RUN": str(run), "HOSTS": str(tmp_path / "relay-hosts"), "HOSTS_ONLY": "0", "SVC": __import__("pwd").getpwuid(os.getuid()).pw_name}
    r = subprocess.run([sys.executable, "-I", "-c", _render_py()], env=env, capture_output=True, text=True)
    ini = (run / "pgbouncer.ini").read_text() if (run / "pgbouncer.ini").exists() else ""
    users = (run / "userlist.txt").read_text() if (run / "userlist.txt").exists() else ""
    return r, ini, users


def test_relay_render_adds_a_read_only_cdmss_alias_only_when_configured_and_pinned(tmp_path):
    pins = {"gov.example.neon.tech": ["192.0.2.10"], HOST: ["192.0.2.20"]}
    neon = NEON_ENV0 + f"CDMSS_NEON_URL={URL}\n"
    local = LOCAL_ENV0 + "AGENT_CDMSS_PW=" + "c" * 48 + "\n"
    r, ini, users = _render(tmp_path / "a", neon, local, pins) if (tmp_path / "a").mkdir() is None else None
    assert r.returncode == 0, r.stderr
    line = [l for l in ini.splitlines() if l.startswith("cdmss = ")]
    assert len(line) == 1
    assert f"host={HOST} port=5432 dbname=neondb user=studio_cdmss_ro password='{PW}' pool_size=2" in line[0]
    assert "connect_query='SET default_transaction_read_only = on; SET statement_timeout = 30000'" in line[0]
    assert any(l.startswith("gov = ") for l in ini.splitlines()) and any(l.startswith("studio = ") for l in ini.splitlines())
    assert '"agent_cdmss" "' + "c" * 48 + '"' in users
    assert "server_tls_sslmode = verify-full" in ini
    # no CDMSS url: no alias, gov and studio unchanged
    (tmp_path / "b").mkdir()
    r, ini2, users2 = _render(tmp_path / "b", NEON_ENV0, LOCAL_ENV0, pins)
    assert r.returncode == 0 and "cdmss" not in ini2 and "cdmss" not in users2
    # CDMSS host not pinned: a warning, no alias, gov and studio still render (the relay must not fail for gov)
    (tmp_path / "c").mkdir()
    r, ini3, _ = _render(tmp_path / "c", neon, local, {"gov.example.neon.tech": ["192.0.2.10"]})
    assert r.returncode == 0 and "warning" in r.stderr and "cdmss =" not in ini3 and "gov = " in ini3
    assert PW not in r.stderr


# --------------------------------------------------------------------------------------------------------------- allowlist diff
def _installer_render(script: Path, outdir: Path):
    outdir.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(["bash", str(script), "--dry-run", "--render-dir", str(outdir), "--tarball", "/tmp/none.tar",
                        "--sha256", "0123456789abcdef" * 4, "--neon-host", "db.example.neon.tech", "--broker", "100.101.102.103:8765"],
                       capture_output=True, text=True, cwd=script.parent, env={**os.environ, "PATH": os.environ["PATH"]})
    return r


def test_squid_allowlist_and_proxy_config_are_byte_identical_to_the_base(tmp_path):
    base = subprocess.run(["git", "rev-parse", "--verify", "-q", "01babef^{commit}"], cwd=REPO, capture_output=True, text=True)
    if base.returncode != 0:
        pytest.skip("base commit 01babef not available")
    old = tmp_path / "old"
    old.mkdir()
    for f in ("install-studio-agent.sh", "studio-agent-egress-refresh.sh", "studio-pgrelay-render.sh", "studio-agent-egress-guard.sh", "studio-aws-creds.py", "studio-ech-prefilter.py"):
        (old / f).write_bytes(subprocess.run(["git", "show", f"01babef:ops/asus/{f}"], cwd=REPO, capture_output=True, check=True).stdout)
        (old / f).chmod(0o755)
    r_old = _installer_render(old / "install-studio-agent.sh", tmp_path / "r_old")
    r_new = _installer_render(ASUS_OPS / "install-studio-agent.sh", tmp_path / "r_new")
    assert r_old.returncode == 0 and r_new.returncode == 0, (r_old.stderr, r_new.stderr)
    for f in ("hosts.txt", "squid.conf", "sni-check.sh", "studio-proxy.service", "studio-prefilter.service"):
        assert (tmp_path / "r_old" / f).read_bytes() == (tmp_path / "r_new" / f).read_bytes(), f
    assert (tmp_path / "r_new" / "hosts.txt").read_text() == "bedrock-runtime.ap-south-1.amazonaws.com\napi.typesafe.ai\n"
    # the agent unit differs from the base by NOTHING (CDMSS adds no agent egress): same network lines
    assert (tmp_path / "r_old" / "studio-agent.service").read_bytes() == (tmp_path / "r_new" / "studio-agent.service").read_bytes()
    # and the only env change is the new empty name
    assert "CDMSS_RO_DATABASE_URL=" in subprocess.run(["bash", str(ASUS_OPS / "install-studio-agent.sh"), "--print-env-template"], capture_output=True, text=True).stdout.splitlines()


def _nft(hosts_ips):
    r = subprocess.run(["bash", str(ASUS_OPS / "studio-agent-egress-refresh.sh"), "--check", "--print-nft"], capture_output=True, text=True,
                       env={**os.environ, "NEON_HOSTS": "gov.example", "STUDIO_EGRESS_TEST_IPS": hosts_ips})
    assert r.returncode == 0, r.stderr
    return r.stdout.splitlines()


def test_nft_diff_for_the_cdmss_host_is_only_the_relay_uid_pinned_addresses_on_5432():
    import difflib
    gov = _nft("192.0.2.10 2001:db8::10")
    both = _nft("192.0.2.10 192.0.2.20 2001:db8::10 2001:db8::20")
    changed = [l for l in difflib.unified_diff(gov, both, lineterm="", n=0) if l[:1] in "+-" and l[:3] not in ("+++", "---")]
    assert len(changed) == 4, changed       # the v4 and the v6 relay-accept line, each removed and re-added
    for l in changed:
        assert re.fullmatch(r"[+-]\s+meta skuid 65001 ip6? daddr \{ [0-9a-f.:, ]+ \} tcp dport 5432 accept", l), l
    assert any("192.0.2.20" in l for l in changed if l.startswith("+")) and any("2001:db8::20" in l for l in changed if l.startswith("+"))
    # the agent uid's lines are identical: still only 127.0.0.1:8888/6432 and the broker
    assert [l for l in gov if "skuid 65000" in l] == [l for l in both if "skuid 65000" in l]
    assert not any("5432" in l for l in both if "skuid 65000" in l)
