import asyncio
import importlib.util
import json
import socket
import tempfile
import threading

import pytest
from psycopg.conninfo import conninfo_to_dict

from src import studio_audit, studio_db, studio_tools
from src.studio_pins import PinError, pinned_conninfo

HOST = "ep-fake-1234.example-neon.invalid"  # never resolvable


@pytest.fixture
def pins(tmp_path, monkeypatch):
    path = tmp_path / "neon-pins.json"
    monkeypatch.setenv("STUDIO_NEON_PINS", str(path))

    def write(data):
        path.write_text(json.dumps(data))

    return write


@pytest.fixture
def no_dns(monkeypatch):
    calls = []

    def boom(*a, **k):
        calls.append(a)
        raise AssertionError("DNS lookup attempted")

    monkeypatch.setattr(socket, "getaddrinfo", boom)
    monkeypatch.setattr(socket, "gethostbyname", boom)
    return calls


URL = f"postgresql://u:p@{HOST}/db?sslmode=require&channel_binding=require"


def test_pin_adds_hostaddr_and_keeps_host_sslmode_for_sni(pins):
    pins({HOST: ["2600:1f18::1", "203.0.113.7", "203.0.113.8"]})
    d = conninfo_to_dict(pinned_conninfo(URL))
    assert d["hostaddr"] == "203.0.113.7"  # IPv4 preferred
    assert d["host"] == HOST  # name kept: TLS SNI + certificate verification
    assert d["sslmode"] == "require" and d["channel_binding"] == "require"
    assert d["user"] == "u" and d["dbname"] == "db"


def test_only_ipv6_pin_is_used_when_no_ipv4(pins):
    pins({HOST: ["2600:1f18::1"]})
    assert conninfo_to_dict(pinned_conninfo(URL))["hostaddr"] == "2600:1f18::1"


def test_host_match_is_case_insensitive(pins):
    pins({HOST.upper(): ["203.0.113.7"]})
    assert conninfo_to_dict(pinned_conninfo(URL))["hostaddr"] == "203.0.113.7"


def test_no_pins_file_and_no_require_is_unchanged(tmp_path, monkeypatch):
    monkeypatch.setenv("STUDIO_NEON_PINS", str(tmp_path / "absent.json"))
    assert pinned_conninfo(URL) == URL


def test_unpinned_host_without_require_is_unchanged(pins):
    pins({"other.host": ["203.0.113.9"]})
    assert pinned_conninfo(URL) == URL


def test_require_pins_fails_closed_for_unpinned_hosts_and_missing_file(pins, tmp_path, monkeypatch, no_dns):
    monkeypatch.setenv("STUDIO_REQUIRE_PINS", "1")
    pins({"other.host": ["203.0.113.9"]})
    with pytest.raises(PinError) as e:
        pinned_conninfo(URL)
    assert HOST not in str(e.value) and "u:p" not in str(e.value)
    monkeypatch.setenv("STUDIO_NEON_PINS", str(tmp_path / "absent.json"))
    with pytest.raises(PinError):
        pinned_conninfo(URL)
    (tmp_path / "bad.json").write_text("{not json")
    monkeypatch.setenv("STUDIO_NEON_PINS", str(tmp_path / "bad.json"))
    with pytest.raises(PinError):
        pinned_conninfo(URL)
    assert no_dns == []


def test_sockets_ip_literals_and_explicit_hostaddr_need_no_pin(monkeypatch):
    monkeypatch.setenv("STUDIO_REQUIRE_PINS", "1")
    for dsn in ("postgresql://u@/db?host=/var/run/postgresql", "postgresql://u@203.0.113.7/db", "postgresql://u@[2600::1]/db", f"host={HOST} hostaddr=203.0.113.1 dbname=db"):
        assert pinned_conninfo(dsn) == dsn


def test_default_pins_path_is_run_studio_agent(monkeypatch):
    from src.studio_pins import DEFAULT_PINS_PATH, pins_path

    monkeypatch.delenv("STUDIO_NEON_PINS", raising=False)
    assert str(pins_path()) == DEFAULT_PINS_PATH == "/run/studio-agent/neon-pins.json"


@pytest.mark.anyio
async def test_connect_helpers_fail_closed_without_dns(monkeypatch, no_dns, tmp_path):
    monkeypatch.setenv("STUDIO_REQUIRE_PINS", "1")
    monkeypatch.setenv("STUDIO_NEON_PINS", str(tmp_path / "absent.json"))
    monkeypatch.setenv("GOV_RO_DATABASE_URL", URL)
    monkeypatch.setenv("STUDIO_DATABASE_URL", URL)
    for connect in (studio_db.connect_read_only, studio_db.connect_studio):
        with pytest.raises(PinError):
            await connect()
    assert no_dns == []


@pytest.mark.anyio
async def test_unpinned_tool_read_is_a_audited_tool_error_with_no_dns(monkeypatch, no_dns, tmp_path):
    monkeypatch.setenv("STUDIO_REQUIRE_PINS", "1")
    monkeypatch.setenv("STUDIO_NEON_PINS", str(tmp_path / "absent.json"))
    monkeypatch.setenv("GOV_RO_DATABASE_URL", URL)
    audits = []

    async def sink(row):
        audits.append(row)

    monkeypatch.setattr(studio_audit, "audit_sink", sink)
    cfg = {"configurable": {studio_tools.STAFF_KEY: "staff-1"}}
    with pytest.raises(studio_tools.ToolError, match="not pinned"):
        await studio_tools.overview_counts.ainvoke({}, config=cfg)
    assert [(a.outcome, a.row_count) for a in audits] == [("error", 0)]
    assert no_dns == []


def test_pool_conninfo_is_pinned(monkeypatch, pins):
    from src import studio_checkpoint

    pins({HOST: ["203.0.113.7"]})
    seen = {}

    class FakePool:
        def __init__(self, conninfo, **kw):
            seen["conninfo"] = conninfo

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(studio_checkpoint, "AsyncConnectionPool", FakePool)

    async def go():
        async with studio_checkpoint.postgres_checkpointer(URL):
            pass

    asyncio.run(go())
    assert conninfo_to_dict(seen["conninfo"])["hostaddr"] == "203.0.113.7"
    assert conninfo_to_dict(seen["conninfo"])["host"] == HOST


# ----- a real connection: fake (unresolvable) host name + hostaddr pointing at a local Postgres -----


def _forward(unix_dir: str):
    """TCP 127.0.0.1:port -> the pgserver unix socket (pgserver does not listen on TCP)."""
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(8)
    sock_path = f"{unix_dir}/.s.PGSQL.5432"

    def pump(a, b):
        try:
            while data := a.recv(65536):
                b.sendall(data)
        except OSError:
            pass
        finally:
            for s in (a, b):
                try:
                    s.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

    def accept():
        while True:
            try:
                c, _ = srv.accept()
            except OSError:
                return
            u = socket.socket(socket.AF_UNIX)
            u.connect(sock_path)
            threading.Thread(target=pump, args=(c, u), daemon=True).start()
            threading.Thread(target=pump, args=(u, c), daemon=True).start()

    threading.Thread(target=accept, daemon=True).start()
    return srv, srv.getsockname()[1]


@pytest.mark.anyio
async def test_connects_through_the_pin_to_a_real_postgres_without_resolving_the_name(monkeypatch, pins):
    if importlib.util.find_spec("pgserver") is None:
        pytest.skip("pgserver not installed")
    import pgserver

    server = pgserver.get_server(tempfile.mkdtemp(prefix="studio-pins-"))
    try:
        unix_dir = server.get_uri().split("host=")[1]
        srv, port = _forward(unix_dir)
        pins({HOST: ["127.0.0.1"]})
        monkeypatch.setenv("GOV_RO_DATABASE_URL", f"postgresql://postgres@{HOST}:{port}/postgres?sslmode=disable")
        monkeypatch.setenv("STUDIO_REQUIRE_PINS", "1")
        # The fake name does not resolve: an unpinned connect must fail, a pinned one must work.
        with pytest.raises(Exception):
            socket.getaddrinfo(HOST, port)
        conn = await studio_db.connect_read_only()
        try:
            cur = await conn.execute("SHOW transaction_read_only")
            assert (await cur.fetchone())["transaction_read_only"] == "on"
        finally:
            await conn.close()
        srv.close()
    finally:
        server.cleanup()
