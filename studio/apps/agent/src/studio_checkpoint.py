"""Checkpoint storage. Production: langgraph-checkpoint-postgres on STUDIO_DATABASE_URL.

Neon rules: autocommit and prepare_threshold=None (NO prepared statements; 0 would mean
"prepare on first use", which a transaction-pooled endpoint may reject). Tables are created by apply_migration.py (setup() on the DIRECT url), never here.
Retention: checkpoints keep full chat and tool-result rows. Never delete them from the app; ops
archives a thread (studio_threads.archived) and moves cold rows under a retention decision.
Dev fallback (STUDIO_DATABASE_URL unset): bounded in-memory saver, with a warning.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from src.bounded_memory_saver import BoundedMemorySaver
from src.studio_pins import pinned_conninfo

logger = logging.getLogger("studio.checkpoint")


def pool_kwargs() -> dict:
    return {"autocommit": True, "prepare_threshold": None, "row_factory": dict_row}


def dev_checkpointer() -> BoundedMemorySaver:
    logger.warning("STUDIO_DATABASE_URL is unset: using in-memory checkpoints (development only)")
    return BoundedMemorySaver(max_threads=200)


@asynccontextmanager
async def postgres_checkpointer(dsn: str | None = None):
    """Open a pool and yield an AsyncPostgresSaver. The URL is never logged."""
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

    url = dsn or os.environ["STUDIO_DATABASE_URL"]
    async with AsyncConnectionPool(conninfo=pinned_conninfo(url), max_size=5, open=False, kwargs=pool_kwargs()) as pool:
        yield AsyncPostgresSaver(pool)
