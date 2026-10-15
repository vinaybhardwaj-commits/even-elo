import json
import re

import pytest

from src import studio_audit, studio_tools
from src.studio_tools import (
    ALL_SQL,
    GOVERNANCE_TOOLS,
    ToolError,
    assert_read_only,
    like_pattern,
    live_reads_enabled,
)

STAFF = "11111111-1111-4111-8111-111111111111"
PID = "22222222-2222-4222-8222-222222222222"
CFG = {"configurable": {studio_tools.STAFF_KEY: STAFF}}


@pytest.fixture
def db(monkeypatch):
    calls, audits = [], []

    async def fake_fetch(sql, params):
        calls.append((sql, params))
        return [{"a": 1, "b": "x"}, {"a": 2, "b": "y"}]

    async def fake_audit(row):
        audits.append(row)

    monkeypatch.setattr(studio_tools, "fetch_rows", fake_fetch)
    monkeypatch.setattr(studio_audit, "audit_sink", fake_audit)
    return calls, audits


def tool(name):
    return next(t for t in GOVERNANCE_TOOLS if t.name == name)


async def call(name, args, config=CFG):
    return await tool(name).ainvoke(args, config=config)


def test_tool_list_is_the_read_only_set():
    assert [t.name for t in GOVERNANCE_TOOLS] == [
        "list_physicians",
        "physician_profile",
        "signal_snapshots",
        "interventions",
        "incident_summary",
        "overview_counts",
    ]


def test_no_tool_accepts_sql_or_a_staff_id():
    for t in GOVERNANCE_TOOLS:
        props = set(t.args)
        assert not props & {"sql", "query", "statement", "staff_id", "actor", "config"}, t.name


@pytest.mark.parametrize("name", sorted(ALL_SQL))
def test_every_statement_is_a_parameterised_select(name):
    sql = ALL_SQL[name]
    assert_read_only(sql)
    # No literal values are interpolated: every value arrives through %s.
    assert "%s" in sql or name == "overview_counts"
    assert not re.search(r"\{|\bf\"", sql)


@pytest.mark.parametrize(
    "sql",
    [
        "INSERT INTO studio_audit VALUES (1)",
        "UPDATE physicians SET full_name = 'x'",
        "DELETE FROM incidents",
        "DROP TABLE physicians",
        "SELECT 1; DROP TABLE physicians",
        "WITH x AS (DELETE FROM incidents RETURNING *) SELECT * FROM x",
        "SELECT * FROM physicians; UPDATE physicians SET notes = 'x'",
        "COPY physicians TO PROGRAM 'x'",
        "SET ROLE postgres",
        "CALL do_something()",
        "TRUNCATE incidents",
        "GRANT ALL ON physicians TO public",
    ],
)
def test_write_statements_are_refused_before_reaching_the_connection(sql):
    with pytest.raises(ValueError, match="read-only"):
        assert_read_only(sql)


@pytest.mark.anyio
async def test_pg_fetch_refuses_writes_and_uses_a_read_only_session(monkeypatch):
    events = []

    class Cur:
        async def fetchall(self):
            return [{"a": 1}]

    class Conn:
        async def set_read_only(self, v):
            events.append(("read_only", v))

        async def execute(self, sql, params):
            events.append(("execute", sql))
            return Cur()

        async def close(self):
            events.append(("close",))

    async def connect():
        c = Conn()
        await c.set_read_only(True)
        return c

    monkeypatch.setattr(studio_tools, "connect_read_only", connect)
    with pytest.raises(ValueError):
        await studio_tools._fetch_rows_pg("DELETE FROM incidents", ())
    assert [e for e in events if e[0] == "execute"] == []
    assert await studio_tools._fetch_rows_pg("SELECT 1", ()) == [{"a": 1}]
    assert ("read_only", True) in events and events[-1] == ("close",)


@pytest.mark.anyio
async def test_connect_read_only_sets_session_read_only(monkeypatch):
    import psycopg

    seen = {}

    class Conn:
        async def set_read_only(self, v):
            seen["ro"] = v

    async def fake_connect(dsn, **kw):
        seen["kw"] = kw
        return Conn()

    monkeypatch.setenv("GOV_RO_DATABASE_URL", "postgresql://u:p@h/db")
    monkeypatch.setattr(psycopg.AsyncConnection, "connect", fake_connect)
    from src.studio_db import connect_read_only

    await connect_read_only()
    # autocommit would make set_read_only() a silent no-op; no prepared statements (None, not 0).
    assert seen["ro"] is True and seen["kw"]["prepare_threshold"] is None and seen["kw"]["autocommit"] is False


@pytest.mark.anyio
async def test_staff_id_comes_from_config_and_is_audited(db):
    calls, audits = db
    out = json.loads(await call("overview_counts", {}))
    assert [a.staff_id for a in audits] == [STAFF]
    a = audits[0]
    assert (a.tool, a.row_count, a.mode) == ("overview_counts", 2, "live")
    assert a.duration_ms >= 0 and len(a.params_hash) == 16
    # Payload shape: typed table with a source (tool + query hash).
    assert out["source"]["tool"] == "overview_counts" and re.fullmatch(r"[0-9a-f]{12}", out["source"]["query_hash"])
    assert out["columns"] == ["a", "b"] and out["row_count"] == 2 and out["mode"] == "live" and out["synthetic"] is False


@pytest.mark.anyio
async def test_no_staff_identity_means_no_read_and_no_audit(db):
    calls, audits = db
    for cfg in ({}, {"configurable": {}}, {"configurable": {studio_tools.STAFF_KEY: ""}}):
        with pytest.raises(ToolError):
            await call("overview_counts", {}, cfg)
    assert calls == [] and audits == []


@pytest.mark.anyio
async def test_a_model_supplied_staff_id_is_not_accepted(db):
    calls, audits = db
    with pytest.raises(Exception):
        await call("overview_counts", {"staff_id": "attacker"}, {"configurable": {}})
    assert audits == []


@pytest.mark.anyio
async def test_audit_row_has_no_content(db):
    _, audits = db
    await call("list_physicians", {"filter": {"name_contains": "Sample"}, "limit": 5})
    row = audits[0]
    assert set(vars(row)) == {"staff_id", "tool", "params_hash", "row_count", "duration_ms", "mode", "outcome"}
    assert row.outcome == "ok"
    blob = json.dumps(vars(row))
    assert "Sample" not in blob and '"x"' not in blob


@pytest.mark.anyio
async def test_params_are_bound_not_interpolated(db):
    calls, _ = db
    evil = "x'; DROP TABLE physicians; --"
    await call("list_physicians", {"filter": {"name_contains": evil, "hospital_code": evil}, "limit": 10})
    sql, params = calls[0]
    assert evil not in sql and "DROP TABLE" not in sql
    assert like_pattern(evil) in params and evil in params and params[-1] == 10


def test_like_pattern_escapes_wildcards():
    assert like_pattern("50%_off\\") == "%50\\%\\_off\\\\%"


@pytest.mark.anyio
async def test_argument_validation(db):
    calls, audits = db
    for name, args in [
        ("list_physicians", {"limit": 201}),
        ("list_physicians", {"limit": 0}),
        ("list_physicians", {"filter": {"status": "deleted"}}),
        ("physician_profile", {"physician_id": "not-a-uuid"}),
        ("signal_snapshots", {"window_days": 0}),
        ("signal_snapshots", {"window_days": 366}),
        ("incident_summary", {"window_days": -1}),
        ("interventions", {"physician_id": "1 OR 1=1"}),
    ]:
        with pytest.raises(Exception):
            await call(name, args)
    assert calls == [] and audits == []


@pytest.mark.anyio
async def test_each_tool_runs_with_its_parameters(db):
    calls, audits = db
    await call("list_physicians", {"filter": {"status": "active", "specialty_contains": "card"}, "limit": 200})
    await call("physician_profile", {"physician_id": PID})
    await call("signal_snapshots", {"physician_id": PID, "window_days": 14})
    await call("signal_snapshots", {})
    await call("interventions", {"physician_id": PID})
    await call("interventions", {})
    await call("incident_summary", {"window_days": 90})
    await call("overview_counts", {})
    assert [a.tool for a in audits] == [
        "list_physicians", "physician_profile", "signal_snapshots", "signal_snapshots",
        "interventions", "interventions", "incident_summary", "overview_counts",
    ]
    by_tool = {}
    for (sql, params), a in zip(calls, audits):
        by_tool.setdefault(a.tool, []).append(params)
        assert sql == ALL_SQL[a.tool]
        assert sql.count("%s") == len(params), a.tool  # placeholder/param counts always agree
    assert by_tool["physician_profile"] == [(PID,)]
    assert by_tool["signal_snapshots"][0] == (PID, 14, PID, 50)
    assert by_tool["signal_snapshots"][1] == (None, 30, None, 50)
    assert by_tool["incident_summary"] == [(90, 200)]
    assert max(len(p) for p in by_tool["list_physicians"]) == 9


@pytest.mark.anyio
async def test_audit_failure_returns_no_data(db, monkeypatch):
    async def broken(row):
        raise RuntimeError("audit db down: postgresql://secret@host")

    monkeypatch.setattr(studio_audit, "audit_sink", broken)
    with pytest.raises(ToolError) as e:
        await call("overview_counts", {})
    assert "secret" not in str(e.value) and "postgresql" not in str(e.value)


@pytest.mark.anyio
async def test_db_error_text_is_not_leaked_and_the_failed_read_is_audited(db, monkeypatch):
    _, audits = db

    async def boom(sql, params):
        raise RuntimeError("connection to host db.internal user=admin failed")

    monkeypatch.setattr(studio_tools, "fetch_rows", boom)
    with pytest.raises(ToolError) as e:
        await call("overview_counts", {})
    assert "internal" not in str(e.value) and "admin" not in str(e.value)
    assert [(a.tool, a.row_count, a.outcome, a.staff_id) for a in audits] == [("overview_counts", 0, "error", STAFF)]


@pytest.mark.anyio
async def test_missing_fixture_read_is_audited_as_an_error_too(db, monkeypatch):
    _, audits = db
    monkeypatch.setenv("STUDIO_LIVE_READS", "0")
    monkeypatch.setattr(studio_tools, "FIXTURE_DIR", studio_tools.FIXTURE_DIR / "nope")
    with pytest.raises(ToolError):
        await call("overview_counts", {})
    assert [(a.row_count, a.outcome, a.mode) for a in audits] == [(0, "error", "fixture")]


@pytest.mark.anyio
async def test_audit_failure_on_the_error_path_does_not_mask_the_read_error(db, monkeypatch):
    async def boom(sql, params):
        raise RuntimeError("x")

    async def broken(row):
        raise RuntimeError("audit down")

    monkeypatch.setattr(studio_tools, "fetch_rows", boom)
    monkeypatch.setattr(studio_audit, "audit_sink", broken)
    with pytest.raises(ToolError, match="read failed"):
        await call("overview_counts", {})


def test_fixtures_ship_inside_src_so_the_kill_switch_works_without_tests_dir():
    assert studio_tools.FIXTURE_DIR.parent.name == "src" and "tests" not in studio_tools.FIXTURE_DIR.parts
    assert {p.stem for p in studio_tools.FIXTURE_DIR.glob("*.json")} == set(ALL_SQL)


def test_kill_switch_values(monkeypatch):
    assert live_reads_enabled() is True  # unset
    for v in ("1", "true", "yes", "on"):
        monkeypatch.setenv("STUDIO_LIVE_READS", v)
        assert live_reads_enabled() is True
    for v in ("0", "false", "OFF", "no", "", " 0 "):
        monkeypatch.setenv("STUDIO_LIVE_READS", v)
        assert live_reads_enabled() is False, repr(v)


@pytest.mark.anyio
async def test_kill_switch_is_read_per_call_and_serves_fixtures_without_touching_the_db(db, monkeypatch):
    calls, audits = db
    live = json.loads(await call("overview_counts", {}))
    assert live["mode"] == "live" and len(calls) == 1
    monkeypatch.setenv("STUDIO_LIVE_READS", "0")  # no restart, no redeploy
    fx = json.loads(await call("overview_counts", {}))
    assert len(calls) == 1  # DB untouched
    assert fx["mode"] == "fixture" and fx["synthetic"] is True and fx["source"]["tool"] == "overview_counts"
    assert fx["row_count"] == len(fx["rows"]) > 0
    assert [a.mode for a in audits] == ["live", "fixture"]  # fixture calls are audited too
    monkeypatch.setenv("STUDIO_LIVE_READS", "1")
    assert json.loads(await call("overview_counts", {}))["mode"] == "live"


@pytest.mark.anyio
@pytest.mark.parametrize("name,args", [
    ("list_physicians", {"limit": 2}),
    ("physician_profile", {"physician_id": PID}),
    ("signal_snapshots", {}),
    ("interventions", {}),
    ("incident_summary", {}),
    ("overview_counts", {}),
])
async def test_every_tool_has_a_fixture_and_labels_it_synthetic(db, monkeypatch, name, args):
    monkeypatch.setenv("STUDIO_LIVE_READS", "0")
    out = json.loads(await call(name, args))
    assert out["synthetic"] is True and out["rows"] and set(out["rows"][0]) == set(out["columns"])
    if name == "list_physicians":
        assert len(out["rows"]) == 2  # limit honoured


def test_fixtures_are_synthetic_only():
    for path in studio_tools.FIXTURE_DIR.glob("*.json"):
        data = json.loads(path.read_text())
        assert data["synthetic"] is True
        text = re.sub(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "", path.read_text())
        assert not re.search(r"@|\+?\d{10,}", text), path.name


@pytest.mark.anyio
async def test_missing_fixture_is_an_error_not_live_data(db, monkeypatch):
    monkeypatch.setenv("STUDIO_LIVE_READS", "0")
    monkeypatch.setattr(studio_tools, "FIXTURE_DIR", studio_tools.FIXTURE_DIR / "nope")
    calls, _ = db
    with pytest.raises(ToolError):
        await call("overview_counts", {})
    assert calls == []


def test_selected_columns_exclude_free_text_and_contact_details():
    joined = " ".join(ALL_SQL.values()).lower()
    for banned in ("narrative", "ruling_note", "note,", ".notes", "email", "phone", "registration_number", "password", "reporter_name", "evidence_urls", "payload,"):
        assert banned not in joined, banned
    assert "select *" not in joined and ".*" not in joined
