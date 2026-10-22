"""CLI for the Mini. `scheduled` (launchd, off-peak only), `run` (on demand, same caps), `verify` (first session).
Reads ~/.config/hrag/ada.env at runtime (names ADA_HOST SSH_USER SSH_KEY PG_HOST PG_PORT PG_DB PG_USER PG_PASSWORD);
values are never printed or logged. Errors print the exception CLASS only."""
from __future__ import annotations

import argparse
import fcntl
import os
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

import psycopg

from . import job
from .job import Extract, Killed, ReadOnlyRefused, Throttle, in_offpeak_window, sweep_spill, verify_session

HOME = Path.home()
ADA_ENV = Path(os.environ.get("ADA_ENV_FILE", HOME / ".config/hrag/ada.env"))
DW_DSN_FILE = Path(os.environ.get("STUDIO_DW_DSN_FILE", HOME / ".config/studio-dw-extract/writer-url"))
STATE = HOME / ".config/studio-dw-extract"
PEAK_FLAG = STATE / "ALLOW_PEAK"  # V creates this by hand; --i-know-its-peak needs it
KILL_FLAG = STATE / "DISABLED"
LOCK = STATE / "run.lock"
NEEDED = ("ADA_HOST", "SSH_USER", "SSH_KEY", "PG_HOST", "PG_PORT", "PG_DB", "PG_USER", "PG_PASSWORD")


def private_file(p: Path):
    if not p.is_file() or p.stat().st_mode & 0o077:
        raise SystemExit(f"refusing {p.name}: missing or not 0600")


def read_env(p: Path | None = None) -> dict:
    p = p or ADA_ENV
    private_file(p)
    out = {}
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.removeprefix("export ").split("=", 1)
        out[k.strip()] = shlex.split(v)[0] if v.strip() else ""
    missing = [k for k in NEEDED if not out.get(k)]
    if missing:
        raise SystemExit(f"ada.env is missing: {', '.join(missing)}")
    return out


TUNNEL_HOST = "gov-studio-ada"
APP_NAME = "gov-studio-extract"


class AgentLoadFailed(RuntimeError):
    """The private ssh-agent could not be started or the key could not be loaded into it (class only, no ssh-add output)."""


class TunnelExited(RuntimeError):
    """ssh exited before the forward came up (class only, no ssh stderr)."""


class TunnelTimeout(RuntimeError):
    """ssh stayed up but the forward never accepted connections."""


def passphrase_file() -> Path | None:
    """~/.config/hrag/ada.passphrase (override ADA_PASSPHRASE_FILE). None if absent (unencrypted key: old behaviour);
    refuses (SystemExit, name only) if present but not 0600."""
    p = Path(os.environ.get("ADA_PASSPHRASE_FILE") or HOME / ".config/hrag/ada.passphrase")
    if not p.exists():
        return None
    private_file(p)
    return p


def ssh_config(env: dict, port: int, agent_sock: str | None = None) -> str:
    """ssh -F config: host, user, key PATH, the agent socket and the one forward live here, not on argv. No password on this hop."""
    return "\n".join([
        f"Host {TUNNEL_HOST}", f"  HostName {env['ADA_HOST']}", f"  User {env['SSH_USER']}", f"  IdentityFile {env['SSH_KEY']}",
        *([f"  IdentityAgent {agent_sock}"] if agent_sock else []),
        "  IdentitiesOnly yes", "  BatchMode yes", "  ExitOnForwardFailure yes", "  StrictHostKeyChecking yes",
        "  ServerAliveInterval 15",
        f"  LocalForward 127.0.0.1:{port} {env['PG_HOST']}:{env['PG_PORT']}", ""])


def tunnel_argv(cfg: Path) -> list[str]:
    return ["ssh", "-N", "-F", str(cfg), TUNNEL_HOST]


def _clean_env() -> dict:
    """Never the user's agent: drop SSH_AUTH_SOCK / SSH_AGENT_PID from what ssh, ssh-add and ssh-agent inherit."""
    return {k: v for k, v in os.environ.items() if k not in ("SSH_AUTH_SOCK", "SSH_AGENT_PID")}


def start_agent(tmp: Path, key: str, pass_file: Path):
    """A PRIVATE ssh-agent whose socket lives in the 0700 per-run dir, with the key loaded through an askpass helper that
    cats the passphrase file itself: the passphrase is never in argv, in any environment value, in a log or in this process."""
    sock = tmp / "agent.sock"
    if len(str(sock)) > 100:  # AF_UNIX limit is 104 (macOS) / 108 (Linux) bytes
        raise AgentLoadFailed("agent socket path too long")
    out = subprocess.run(["ssh-agent", "-s", "-a", str(sock)], env=_clean_env(), stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=15)
    m = re.search(r"SSH_AGENT_PID=(\d+)", out.stdout)
    if out.returncode != 0 or not m:
        raise AgentLoadFailed("agent did not start")
    pid = int(m.group(1))
    try:
        helper = tmp / "askpass.sh"
        fd = os.open(helper, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o700)
        with os.fdopen(fd, "w") as f:
            f.write(f"#!/bin/sh\nexec cat -- {shlex.quote(str(pass_file))}\n")
        env = {**_clean_env(), "SSH_AUTH_SOCK": str(sock), "SSH_ASKPASS": str(helper), "SSH_ASKPASS_REQUIRE": "force", "DISPLAY": "gov-studio:0"}
        r = subprocess.run(["ssh-add", "-t", "3600", key], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=30)
        if r.returncode != 0:
            raise AgentLoadFailed("key not loaded")
    except BaseException:
        kill_agent(pid, sock)
        raise
    return sock, pid


def kill_agent(pid: int, sock):
    """`ssh-agent -k` (it reads SSH_AGENT_PID); falls back to a signal. The socket dies with the per-run dir."""
    try:
        subprocess.run(["ssh-agent", "-k"], env={**_clean_env(), "SSH_AGENT_PID": str(pid), "SSH_AUTH_SOCK": str(sock)},
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    except Exception:
        pass
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass


PROBE_ATTEMPTS = 10


@contextmanager
def tunnel(env: dict):
    """ONE ssh port-forward to ada, authenticated by a private per-run ssh-agent when ada.passphrase exists. Cleanup (ssh
    child ended, agent killed, 0600 config / askpass helper / socket removed) runs on every exit path, including
    SIGTERM/SIGHUP/SIGINT (they raise job.Killed). Failures are classes: AgentLoadFailed, TunnelExited, TunnelTimeout."""
    p = None
    agent = None
    tmp = tempfile.mkdtemp(prefix="gov-studio-ssh-")  # 0700; holds the ssh config, agent socket, askpass helper
    try:
        pass_file = passphrase_file()
        if pass_file is not None:
            agent = start_agent(Path(tmp), env["SSH_KEY"], pass_file)
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        cfg = Path(tmp) / "config"
        fd = os.open(cfg, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(ssh_config(env, port, str(agent[0]) if agent else None))
        p = subprocess.Popen(tunnel_argv(cfg), env=_clean_env(), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        delay = 0.25
        for _ in range(PROBE_ATTEMPTS):  # at most 10 raw connects, with backoff
            if p.poll() is not None:
                raise TunnelExited("tunnel exited")
            try:
                socket.create_connection(("127.0.0.1", port), 0.5).close()
                break
            except OSError:
                time.sleep(delay)
                delay = min(delay * 2, 4)
        else:
            raise TunnelTimeout("tunnel timeout")
        yield port
    finally:
        if p is not None:
            p.terminate()
            try:
                p.wait(10)
            except subprocess.TimeoutExpired:
                p.kill()
        if agent is not None:
            kill_agent(agent[1], agent[0])
        shutil.rmtree(tmp, ignore_errors=True)


def sweep_stale():
    """With the run lock held: remove what a SIGKILLed run leaves behind (spill files, ssh config dirs, an orphaned ssh)."""
    sweep_spill(job.SPILL_ROOT)
    try:
        ps = subprocess.run(["ps", "-eo", "pid=,args="], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        ps = ""
    for line in ps.splitlines():
        pid, _, args = line.strip().partition(" ")
        if not pid.isdigit() or int(pid) == os.getpid() or "/gov-studio-ssh-" not in args:
            continue
        head = [os.path.basename(x) for x in args.split()[:2]]
        # orphaned tunnel (ssh -N -F <dir>/config) or orphaned private agent (ssh-agent -a <dir>/agent.sock)
        if args.startswith("ssh -N -F ") or ("ssh-agent" in head and "-a" in args.split()):
            try:
                os.kill(int(pid), signal.SIGTERM)
            except OSError:
                pass
    for d in Path(tempfile.gettempdir()).glob("gov-studio-ssh-*"):  # after the kills: the sockets live in these dirs
        shutil.rmtree(d, ignore_errors=True)


def install_signal_handlers():
    """SIGTERM/SIGHUP/SIGINT -> job.Killed so every finally block runs (ssh config removed, ssh child ended, connection
    closed, run row marked killed). A second signal during cleanup is ignored."""
    def on_signal(signum, frame):
        for s in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            signal.signal(s, signal.SIG_IGN)
        raise Killed(signum)

    old = {s: signal.signal(s, on_signal) for s in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)}
    return lambda: [signal.signal(s, h) for s, h in old.items()]


def db13_kwargs(env, port):
    """Connection arguments, in-process only: the password goes to libpq here and nowhere else."""
    return dict(host="127.0.0.1", port=port, dbname=env["PG_DB"], user=env["PG_USER"], password=env["PG_PASSWORD"],
                sslmode="disable", connect_timeout=15, application_name=APP_NAME, autocommit=True)


def db13_conn(env, port):
    return psycopg.connect(**db13_kwargs(env, port))


def main(argv=None):
    restore = []
    try:
        return _main(argv, restore)
    finally:
        for r in restore:
            r()


def _main(argv, restore):
    ap = argparse.ArgumentParser(prog="extract")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("scheduled", help="launchd entry: runs only inside 22:00-07:00 IST")
    r = sub.add_parser("run", help="on demand, any time, same caps")
    r.add_argument("--full", action="store_true", help="full refresh instead of incremental")
    r.add_argument("--tables", help="comma-separated subset")
    r.add_argument("--i-know-its-peak", action="store_true", help="also read the large tables outside 22:00-07:00 IST; needs V's ALLOW_PEAK flag file")
    sub.add_parser("verify", help="first-session checks (VERIFY.md); no extract")
    a = ap.parse_args(argv)

    STATE.mkdir(parents=True, exist_ok=True)
    lock = open(LOCK, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("another run holds the lock; exiting")
        return 4
    sweep_stale()  # BEFORE the kill-flag check: plaintext PHI from a SIGKILLed run must not outlive a disabled job
    if KILL_FLAG.exists():
        print("disabled by flag file; exiting")
        return 3
    if a.cmd == "scheduled" and not in_offpeak_window():
        print("outside the off-peak window; exiting")
        return 0
    if getattr(a, "i_know_its_peak", False) and not PEAK_FLAG.exists():
        print("refused: --i-know-its-peak needs V's flag file")
        return 6
    restore.append(install_signal_handlers())
    try:
        env = read_env()
        with tunnel(env) as port, db13_conn(env, port) as src:
            if a.cmd == "verify":
                return 0 if verify_session(src, env["PG_USER"]) else 2
            private_file(DW_DSN_FILE)
            with psycopg.connect(DW_DSN_FILE.read_text().strip(), connect_timeout=15, autocommit=True) as dst:
                run_id, counts = Extract(src, dst, throttle=Throttle()).run(
                    mode="full" if getattr(a, "full", False) else "incremental",
                    tables=a.tables.split(",") if getattr(a, "tables", None) else None,
                    allow_peak=getattr(a, "i_know_its_peak", False))
        print(f"run {run_id} done: " + " ".join(f"{k}={v}" for k, v in counts.items()))
        return 0
    except Killed as k:
        print("KILLED")
        return 128 + k.args[0]
    except ReadOnlyRefused:
        print("REFUSED: DB13 session is not read-only")
        return 2
    except SystemExit:
        raise
    except BaseException as e:  # class only: messages can carry hosts or data
        print(f"FAILED: {type(e).__name__}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
