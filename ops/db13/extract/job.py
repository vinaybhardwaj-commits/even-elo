"""Extract engine: DB13 (read-only transaction) -> governance Neon studio_dw. Logs counts and timings only,
never row data, never connection strings. Connections are injected so tests run on stand-in clusters."""
from __future__ import annotations

import datetime as dt
import json
import time
import uuid
from zoneinfo import ZoneInfo

from psycopg.types.json import Jsonb

from . import manifest, queries
from .spec import BY_NAME, TABLES, Table

IST = ZoneInfo("Asia/Kolkata")
QPS_MAX = 2.0
SRC_SETUP = (
    "BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ",
    "SET statement_timeout = '60s'",
    "SET idle_in_transaction_session_timeout = '30s'",
)


class ReadOnlyRefused(Exception):
    """The DB13 session is not read-only (or its timeouts are not set): nothing was queried."""


class QueryNotPinned(Exception):
    """A query text whose SHA-256 is not in manifest.json: refused before it reaches DB13."""


class Throttle:
    """At most `qps` source queries per second (default 2): sleeps so consecutive calls are >= 1/qps apart."""

    def __init__(self, qps=QPS_MAX, clock=time.monotonic, sleep=time.sleep):
        if qps > QPS_MAX:
            raise ValueError("qps above the 2 qps cap")
        self.gap, self.clock, self.sleep, self.last, self.calls = 1.0 / qps, clock, sleep, None, 0

    def wait(self):
        now = self.clock()
        if self.last is not None and now - self.last < self.gap:
            self.sleep(self.gap - (now - self.last))
            now = self.clock()
        self.last = now
        self.calls += 1


def in_offpeak_window(now: dt.datetime | None = None) -> bool:
    """22:00-07:00 IST."""
    h = (now or dt.datetime.now(IST)).astimezone(IST).hour
    return h >= 22 or h < 7


def begin_read_only(src):
    """Open the DB13 read-only transaction, then REFUSE unless the server says so. Source conn must be autocommit."""
    for stmt in SRC_SETUP:
        src.execute(stmt)
    ro = src.execute("SHOW transaction_read_only").fetchone()[0]
    if ro != "on":
        src.execute("ROLLBACK")
        raise ReadOnlyRefused("transaction_read_only is not on")
    if src.execute("SHOW statement_timeout").fetchone()[0] != "1min":
        src.execute("ROLLBACK")
        raise ReadOnlyRefused("statement_timeout is not 60s")


def _dump(t: Table, row):
    return [Jsonb(v) if c.type == "jsonb" and v is not None else v for c, v in zip(t.cols, row)]


class Extract:
    def __init__(self, src, dst, *, throttle=None, batch_size=2000, log=print, clock=time.monotonic, pinned=None):
        self.src, self.dst, self.throttle = src, dst, throttle or Throttle()
        self.pinned = manifest.load() if pinned is None else pinned
        self.batch, self.log, self.clock = batch_size, log, clock

    def q(self, sql, params=None):
        if queries.sha(sql) not in self.pinned:
            raise QueryNotPinned(queries.sha(sql)[:12])  # hash only, never the text
        self.throttle.wait()
        return self.src.execute(sql, params).fetchall()

    # -- one table ---------------------------------------------------------------------------------
    def _rows_mode(self, t: Table, run_id, since):
        last, total, batches = None, 0, 0
        cols = ", ".join(f'"{c}"' for c in t.colnames)
        upd = ", ".join(f'"{c}" = EXCLUDED."{c}"' for c in t.colnames if c != t.key)
        ins = (f'INSERT INTO studio_dw.{t.name} ({cols}, _run_id) VALUES ({", ".join(["%s"] * (len(t.cols) + 1))}) '
               f'ON CONFLICT ("{t.key}") DO UPDATE SET {upd}, _run_id = EXCLUDED._run_id')
        ki = t.colnames.index(t.key)
        while True:
            p = {"n": self.batch}
            if last is not None:
                p["last"] = last
            if since is not None and t.wm:
                p["since"], p["lb"] = since, t.lookback
            rows = self.q(queries.rows_sql(t, last is not None, since is not None and bool(t.wm)), p)
            if not rows:
                return total, batches
            with self.dst.transaction():
                self.dst.cursor().executemany(ins, [_dump(t, r) + [run_id] for r in rows])
            total, batches, last = total + len(rows), batches + 1, rows[-1][ki]

    def _children_mode(self, t: Table, run_id):
        g = t.group_key
        last, total, batches = None, 0, 0
        cols = ", ".join(f'"{c}"' for c in t.colnames)
        ins = f'INSERT INTO studio_dw.{t.name} ({cols}, _run_id) VALUES ({", ".join(["%s"] * (len(t.cols) + 1))})'
        gi = t.colnames.index(g)
        while True:
            p = {"n": self.batch}
            if last is not None:
                p["last"] = last
            ids = self.q(queries.ids_sql(t, last is not None), p)
            if not ids:
                return total, batches
            keys = [r[0] for r in ids]
            rows = self.q(queries.children_sql(t), {"keys": keys})
            with self.dst.transaction():
                self.dst.execute(f'DELETE FROM studio_dw.{t.name} WHERE "{g}" = ANY(%s)', [keys])
                self.dst.cursor().executemany(ins, [_dump(t, r) + [run_id] for r in rows])
            total, batches, last = total + len(rows), batches + 1, keys[-1]

    # -- the run -----------------------------------------------------------------------------------
    def previous_watermarks(self):
        r = self.dst.execute("SELECT watermarks FROM studio_dw.extract_runs WHERE status = 'ok' "
                             "ORDER BY started_at DESC LIMIT 1").fetchone()
        return (r[0] if r else None) or {}

    def run(self, *, mode="incremental", tables=None, run_id=None):
        assert mode in ("incremental", "full")
        specs = [BY_NAME[n] for n in tables] if tables else list(TABLES)
        run_id = run_id or str(uuid.uuid4())
        started = dt.datetime.now(dt.timezone.utc)
        begin_read_only(self.src)  # raises ReadOnlyRefused BEFORE any data query or any run row
        try:
            snap_now, snap = self.q(queries.SNAPSHOT_SQL)[0]
            prev = self.previous_watermarks() if mode == "incremental" else {}
            self.dst.execute("INSERT INTO studio_dw.extract_runs (run_id, mode, started_at, status, db13_snapshot_now, db13_snapshot) "
                             "VALUES (%s, %s, %s, 'running', %s, %s)", [run_id, mode, started, snap_now, snap])
            counts, wms = {}, {}
            try:
                for t in specs:
                    t0 = self.clock()
                    since = None
                    if mode == "incremental" and t.wm and prev.get(t.name, {}).get("to"):
                        since = dt.datetime.fromisoformat(prev[t.name]["to"])
                    if t.group_key:
                        n, b = self._children_mode(t, run_id)
                    else:
                        n, b = self._rows_mode(t, run_id, since)
                    if mode == "full":  # full refresh also drops rows that vanished at the source
                        self.dst.execute(f"DELETE FROM studio_dw.{t.name} WHERE _run_id <> %s", [run_id])
                    counts[t.name] = n
                    wms[t.name] = {"from": since.isoformat() if since else None, "to": snap_now.isoformat()}
                    self.log(f"table={t.name} rows={n} batches={b} seconds={self.clock() - t0:.1f}")
            except BaseException as exc:
                self._finish(run_id, "failed", counts, wms, type(exc).__name__)
                raise
            self._finish(run_id, "ok", counts, wms, None)
        finally:
            try:
                self.src.execute("ROLLBACK")
            except Exception:
                pass
        return run_id, counts

    def _finish(self, run_id, status, counts, wms, err):
        self.dst.execute("UPDATE studio_dw.extract_runs SET ended_at = now(), status = %s, rows = %s, watermarks = %s, "
                         "queries = %s, error_class = %s WHERE run_id = %s",
                         [status, Jsonb(counts), Jsonb(wms), self.throttle.calls, err, run_id])


def _pinned(sql):
    if queries.sha(sql) not in manifest.load():
        raise QueryNotPinned(queries.sha(sql)[:12])
    return sql


def verify_session(src, expect_user: str, log=print):
    """First-session checks (fable G-D5, VERIFY.md). Returns True only if every check passes; prints no values."""
    ok = True

    def check(name, good):
        nonlocal ok
        ok &= bool(good)
        log(f"{'PASS' if good else 'FAIL'} {name}")

    begin_read_only(src)  # includes SHOW transaction_read_only == on
    check("transaction_read_only on", src.execute("SHOW transaction_read_only").fetchone()[0] == "on")
    # informational: V's per-person role is not read-only by default; the job's own transaction is what protects DB13
    log(f"INFO default_transaction_read_only={src.execute('SHOW default_transaction_read_only').fetchone()[0]}")
    check("current_user is the configured role", src.execute("SELECT current_user").fetchone()[0] == expect_user)
    n = src.execute("SELECT count(*) FROM pg_stat_activity WHERE usename = current_user").fetchone()[0]
    check("pg_stat_activity count for current_user <= 3", 1 <= n <= 3)
    t = BY_NAME["doctors"]
    check("one SELECT count on one query (doctors)", src.execute(_pinned(queries.count_sql(t))).fetchone()[0] >= 0)
    try:
        src.execute("CREATE TABLE studio_dw_verify_must_fail (a int)")
        check("write attempt refused", False)
    except Exception as e:
        check("write attempt refused with the read-only error", "read-only transaction" in str(e) and "cannot execute" in str(e))
    try:
        src.execute("ROLLBACK")
    except Exception:
        pass
    return ok
