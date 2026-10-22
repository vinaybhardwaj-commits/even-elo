"""The ONLY SQL text sent to DB13 as a data query. Rendered from spec.py with fixed shapes; every text is hashed
(SHA-256) and must appear in manifest.json, or the job refuses to send it. Regenerate the manifest after a reviewed
spec change with `python -m extract.manifest write` (from ops/db13)."""
from __future__ import annotations

import hashlib

from .spec import TABLES, Table

SNAPSHOT_SQL = "SELECT now(), pg_current_snapshot()::text"


def sha(sql: str) -> str:
    return hashlib.sha256(sql.encode()).hexdigest()


def _cols(t: Table) -> str:
    return ", ".join(f't."{c.name}"::{c.type} AS "{c.name}"' for c in t.cols)


def rows_sql(t: Table, after_key: bool, incremental: bool) -> str:
    conds = [f't."{t.key}" IS NOT NULL']
    if after_key:
        conds.append(f't."{t.key}" > %(last)s')
    if incremental:
        conds.append(f't."{t.wm}" > %(since)s::timestamptz - %(lb)s::interval')
    return f'SELECT {_cols(t)} FROM {t.source} t WHERE {" AND ".join(conds)} ORDER BY t."{t.key}" LIMIT %(n)s'


def ids_sql(t: Table, after_key: bool) -> str:
    g = t.group_key
    w = f't."{g}" IS NOT NULL' + (f' AND t."{g}" > %(last)s' if after_key else "")
    return f'SELECT DISTINCT t."{g}"::text FROM {t.source} t WHERE {w} ORDER BY 1 LIMIT %(n)s'


def children_sql(t: Table) -> str:
    return f'SELECT {_cols(t)} FROM {t.source} t WHERE t."{t.group_key}"::text = ANY(%(keys)s)'


def count_sql(t: Table) -> str:
    order = t.key or t.group_key
    return f'SELECT count(*) FROM (SELECT {_cols(t)} FROM {t.source} t ORDER BY t."{order}") s'


def all_queries() -> dict[str, str]:
    out = {"snapshot": SNAPSHOT_SQL}
    for t in TABLES:
        if t.group_key:
            out[f"{t.name}.ids.first"], out[f"{t.name}.ids.next"] = ids_sql(t, False), ids_sql(t, True)
            out[f"{t.name}.children"] = children_sql(t)
        else:
            for after in (False, True):
                for inc in ((False, True) if t.wm else (False,)):
                    out[f"{t.name}.rows.{'next' if after else 'first'}.{'inc' if inc else 'full'}"] = rows_sql(t, after, inc)
        out[f"{t.name}.count"] = count_sql(t)
    return out
