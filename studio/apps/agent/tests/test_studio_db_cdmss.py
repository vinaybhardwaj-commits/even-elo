"""connect_cdmss_read_only: the CDMSS_RO_DATABASE_URL connection helper (no tool uses it yet). A fake psycopg connection records what it was told."""

import asyncio

import psycopg
import pytest

from src import studio_db


class FakeConn:
    def __init__(self, fail_on=None):
        self.calls, self.closed, self.fail_on = [], False, fail_on

    async def execute(self, sql):
        self.calls.append(("execute", sql))
        if self.fail_on == "execute":
            raise RuntimeError("boom")

    async def commit(self):
        self.calls.append(("commit",))

    async def set_read_only(self, value):
        self.calls.append(("set_read_only", value))

    async def close(self):
        self.closed = True


@pytest.fixture
def connect(monkeypatch):
    seen = {}

    async def fake(dsn, **kw):
        seen["dsn"], seen["kw"] = dsn, kw
        seen["conn"] = FakeConn(fail_on=seen.get("fail_on"))
        return seen["conn"]

    monkeypatch.setattr(psycopg.AsyncConnection, "connect", fake)
    monkeypatch.delenv("STUDIO_REQUIRE_PINS", raising=False)
    monkeypatch.setenv("STUDIO_NEON_PINS", "/nonexistent/pins.json")
    return seen


def test_not_configured_without_the_env_var(monkeypatch):
    monkeypatch.delenv("CDMSS_RO_DATABASE_URL", raising=False)
    assert studio_db.cdmss_configured() is False
    with pytest.raises(studio_db.NotConfigured, match="CDMSS_RO_DATABASE_URL"):
        asyncio.run(studio_db.connect_cdmss_read_only())


def test_connects_read_only_with_a_30s_statement_timeout(monkeypatch, connect):
    dsn = "postgresql://agent_cdmss:pw@127.0.0.1:6432/cdmss?sslmode=disable"
    monkeypatch.setenv("CDMSS_RO_DATABASE_URL", dsn)
    assert studio_db.cdmss_configured() is True
    conn = asyncio.run(studio_db.connect_cdmss_read_only())
    assert connect["dsn"] == dsn
    kw = connect["kw"]
    assert kw["autocommit"] is False and kw["prepare_threshold"] is None and "options" not in kw
    assert conn.calls == [("execute", "SET statement_timeout = 30000"), ("commit",), ("set_read_only", True)]
    assert studio_db.CDMSS_STATEMENT_TIMEOUT_MS == 30_000 and not conn.closed


def test_a_failed_setup_closes_the_connection(monkeypatch, connect):
    monkeypatch.setenv("CDMSS_RO_DATABASE_URL", "postgresql://agent_cdmss:pw@127.0.0.1:6432/cdmss?sslmode=disable")
    connect["fail_on"] = "execute"
    with pytest.raises(RuntimeError):
        asyncio.run(studio_db.connect_cdmss_read_only())
    assert connect["conn"].closed


def test_gov_and_cdmss_use_different_env_names(monkeypatch, connect):
    monkeypatch.setenv("GOV_RO_DATABASE_URL", "postgresql://agent_gov:pw@127.0.0.1:6432/gov?sslmode=disable")
    monkeypatch.delenv("CDMSS_RO_DATABASE_URL", raising=False)
    with pytest.raises(studio_db.NotConfigured):
        asyncio.run(studio_db.connect_cdmss_read_only())
