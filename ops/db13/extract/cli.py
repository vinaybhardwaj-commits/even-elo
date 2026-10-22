"""CLI for the Mini. `scheduled` (launchd, off-peak only), `run` (on demand, same caps), `verify` (first session).
Reads ~/.config/hrag/ada.env at runtime (names ADA_HOST SSH_USER SSH_KEY PG_HOST PG_PORT PG_DB PG_USER PG_PASSWORD);
values are never printed or logged. Errors print the exception CLASS only."""
from __future__ import annotations

import argparse
import fcntl
import os
import shlex
import socket
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path

import psycopg

from .job import Extract, ReadOnlyRefused, Throttle, in_offpeak_window, verify_session

HOME = Path.home()
ADA_ENV = Path(os.environ.get("ADA_ENV_FILE", HOME / ".config/hrag/ada.env"))
DW_DSN_FILE = Path(os.environ.get("STUDIO_DW_DSN_FILE", HOME / ".config/studio-dw-extract/writer-url"))
STATE = HOME / ".config/studio-dw-extract"
KILL_FLAG = STATE / "DISABLED"
LOCK = STATE / "run.lock"
NEEDED = ("ADA_HOST", "SSH_USER", "SSH_KEY", "PG_HOST", "PG_PORT", "PG_DB", "PG_USER", "PG_PASSWORD")


def private_file(p: Path):
    if not p.is_file() or p.stat().st_mode & 0o077:
        raise SystemExit(f"refusing {p.name}: missing or not 0600")


def read_env(p: Path = ADA_ENV) -> dict:
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


@contextmanager
def tunnel(env: dict):
    """ONE ssh port-forward to ada. Command line holds hosts and key path, never a password."""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    p = subprocess.Popen(
        ["ssh", "-N", "-i", env["SSH_KEY"], "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
         "-o", "StrictHostKeyChecking=yes", "-o", "ServerAliveInterval=15",
         "-L", f"127.0.0.1:{port}:{env['PG_HOST']}:{env['PG_PORT']}", f"{env['SSH_USER']}@{env['ADA_HOST']}"],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            if p.poll() is not None:
                raise RuntimeError("tunnel exited")
            try:
                socket.create_connection(("127.0.0.1", port), 0.5).close()
                break
            except OSError:
                time.sleep(0.5)
        else:
            raise RuntimeError("tunnel timeout")
        yield port
    finally:
        p.terminate()
        try:
            p.wait(10)
        except subprocess.TimeoutExpired:
            p.kill()


def db13_conn(env, port):
    return psycopg.connect(host="127.0.0.1", port=port, dbname=env["PG_DB"], user=env["PG_USER"], password=env["PG_PASSWORD"],
                           sslmode="disable", connect_timeout=15, application_name="studio-dw-extract", autocommit=True)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="extract")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("scheduled", help="launchd entry: runs only inside 22:00-07:00 IST")
    r = sub.add_parser("run", help="on demand, any time, same caps")
    r.add_argument("--full", action="store_true", help="full refresh instead of incremental")
    r.add_argument("--tables", help="comma-separated subset")
    sub.add_parser("verify", help="first-session checks (VERIFY.md); no extract")
    a = ap.parse_args(argv)

    if KILL_FLAG.exists():
        print("disabled by flag file; exiting")
        return 3
    if a.cmd == "scheduled" and not in_offpeak_window():
        print("outside the off-peak window; exiting")
        return 0
    STATE.mkdir(parents=True, exist_ok=True)
    lock = open(LOCK, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("another run holds the lock; exiting")
        return 4
    try:
        env = read_env()
        with tunnel(env) as port, db13_conn(env, port) as src:
            if a.cmd == "verify":
                return 0 if verify_session(src, env["PG_USER"]) else 2
            private_file(DW_DSN_FILE)
            with psycopg.connect(DW_DSN_FILE.read_text().strip(), connect_timeout=15, autocommit=True) as dst:
                run_id, counts = Extract(src, dst, throttle=Throttle()).run(
                    mode="full" if getattr(a, "full", False) else "incremental",
                    tables=a.tables.split(",") if getattr(a, "tables", None) else None)
        print(f"run {run_id} ok: " + " ".join(f"{k}={v}" for k, v in counts.items()))
        return 0
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
