"""Private per-run ssh-agent for the passphrase-protected ada key. No network: fake ssh-agent / ssh-add / ssh on PATH.
Proves the passphrase never reaches argv, environment values or logs; the agent, socket, helper and config are gone after
success, failure and each signal; the sweep kills orphans; a loose passphrase file is refused."""
from __future__ import annotations

import hashlib
import json
import os
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path

import pytest

DB13 = Path(__file__).resolve().parents[4] / "ops" / "db13"
sys.path.insert(0, str(DB13))
from extract import cli  # noqa: E402

PASS = "PASSPHRASE-STANDIN-7f2c91"
ENV = {"ADA_HOST": "ada.invalid", "SSH_USER": "u1", "SSH_KEY": "/k/id_ada", "PG_HOST": "10.0.0.5", "PG_PORT": "5433", "PG_DB": "postgres",
       "PG_USER": "ro_user", "PG_PASSWORD": "STANDIN-pw-9f3a"}

FAKE_AGENT = """#!{py}
import json, os, signal, socket, sys, time
log = os.environ.get("FAKE_LOG")
def note(**kw):
    if log:
        open(log, "a").write(json.dumps({{**kw, "argv": sys.argv, "env": dict(os.environ)}}) + "\\n")
if sys.argv[1:2] == ["-k"]:
    note(tool="agent-k")
    pid = int(os.environ["SSH_AGENT_PID"])
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass
    print("unset SSH_AUTH_SOCK;"); sys.exit(0)
sock = sys.argv[sys.argv.index("-a") + 1]
note(tool="agent-start")
if os.environ.get("FAKE_AGENT_FAIL"):
    sys.exit(1)
s = socket.socket(socket.AF_UNIX); s.bind(sock); s.listen(1)  # bound before the fork, like the real agent
pid = os.fork()
if pid:
    print(f"SSH_AUTH_SOCK={{sock}}; export SSH_AUTH_SOCK;\\nSSH_AGENT_PID={{pid}}; export SSH_AGENT_PID;\\necho Agent pid {{pid}};")
    sys.exit(0)
os.setsid()
dn = os.open(os.devnull, os.O_RDWR); os.dup2(dn, 1); os.dup2(dn, 2)  # sys.stdout.close() keeps fd 1 open
def bye(*_):
    try: os.unlink(sock)
    except OSError: pass
    os._exit(0)
signal.signal(signal.SIGTERM, bye)
while True:
    time.sleep(1)
"""

FAKE_ADD = """#!{py}
import hashlib, json, os, subprocess, sys
log = os.environ.get("FAKE_LOG")
helper = os.environ.get("SSH_ASKPASS", "")
got = subprocess.run([helper, "Enter passphrase"], capture_output=True, text=True, stdin=subprocess.DEVNULL).stdout.strip() if helper else ""
ok = hashlib.sha256(got.encode()).hexdigest() == os.environ.get("FAKE_EXPECT_SHA", "") and not os.environ.get("FAKE_ADD_FAIL")
if log:
    open(log, "a").write(json.dumps({{"tool": "add", "argv": sys.argv, "env": dict(os.environ), "ok": ok, "sock_exists": os.path.exists(os.environ.get("SSH_AUTH_SOCK", "")),
                                    "helper_mode": oct(os.stat(helper).st_mode & 0o777) if helper else None}}) + "\\n")
sys.exit(0 if ok else 1)
"""

FAKE_SSH = """#!{py}
import json, os, socket, sys, time
log = os.environ.get("FAKE_LOG")
cfg = sys.argv[sys.argv.index("-F") + 1]
text = open(cfg).read()
sock_line = [l for l in text.splitlines() if "IdentityAgent" in l]
if log:
    open(log, "a").write(json.dumps({{"tool": "ssh", "argv": sys.argv, "env": dict(os.environ), "cfg": text,
                                    "agent_sock_exists": bool(sock_line) and os.path.exists(sock_line[0].split()[1])}}) + "\\n")
open(os.environ["FAKE_SSH_PID"], "w").write(str(os.getpid()))
if os.environ.get("FAKE_SSH_EXIT"):
    sys.exit(255)
if os.environ.get("FAKE_SSH_NOLISTEN"):
    time.sleep(300)
port = int([l for l in text.splitlines() if "LocalForward" in l][0].split()[1].split(":")[1])
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("127.0.0.1", port)); s.listen(5)
conns = []
while True:
    conns.append(s.accept()[0])
"""


@pytest.fixture()
def world(tmp_path, monkeypatch):
    import shutil
    import tempfile

    bindir = tmp_path / "bin"
    bindir.mkdir()
    tmpdir = Path(tempfile.mkdtemp(prefix="ga-"))  # SHORT path: AF_UNIX sockets are limited to ~104 bytes
    monkeypatch.setattr(cli.tempfile, "tempdir", None)
    for name, src in (("ssh-agent", FAKE_AGENT), ("ssh-add", FAKE_ADD), ("ssh", FAKE_SSH)):
        f = bindir / name
        f.write_text(src.format(py=sys.executable))
        f.chmod(0o755)
    pf = tmp_path / "ada.passphrase"
    pf.write_text(PASS + "\n")
    pf.chmod(0o600)
    log, pidf = tmp_path / "fake.log", tmp_path / "ssh.pid"
    env = {"PATH": f"{bindir}:{os.environ['PATH']}", "TMPDIR": str(tmpdir), "ADA_PASSPHRASE_FILE": str(pf), "FAKE_LOG": str(log),
           "FAKE_SSH_PID": str(pidf), "FAKE_EXPECT_SHA": hashlib.sha256(PASS.encode()).hexdigest(),
           "SSH_AUTH_SOCK": "/the/users/own/agent.sock", "SSH_AGENT_PID": "1"}  # the user's agent: must never be used
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setattr(cli.tempfile, "tempdir", str(tmpdir))
    monkeypatch.setattr(cli.tempfile, "tempdir", str(tmpdir))
    yield type("W", (), dict(tmp=tmp_path, tmpdir=tmpdir, pf=pf, log=log, pidf=pidf, env=env, bindir=bindir,
                              records=lambda self: [json.loads(l) for l in log.read_text().splitlines()] if log.exists() else []))()
    shutil.rmtree(tmpdir, ignore_errors=True)


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    try:  # a zombie child of this process counts as dead
        return Path(f"/proc/{pid}/stat").read_text().split(")")[1].split()[0] != "Z"
    except OSError:
        return True


def wait_dead(pid, secs=5):
    for _ in range(int(secs * 20)):
        if not alive(pid):
            return True
        time.sleep(0.05)
    return False


def agent_pid(w):
    # the daemon child's pid is the one the fake printed; recover it from the -k call's env or the pid in ps
    ks = [r for r in w.records() if r["tool"] == "agent-k"]
    return int(ks[0]["env"]["SSH_AGENT_PID"]) if ks else None


def assert_no_secret(w, *extra):
    blob = w.log.read_text() if w.log.exists() else ""
    for secret in (PASS, *extra):
        assert secret not in blob, "secret reached an argv/env/log"


def test_success_path_uses_a_private_agent_and_cleans_up_everything(world):
    with cli.tunnel(ENV) as port:
        recs = world.records()
        by = {r["tool"]: r for r in recs}
        assert port > 0 and {"agent-start", "add", "ssh"} <= set(by)
        assert by["add"]["ok"] and by["add"]["sock_exists"] and by["add"]["helper_mode"] == "0o700"
        assert by["add"]["argv"][1:3] == ["-t", "3600"] and by["add"]["argv"][-1] == ENV["SSH_KEY"]
        assert by["add"]["env"]["SSH_ASKPASS_REQUIRE"] == "force" and by["add"]["env"]["DISPLAY"]
        cfgs = list(world.tmpdir.glob("gov-studio-ssh-*"))
        assert len(cfgs) == 1 and oct(cfgs[0].stat().st_mode & 0o777) == "0o700"
        sock = cfgs[0] / "agent.sock"
        assert by["agent-start"]["argv"][-2:] == ["-a", str(sock)]  # the socket lives in the 0700 per-run dir
        assert f"IdentityAgent {sock}" in by["ssh"]["cfg"] and "IdentitiesOnly yes" in by["ssh"]["cfg"] and "BatchMode yes" in by["ssh"]["cfg"] \
            and "StrictHostKeyChecking yes" in by["ssh"]["cfg"] and by["ssh"]["agent_sock_exists"]
        # never the user's agent
        for r in recs:
            assert r["env"].get("SSH_AUTH_SOCK") in (None, str(sock)) and "/the/users/own" not in json.dumps(r["env"]) or r["tool"] == "agent-k"
        ssh_pid = int(world.pidf.read_text())
    assert_no_secret(world, ENV["PG_PASSWORD"])
    assert any(r["tool"] == "agent-k" for r in world.records())  # ssh-agent -k
    assert not list(world.tmpdir.glob("gov-studio-ssh-*"))  # socket, helper, config gone
    assert wait_dead(ssh_pid) and wait_dead(agent_pid(world))


def test_passphrase_is_never_in_argv_or_environment_values(world):
    with cli.tunnel(ENV):
        pass
    assert_no_secret(world)
    for r in world.records():
        assert PASS not in " ".join(r["argv"]) and PASS not in json.dumps(r["env"]), r["tool"]
        assert str(world.pf) not in " ".join(r["argv"])  # only the helper script knows the file path
    helper_env = [r for r in world.records() if r["tool"] == "add"][0]["env"]
    assert helper_env["SSH_ASKPASS"].endswith("askpass.sh") and PASS not in helper_env["SSH_ASKPASS"]


def test_agent_load_failure_is_its_own_class_and_cleans_up(world, monkeypatch):
    monkeypatch.setenv("FAKE_ADD_FAIL", "1")
    with pytest.raises(cli.AgentLoadFailed) as e:
        with cli.tunnel(ENV):
            pytest.fail("tunnel must not come up")
    assert PASS not in str(e.value) and not isinstance(e.value, (cli.TunnelExited, cli.TunnelTimeout))
    assert not [r for r in world.records() if r["tool"] == "ssh"]  # ssh never started
    assert not list(world.tmpdir.glob("gov-studio-ssh-*")) and wait_dead(agent_pid(world))
    assert_no_secret(world)


def test_agent_start_failure_is_agent_load_failed(world, monkeypatch):
    monkeypatch.setenv("FAKE_AGENT_FAIL", "1")
    with pytest.raises(cli.AgentLoadFailed):
        with cli.tunnel(ENV):
            pass
    assert not list(world.tmpdir.glob("gov-studio-ssh-*"))


def test_tunnel_exited_and_tunnel_timeout_are_distinct_classes_and_clean_up(world, monkeypatch):
    monkeypatch.setenv("FAKE_SSH_EXIT", "1")
    with pytest.raises(cli.TunnelExited):
        with cli.tunnel(ENV):
            pass
    assert not list(world.tmpdir.glob("gov-studio-ssh-*")) and wait_dead(agent_pid(world))
    monkeypatch.delenv("FAKE_SSH_EXIT")
    monkeypatch.setenv("FAKE_SSH_NOLISTEN", "1")
    monkeypatch.setattr(cli.time, "sleep", lambda s: None)  # nothing is listening: skip the backoff waits
    with pytest.raises(cli.TunnelTimeout):
        with cli.tunnel(ENV):
            pass
    assert not list(world.tmpdir.glob("gov-studio-ssh-*"))
    assert issubclass(cli.TunnelExited, RuntimeError) and issubclass(cli.TunnelTimeout, RuntimeError)
    assert cli.TunnelExited is not cli.TunnelTimeout and cli.AgentLoadFailed not in (cli.TunnelExited, cli.TunnelTimeout)
    assert_no_secret(world)


def test_error_in_the_body_still_kills_the_agent(world):
    with pytest.raises(ValueError):
        with cli.tunnel(ENV):
            raise ValueError("job failed")
    assert not list(world.tmpdir.glob("gov-studio-ssh-*")) and wait_dead(agent_pid(world))


def test_loose_passphrase_file_is_refused_before_anything_starts(world):
    world.pf.chmod(0o644)
    with pytest.raises(SystemExit) as e:
        with cli.tunnel(ENV):
            pass
    assert "ada.passphrase" in str(e.value) and PASS not in str(e.value)
    assert not world.records() and not list(world.tmpdir.glob("gov-studio-ssh-*"))


def test_missing_passphrase_file_falls_back_to_the_plain_key(world):
    world.pf.unlink()
    with cli.tunnel(ENV):
        tools = [r["tool"] for r in world.records()]
        cfg = [r for r in world.records() if r["tool"] == "ssh"][0]["cfg"]
    assert tools == ["ssh"] and "IdentityAgent" not in cfg and f"IdentityFile {ENV['SSH_KEY']}" in cfg  # no agent, old behaviour
    # and if ssh then fails, the class says which step
    os.environ["FAKE_SSH_EXIT"] = "1"
    try:
        with pytest.raises(cli.TunnelExited):
            with cli.tunnel(ENV):
                pass
    finally:
        del os.environ["FAKE_SSH_EXIT"]


def test_passphrase_path_comes_from_config_default_and_override(monkeypatch, tmp_path):
    monkeypatch.delenv("ADA_PASSPHRASE_FILE", raising=False)
    monkeypatch.setattr(cli, "HOME", tmp_path)
    assert cli.passphrase_file() is None
    d = tmp_path / ".config" / "hrag"
    d.mkdir(parents=True)
    f = d / "ada.passphrase"
    f.write_text("x\n")
    f.chmod(0o600)
    assert cli.passphrase_file() == f
    g = tmp_path / "other"
    g.write_text("y\n")
    g.chmod(0o600)
    monkeypatch.setenv("ADA_PASSPHRASE_FILE", str(g))
    assert cli.passphrase_file() == g


def test_sweep_kills_an_orphaned_agent_and_removes_its_dir(world):
    orphan_dir = world.tmpdir / "gov-studio-ssh-orphan"
    orphan_dir.mkdir(mode=0o700)
    out = subprocess.run(["ssh-agent", "-a", str(orphan_dir / "agent.sock")], capture_output=True, text=True, env={**os.environ})
    pid = int(out.stdout.split("SSH_AGENT_PID=")[1].split(";")[0])
    for _ in range(50):
        if (orphan_dir / "agent.sock").exists():
            break
        time.sleep(0.05)
    assert alive(pid)
    bystander = subprocess.Popen(["sleep", "30"])  # an unrelated process must survive
    try:
        cli.sweep_stale()
        assert wait_dead(pid) and not orphan_dir.exists()
        assert bystander.poll() is None
    finally:
        bystander.kill()


DRIVER = """
import sys
sys.path.insert(0, {db13!r})
from extract import cli
cli.install_signal_handlers()
env = {env!r}
try:
    with cli.tunnel(env) as port:
        open({ready!r}, "w").write("up")
        import time
        time.sleep(120)
except cli.Killed as k:
    sys.exit(128 + k.args[0])
"""


@pytest.mark.parametrize("sig", ["SIGTERM", "SIGHUP", "SIGINT"])
def test_each_signal_kills_the_agent_and_removes_every_file(world, sig):
    sg = getattr(signal, sig)
    ready = world.tmp / "ready"
    script = world.tmp / "driver.py"
    script.write_text(DRIVER.format(db13=str(DB13), env=ENV, ready=str(ready)))
    p = subprocess.Popen([sys.executable, str(script)], env={**os.environ}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        for _ in range(150):
            if ready.exists():
                break
            time.sleep(0.1)
        else:
            pytest.fail("tunnel never came up: " + (p.stdout.read() if p.poll() is not None else ""))
        ssh_pid = int(world.pidf.read_text())
        dirs = list(world.tmpdir.glob("gov-studio-ssh-*"))
        assert len(dirs) == 1 and (dirs[0] / "agent.sock").exists() and (dirs[0] / "askpass.sh").exists()
        p.send_signal(sg)
        out, _ = p.communicate(timeout=30)
    finally:
        if p.poll() is None:
            p.kill()
    assert p.returncode == 128 + sg, out
    assert not list(world.tmpdir.glob("gov-studio-ssh-*"))
    assert wait_dead(ssh_pid) and wait_dead(agent_pid(world))
    assert_no_secret(world)
    assert PASS not in out and ENV["PG_PASSWORD"] not in out


def test_over_long_socket_path_is_a_clear_class_not_a_hang(world, monkeypatch):
    long_tmp = world.tmp / ("x" * 90)
    long_tmp.mkdir()
    monkeypatch.setattr(cli.tempfile, "tempdir", str(long_tmp))
    with pytest.raises(cli.AgentLoadFailed, match="too long"):
        with cli.tunnel(ENV):
            pass
    assert not list(long_tmp.glob("gov-studio-ssh-*"))
