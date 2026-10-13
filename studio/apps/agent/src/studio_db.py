"""Connection helpers. Connection strings come from env only and are never logged."""

from __future__ import annotations

import os

import psycopg
from psycopg.rows import dict_row


class NotConfigured(RuntimeError):
    pass


def _dsn(env_name: str) -> str:
    value = os.environ.get(env_name, "")
    if not value:
        raise NotConfigured(f"{env_name} is not set")
    return value


async def connect_read_only() -> psycopg.AsyncConnection:
    """SELECT-only governance connection (GOV_RO_DATABASE_URL). Also forced read-only per session."""
    conn = await psycopg.AsyncConnection.connect(
        _dsn("GOV_RO_DATABASE_URL"), autocommit=True, prepare_threshold=0, row_factory=dict_row
    )
    await conn.set_read_only(True)
    return conn


async def connect_studio() -> psycopg.AsyncConnection:
    """Studio state connection (STUDIO_DATABASE_URL): audit, nonce, checkpoints."""
    return await psycopg.AsyncConnection.connect(
        _dsn("STUDIO_DATABASE_URL"), autocommit=True, prepare_threshold=0, row_factory=dict_row
    )


def studio_db_configured() -> bool:
    return bool(os.environ.get("STUDIO_DATABASE_URL"))
