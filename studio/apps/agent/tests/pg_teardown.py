"""Teardown for every pgserver cluster the tests start. One per-run root (neon-emu-run-*) under the temp dir holds all
data dirs; each server is stopped and its dir removed after use, and whatever is left (failure, KeyboardInterrupt,
SIGTERM, xdist worker exit) is swept by pytest_sessionfinish, atexit and a SIGTERM handler. pgserver's own cleanup()
only stops postgres; it never deletes the data dir, which is what leaked."""

import atexit
import os
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from pathlib import Path

STALE_LIMIT = 20
STALE_AGE_S = 2 * 3600
CLEAN_CMD = "find {tmp} -maxdepth 1 -name 'neon-emu-*' -mmin +120 -exec rm -rf {{}} +"

_lock = threading.Lock()
_root = None
_servers = {}  # data dir -> pgserver handle


def temp_root() -> Path:
    return Path(tempfile.gettempdir())


def stale_dirs(now=None):
    now = now or time.time()
    out = []
    for p in temp_root().glob("neon-emu-*"):
        try:
            if p != _root and now - p.stat().st_mtime > STALE_AGE_S:
                out.append(p)
        except OSError:
            pass
    return out


def guard():
    """Refuse to start when earlier runs left too many dirs behind. Never deletes anything."""
    n = len(stale_dirs())
    if n > STALE_LIMIT:
        cmd = CLEAN_CMD.format(tmp=temp_root())
        raise RuntimeError(
            f"{n} stale neon-emu-* dirs older than 2 h in {temp_root()} (limit {STALE_LIMIT}). Earlier runs leaked pgserver "
            f"clusters. Check nobody else is using them, then clean up with:\n  {cmd}"
        )


def run_root() -> Path:
    global _root
    with _lock:
        if _root is None:
            _root = Path(tempfile.mkdtemp(prefix="neon-emu-run-"))
        return _root


def _pg_ctl_stop(pgdata):
    try:
        import pgserver

        ctl = Path(pgserver.__file__).parent / "pginstall" / "bin" / "pg_ctl"
        subprocess.run([str(ctl), "stop", "-D", str(pgdata), "-m", "immediate"], capture_output=True, timeout=30)
    except Exception:
        pass


def start_server(tag):
    """Start a pgserver cluster whose data dir lives under the per-run root. Pair with stop_server()."""
    import pgserver

    pgdata = Path(tempfile.mkdtemp(prefix=f"{tag}-", dir=run_root()))
    try:
        server = pgserver.get_server(pgdata)
    except BaseException:
        _pg_ctl_stop(pgdata)
        shutil.rmtree(pgdata, ignore_errors=True)
        raise
    with _lock:
        _servers[str(pgdata)] = server
    return server


def stop_server(server):
    with _lock:
        key = next((k for k, v in _servers.items() if v is server), None)
        _servers.pop(key, None)
    if key is None:
        return
    try:
        server.cleanup()
    except BaseException:
        pass
    _pg_ctl_stop(key)
    shutil.rmtree(key, ignore_errors=True)


def cleanup_all():
    global _root
    with _lock:
        servers = list(_servers.values())
    for s in servers:
        stop_server(s)
    with _lock:
        root, _root = _root, None
    if root is not None:
        for d in list(root.iterdir()) if root.exists() else []:
            _pg_ctl_stop(d)
        shutil.rmtree(root, ignore_errors=True)


def install_handlers():
    atexit.register(cleanup_all)
    if threading.current_thread() is not threading.main_thread():
        return
    prev = signal.getsignal(signal.SIGTERM)

    def on_term(signum, frame):
        cleanup_all()
        if callable(prev):
            prev(signum, frame)
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, on_term)
