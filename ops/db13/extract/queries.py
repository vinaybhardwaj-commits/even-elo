"""The ONLY SQL text sent to DB13: session statements and one data SELECT per table. Rendered from spec.py in fixed
shapes; every text is hashed (SHA-256) and must appear in manifest.json, or the job refuses to send it. The data SELECT
is declared as a server-side cursor and read with FETCH; psycopg generates DECLARE/FETCH/CLOSE around the pinned text.
Regenerate the manifest after a reviewed spec change with `python3 -m extract.manifest write` (from ops/db13)."""
from __future__ import annotations

import hashlib

from .spec import TABLES, Table

BEGIN_SQL = "BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ"
SET_TIMEOUT_SQL = "SET statement_timeout = '60s'"
SET_IDLE_SQL = "SET idle_in_transaction_session_timeout = '5min'"  # Neon writes happen between fetches
SHOW_RO_SQL = "SHOW transaction_read_only"
SHOW_TIMEOUT_SQL = "SHOW statement_timeout"
SNAPSHOT_SQL = "SELECT now(), pg_current_snapshot()::text"
COMMIT_SQL = "COMMIT"
ROLLBACK_SQL = "ROLLBACK"
# first-session verification only (VERIFY.md)
SHOW_DEFAULT_RO_SQL = "SHOW default_transaction_read_only"
CURRENT_USER_SQL = "SELECT current_user"
ACTIVITY_SQL = "SELECT count(*) FROM pg_stat_activity WHERE usename = current_user"
WRITE_PROBE_SQL = "CREATE TABLE studio_dw_verify_must_fail (a int)"
STATEMENTS = {
    "begin": BEGIN_SQL, "set_timeout": SET_TIMEOUT_SQL, "set_idle": SET_IDLE_SQL, "show_ro": SHOW_RO_SQL,
    "show_timeout": SHOW_TIMEOUT_SQL, "snapshot": SNAPSHOT_SQL, "commit": COMMIT_SQL, "rollback": ROLLBACK_SQL,
    "show_default_ro": SHOW_DEFAULT_RO_SQL, "current_user": CURRENT_USER_SQL, "activity": ACTIVITY_SQL, "write_probe": WRITE_PROBE_SQL,
}


def sha(sql: str) -> str:
    return hashlib.sha256(sql.encode()).hexdigest()


def _cols(t: Table) -> str:
    return ", ".join(f't."{c.name}"::{c.type} AS "{c.name}"' for c in t.cols)


def cursor_sql(t: Table, incremental: bool) -> str:
    """One pass over the table: no ORDER BY, no LIMIT, no paging."""
    k = t.key or t.group_key
    w = f't."{k}" IS NOT NULL'
    if incremental:
        w += f' AND t."{t.wm}" > %(since)s::timestamptz - %(lb)s::interval'
    return f"SELECT {_cols(t)} FROM {t.source} t WHERE {w}"


def count_sql(t: Table) -> str:
    return f"SELECT count(*) FROM (SELECT {_cols(t)} FROM {t.source} t) s"


def all_queries() -> dict[str, str]:
    out = {f"session.{k}": v for k, v in STATEMENTS.items()}
    for t in TABLES:
        out[f"{t.name}.cursor.full"] = cursor_sql(t, False)
        if t.wm:
            out[f"{t.name}.cursor.inc"] = cursor_sql(t, True)
        out[f"{t.name}.count"] = count_sql(t)
    return out
