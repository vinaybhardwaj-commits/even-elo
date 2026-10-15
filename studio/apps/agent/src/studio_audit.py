"""studio_audit: one row per tool call. Metadata only, NEVER row content.

Columns written: staff_id, tool, params_hash, row_count, duration_ms, mode, outcome. (ts defaults in the DB.)
The table is append-only (see migrations/0001_studio.sql).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from src.studio_db import connect_studio


@dataclass(frozen=True)
class AuditRow:
    staff_id: str
    tool: str
    params_hash: str
    row_count: int
    duration_ms: int
    mode: str  # "live" | "fixture"
    outcome: str = "ok"  # "ok" | "error" (failed reads are audited too, row_count 0)


def params_hash(params: dict[str, Any]) -> str:
    blob = json.dumps(params, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


INSERT_SQL = (
    "INSERT INTO studio_audit (staff_id, tool, params_hash, row_count, duration_ms, mode, outcome) "
    "VALUES (%s, %s, %s, %s, %s, %s, %s)"
)


async def write_audit_row(row: AuditRow) -> None:
    conn = await connect_studio()
    try:
        await conn.execute(
            INSERT_SQL, (row.staff_id, row.tool, row.params_hash, row.row_count, row.duration_ms, row.mode, row.outcome)
        )
    finally:
        await conn.close()


# Replaceable sink (tests inject a recorder). Raising makes the tool call fail closed.
AuditSink = Callable[[AuditRow], Awaitable[None]]
audit_sink: AuditSink = write_audit_row
