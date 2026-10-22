"""Connection helpers. Connection strings come from env only and are never logged."""

from __future__ import annotations

import os

import psycopg
from psycopg.rows import dict_row

from src.studio_pins import pinned_conninfo


class NotConfigured(RuntimeError):
    pass


def _dsn(env_name: str) -> str:
    """The connection string with hostaddr pinned (no DNS needed); PinError fails closed."""
    value = os.environ.get(env_name, "")
    if not value:
        raise NotConfigured(f"{env_name} is not set")
    return pinned_conninfo(value)


async def connect_read_only() -> psycopg.AsyncConnection:
    """SELECT-only governance connection (GOV_RO_DATABASE_URL), read-only at the session level too.

    NOT autocommit: set_read_only() only applies to transactions psycopg BEGINs, so with autocommit
    it is a silent no-op (a write-capable role could then write). Each statement therefore runs in
    an implicit `BEGIN READ ONLY` transaction that is rolled back on close. Startup `options` are
    avoided because Neon's pooled endpoint rejects them. prepare_threshold=None: no prepared
    statements (0 would mean "prepare on first use").
    """
    conn = await psycopg.AsyncConnection.connect(
        _dsn("GOV_RO_DATABASE_URL"), autocommit=False, prepare_threshold=None, row_factory=dict_row
    )
    await conn.set_read_only(True)
    return conn


CDMSS_STATEMENT_TIMEOUT_MS = 30_000


async def connect_cdmss_read_only() -> psycopg.AsyncConnection:
    """SELECT-only CDMSS connection (CDMSS_RO_DATABASE_URL: the relay's cdmss alias, role studio_cdmss_ro, views in schema cdmss_ro).

    Same rules as connect_read_only (not autocommit, so set_read_only() really applies, no startup `options`, no prepared statements),
    plus a 30 s statement_timeout set on THIS connection and committed so it survives the first transaction: the relay's own
    connect_query sets both once per server connection, but its DISCARD ALL reset undoes them when a client leaves, so the agent does
    not rely on it. No tool uses this yet (Phase 1)."""
    conn = await psycopg.AsyncConnection.connect(
        _dsn("CDMSS_RO_DATABASE_URL"), autocommit=False, prepare_threshold=None, row_factory=dict_row
    )
    try:
        await conn.execute(f"SET statement_timeout = {CDMSS_STATEMENT_TIMEOUT_MS}")
        await conn.commit()
        await conn.set_read_only(True)
    except BaseException:
        await conn.close()
        raise
    return conn


def cdmss_configured() -> bool:
    return bool(os.environ.get("CDMSS_RO_DATABASE_URL"))


async def connect_studio() -> psycopg.AsyncConnection:
    """Studio state connection (STUDIO_DATABASE_URL): audit, nonce, checkpoints."""
    return await psycopg.AsyncConnection.connect(
        _dsn("STUDIO_DATABASE_URL"), autocommit=True, prepare_threshold=None, row_factory=dict_row
    )


def studio_db_configured() -> bool:
    return bool(os.environ.get("STUDIO_DATABASE_URL"))
