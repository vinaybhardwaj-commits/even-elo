"""Checkpoint storage. Production: langgraph-checkpoint-postgres on STUDIO_DATABASE_URL.

Neon rules: autocommit, prepare_threshold=0 (pooled endpoint has no server-side prepared
statements). Tables are created by apply_migration.py (setup() on the DIRECT url), never here.
Dev fallback (STUDIO_DATABASE_URL unset): bounded in-memory saver, with a warning.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from src.bounded_memory_saver import BoundedMemorySaver

logger = logging.getLogger("studio.checkpoint")


def pool_kwargs() -> dict:
    return {"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row}


def dev_checkpointer() -> BoundedMemorySaver:
    logger.warning("STUDIO_DATABASE_URL is unset: using in-memory checkpoints (development only)")
    return BoundedMemorySaver(max_threads=200)


@asynccontextmanager
async def postgres_checkpointer(dsn: str | None = None):
    """Open a pool and yield an AsyncPostgresSaver. The URL is never logged."""
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

    url = dsn or os.environ["STUDIO_DATABASE_URL"]
    async with AsyncConnectionPool(conninfo=url, max_size=5, open=False, kwargs=pool_kwargs()) as pool:
        yield AsyncPostgresSaver(pool)
