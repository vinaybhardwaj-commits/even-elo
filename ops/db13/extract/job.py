"""Extract engine: DB13 (one READ ONLY transaction per table) -> governance Neon studio_dw. Logs counts and timings
only, never row data, never connection strings. Every statement sent to DB13 goes through Session: pin check
(SHA-256 in manifest.json) and the <= 2/s throttle. Connections are injected so tests run on stand-in clusters."""
from __future__ import annotations

import datetime as dt
import time
import uuid
from zoneinfo import ZoneInfo

from psycopg.types.json import Jsonb

from . import manifest, queries
from .spec import BY_NAME, TABLES, Table

IST = ZoneInfo("Asia/Kolkata")
QPS_MAX = 2.0
MAX_TXN_SECONDS = 15 * 60


class ReadOnlyRefused(Exception):
    """The DB13 session is not read-only (or its timeouts are not set): nothing was queried."""


class QueryNotPinned(Exception):
    """A query text whose SHA-256 is not in manifest.json: refused before it reaches DB13."""


class TableTimeout(Exception):
    """One table's DB13 transaction ran past MAX_TXN_SECONDS: that table is aborted, the others continue."""


class Killed(BaseException):
    """SIGTERM / SIGHUP / SIGINT: unwind (finally blocks run), record status=killed."""


class Throttle:
    """At most `qps` source statements per second (default 2): sleeps so consecutive calls are >= 1/qps apart."""

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


class Session:
    """The only door to DB13: pin check + throttle on every statement."""

    def __init__(self, conn, pinned=None, throttle=None):
        self.conn = conn
        self.pinned = manifest.load() if pinned is None else pinned
        self.throttle = throttle or Throttle()

    def check(self, sql):
        h = queries.sha(sql)
        if h not in self.pinned:
            raise QueryNotPinned(h[:12])  # hash only, never the text
        return sql

    def run(self, sql, params=None):
        self.check(sql)
        self.throttle.wait()
        return self.conn.execute(sql, params)


def in_offpeak_window(now: dt.datetime | None = None) -> bool:
    """22:00-07:00 IST."""
    h = (now or dt.datetime.now(IST)).astimezone(IST).hour
    return h >= 22 or h < 7


def begin_read_only(s: Session):
    """Open the DB13 read-only transaction, then REFUSE unless the server says so."""
    s.run(queries.BEGIN_SQL)
    s.run(queries.SET_TIMEOUT_SQL)
    s.run(queries.SET_IDLE_SQL)
    ok = s.run(queries.SHOW_RO_SQL).fetchone()[0] == "on" and s.run(queries.SHOW_TIMEOUT_SQL).fetchone()[0] == "1min"
    if not ok:
        end_txn(s, False)
        raise ReadOnlyRefused("session is not read-only or timeouts are not set")


def end_txn(s: Session, commit: bool):
    try:
        s.run(queries.COMMIT_SQL if commit else queries.ROLLBACK_SQL)
    except Exception:
        pass


def _dump(t: Table, row):
    return [Jsonb(v) if c.type == "jsonb" and v is not None else v for c, v in zip(t.cols, row)]


class Extract:
    def __init__(self, src, dst, *, throttle=None, batch_size=2000, log=print, clock=time.monotonic, pinned=None,
                 max_txn_seconds=MAX_TXN_SECONDS):
        self.throttle = throttle or Throttle()
        self.s = src if isinstance(src, Session) else Session(src, pinned, self.throttle)
        self.throttle = self.s.throttle
        self.dst, self.batch, self.log, self.clock, self.max_txn = dst, batch_size, log, clock, max_txn_seconds

    # -- provenance --------------------------------------------------------------------------------
    def previous_watermarks(self):
        rows = self.dst.execute("SELECT DISTINCT ON (table_name) table_name, watermark_to FROM studio_dw.extract_run_tables "
                                "WHERE status = 'ok' ORDER BY table_name, started_at DESC").fetchall()
        return {n: w for n, w in rows if w is not None}

    def _tbl(self, run_id, name, **cols):
        sets = ", ".join(f"{k} = %s" for k in cols)
        self.dst.execute(f"UPDATE studio_dw.extract_run_tables SET {sets} WHERE run_id = %s AND table_name = %s", [*cols.values(), run_id, name])

    # -- one table ---------------------------------------------------------------------------------
    def _table(self, t: Table, run_id, mode, since):
        t0 = self.clock()
        begin_read_only(self.s)
        committed = False
        try:
            snap_now, snap = self.s.run(queries.SNAPSHOT_SQL).fetchone()
            self.dst.execute("INSERT INTO studio_dw.extract_run_tables (run_id, table_name, status, started_at, db13_snapshot_now, db13_snapshot, "
                             "watermark_from, watermark_to) VALUES (%s, %s, 'running', now(), %s, %s, %s, %s)",
                             [run_id, t.name, snap_now, snap, since, snap_now])
            sql = self.s.check(queries.cursor_sql(t, since is not None))
            params = {"since": since, "lb": t.lookback} if since is not None else None
            cols = ", ".join(f'"{c}"' for c in t.colnames)
            marks = ", ".join(["%s"] * (len(t.cols) + 1))
            if t.key:
                upd = ", ".join(f'"{c}" = EXCLUDED."{c}"' for c in t.colnames if c != t.key)
                ins = (f'INSERT INTO studio_dw.{t.name} ({cols}, _run_id) VALUES ({marks}) '
                       f'ON CONFLICT ("{t.key}") DO UPDATE SET {upd}, _run_id = EXCLUDED._run_id')
            else:
                ins = f"INSERT INTO studio_dw.{t.name} ({cols}, _run_id) VALUES ({marks})"
            cur = self.s.conn.cursor(name="gse_" + t.name[:40])
            self.throttle.wait()
            cur.execute(sql, params)
            n = fetches = 0
            while True:
                self.throttle.wait()  # every FETCH counts against the 2/s cap
                rows = cur.fetchmany(self.batch)
                fetches += 1
                if not rows:
                    break
                with self.dst.transaction():
                    self.dst.cursor().executemany(ins, [_dump(t, r) + [run_id] for r in rows])
                n += len(rows)
                if self.clock() - t0 > self.max_txn:
                    raise TableTimeout()
            cur.close()
            end_txn(self.s, True)
            committed = True
            if t.group_key:  # child table: the view shows the newest ok run; drop older runs after this one is marked ok
                self._tbl(run_id, t.name, status="ok", ended_at=dt.datetime.now(dt.timezone.utc), rows_read=n, fetches=fetches, txn_seconds=self.clock() - t0)
                self.dst.execute(f"DELETE FROM studio_dw.{t.name} WHERE _run_id <> %s", [run_id])
            else:
                if mode == "full":  # full refresh also drops rows that vanished at the source
                    self.dst.execute(f"DELETE FROM studio_dw.{t.name} WHERE _run_id <> %s", [run_id])
                self._tbl(run_id, t.name, status="ok", ended_at=dt.datetime.now(dt.timezone.utc), rows_read=n, fetches=fetches, txn_seconds=self.clock() - t0)
            self.log(f"table={t.name} rows={n} fetches={fetches} seconds={self.clock() - t0:.1f}")
            return n, snap_now
        finally:
            if not committed:
                end_txn(self.s, False)

    # -- the run -----------------------------------------------------------------------------------
    def run(self, *, mode="incremental", tables=None, run_id=None, allow_peak=False, now=None):
        assert mode in ("incremental", "full")
        specs = [BY_NAME[n] for n in tables] if tables else list(TABLES)
        run_id = run_id or str(uuid.uuid4())
        offpeak = allow_peak or in_offpeak_window(now)
        self.dst.execute("INSERT INTO studio_dw.extract_runs (run_id, mode, started_at, status) VALUES (%s, %s, now(), 'running')", [run_id, mode])
        prev = self.previous_watermarks() if mode == "incremental" else {}
        counts, snaps, partial = {}, [], False
        try:
            for t in specs:
                if t.large and not offpeak:
                    self.dst.execute("INSERT INTO studio_dw.extract_run_tables (run_id, table_name, status, started_at, ended_at) "
                                     "VALUES (%s, %s, 'skipped', now(), now())", [run_id, t.name])
                    self.log(f"table={t.name} skipped (large table, outside 22:00-07:00 IST)")
                    partial = True
                    continue
                since = prev.get(t.name) if (t.wm and mode == "incremental") else None
                try:
                    counts[t.name], sn = self._table(t, run_id, mode, since)
                    snaps.append(sn)
                except TableTimeout:
                    self._tbl(run_id, t.name, status="timeout", ended_at=dt.datetime.now(dt.timezone.utc))
                    self.log(f"table={t.name} TIMEOUT after {self.max_txn:.0f}s; aborted, others continue")
                    partial = True
                except Killed:
                    self._tbl(run_id, t.name, status="killed", ended_at=dt.datetime.now(dt.timezone.utc))
                    raise
                except BaseException as exc:
                    self._tbl(run_id, t.name, status="failed", ended_at=dt.datetime.now(dt.timezone.utc), error_class=type(exc).__name__)
                    raise
        except Killed:
            self._finish(run_id, "killed", counts, snaps, "Killed")
            raise
        except BaseException as exc:
            self._finish(run_id, "failed", counts, snaps, type(exc).__name__)
            raise
        self._finish(run_id, "partial" if partial else "ok", counts, snaps, None)
        return run_id, counts

    def _finish(self, run_id, status, counts, snaps, err):
        self.dst.execute("UPDATE studio_dw.extract_runs SET ended_at = now(), status = %s, rows = %s, queries = %s, error_class = %s, "
                         "db13_snapshot_now = %s WHERE run_id = %s",
                         [status, Jsonb(counts), self.throttle.calls, err, min(snaps) if snaps else None, run_id])


def verify_session(src, expect_user: str, log=print, throttle=None):
    """First-session checks (fable G-D5, VERIFY.md). Returns True only if every check passes; prints no values."""
    s = src if isinstance(src, Session) else Session(src, None, throttle)
    ok = True

    def check(name, good):
        nonlocal ok
        ok &= bool(good)
        log(f"{'PASS' if good else 'FAIL'} {name}")

    begin_read_only(s)  # includes SHOW transaction_read_only == on
    check("transaction_read_only on", s.run(queries.SHOW_RO_SQL).fetchone()[0] == "on")
    # informational: V's per-person role is not read-only by default; the job's own transaction is what protects DB13
    log(f"INFO default_transaction_read_only={s.run(queries.SHOW_DEFAULT_RO_SQL).fetchone()[0]}")
    check("current_user is the configured role", s.run(queries.CURRENT_USER_SQL).fetchone()[0] == expect_user)
    n = s.run(queries.ACTIVITY_SQL).fetchone()[0]
    check("pg_stat_activity count for current_user <= 3", 1 <= n <= 3)
    check("one SELECT count on one query (doctors)", s.run(queries.count_sql(BY_NAME["doctors"])).fetchone()[0] >= 0)
    try:
        s.run(queries.WRITE_PROBE_SQL)
        check("write attempt refused", False)
    except Exception as e:
        check("write attempt refused with the read-only error", "read-only transaction" in str(e) and "cannot execute" in str(e))
    end_txn(s, False)
    return ok
