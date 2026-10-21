"""Every governance read tool run LIVE-mode against a REAL Postgres built from the even-elo migrations
(src/lib/migrations.ts, applied in order), not a hand-copied schema.

Regression for the 21 Oct live 502: PHYSICIAN_PROFILE_SQL selected physician_engagements.engagement_type,
which migration 017_credentialing_v1 dropped (category replaced it). The old hand-written test DDL still had the
column, so nothing failed. Runs when STUDIO_TEST_PG_URI is set or `pgserver` is importable; skips otherwise.
"""

import importlib.util
import json
import os
import tempfile
import uuid

import psycopg
import pytest
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row

from src import studio_audit, studio_tools
from src.studio_tools import ALL_SQL, GOVERNANCE_TOOLS, VIEW_TOOL_NAMES, ToolError, ToolErrorToResult
from tests.test_studio_live_staff_sql import MIGRATIONS_TS, migrations

pytestmark = pytest.mark.skipif(not MIGRATIONS_TS.exists(), reason="even-elo repo root not available")

STAFF = "11111111-1111-4111-8111-111111111111"
CFG = {"configurable": {studio_tools.STAFF_KEY: STAFF}}
N_PHYSICIANS = 5


@pytest.fixture(scope="module")
def real_db():
    base = os.environ.get("STUDIO_TEST_PG_URI")
    server = None
    if not base:
        if importlib.util.find_spec("pgserver") is None:
            pytest.skip("no local Postgres (set STUDIO_TEST_PG_URI or install pgserver)")
        import pgserver

        server = pgserver.get_server(tempfile.mkdtemp(prefix="studio-real-schema-"))
        base = server.get_uri()
    name = "evenelo_" + uuid.uuid4().hex[:8]
    with psycopg.connect(base, autocommit=True) as c:
        c.execute(f'CREATE DATABASE "{name}"')
    conn = psycopg.connect(make_conninfo(base, dbname=name), autocommit=True, row_factory=dict_row)
    for mid, sql in migrations():
        try:
            conn.execute(sql.replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", ""), prepare=False)
        except Exception as exc:  # pragma: no cover
            raise AssertionError(f"even-elo migration {mid} failed to apply: {type(exc).__name__}") from exc
    seed(conn)
    try:
        yield conn
    finally:
        conn.close()
        if server:
            server.cleanup()


def seed(conn):
    hosp = conn.execute("INSERT INTO hospitals (code, name) VALUES ('H1', 'Hospital One') RETURNING id").fetchone()["id"]
    pids = []
    for i in range(N_PHYSICIANS):
        pid = conn.execute(
            "INSERT INTO physicians (full_name, primary_specialty, cdmss_doctor_uid) VALUES (%s, 'Cardiology', %s) RETURNING id",
            (f"Dr Sample {i}", f"uid-{i}"),
        ).fetchone()["id"]
        conn.execute(
            "INSERT INTO physician_engagements (physician_id, hospital_id, category, start_date) VALUES (%s, %s, 'active', current_date)", (pid, hosp)
        )
        pids.append(str(pid))
    conn.execute(
        "INSERT INTO gov_signal_snapshots (day, payload) VALUES (current_date, %s::jsonb)",
        ['{"report":{"signals":[{"label":"S1","severity":"watch","trend":"flat","scope":"mixed","n":10,"affected":[{"uid":"uid-0","n":4}]}]}}'],
    )
    conn.execute("INSERT INTO gov_interventions (signal_key, kind, physician_id) VALUES ('k', 'huddle_briefing', %s)", (pids[0],))
    pytest.real_pids = pids


@pytest.fixture
def live(real_db, monkeypatch):
    async def fetch(sql, params):
        studio_tools.assert_read_only(sql)
        return real_db.execute(sql, params).fetchall()

    async def audit(row):
        pass

    monkeypatch.setenv("STUDIO_LIVE_READS", "1")
    monkeypatch.setattr(studio_tools, "fetch_rows", fetch)
    monkeypatch.setattr(studio_audit, "audit_sink", audit)
    return real_db


async def call(name, args):
    t = next(t for t in GOVERNANCE_TOOLS if t.name == name)
    return json.loads(await t.ainvoke(args, config=CFG))


@pytest.mark.anyio
async def test_every_tool_runs_on_the_real_schema(live):
    pid = pytest.real_pids[0]
    calls = {
        "list_physicians": {"filter": {"hospital_code": "H1", "specialty_contains": "cardio"}},
        "physician_profile": {"physician_id": pid},
        "signal_snapshots": {"physician_id": pid, "window_days": 7},
        "interventions": {"physician_id": pid},
        "incident_summary": {},
        "overview_counts": {},
    }
    # The six studio_ro view tools read views from 0003_studio_views.sql (owner-run psql, preflight refuses a
    # superuser), covered against real tables by tests/test_studio_views.py. Any other new tool must be added here.
    assert set(calls) | set(VIEW_TOOL_NAMES) == set(ALL_SQL)
    for name, args in calls.items():
        out = await call(name, args)
        assert out["mode"] == "live" and out["synthetic"] is False, name


@pytest.mark.anyio
async def test_physician_profile_reads_engagement_category(live):
    out = await call("physician_profile", {"physician_id": pytest.real_pids[0]})
    assert out["row_count"] == 1
    assert out["rows"][0]["engagements"] == "H1 active active"  # hospital code, category, status


def test_the_old_engagement_type_query_fails_on_the_real_schema(real_db):
    """Sensitivity: the 21 Oct SQL really is rejected by the real schema, so the test above would have caught it."""
    old = studio_tools.PHYSICIAN_PROFILE_SQL.replace("e.category", "e.engagement_type")
    assert old != studio_tools.PHYSICIAN_PROFILE_SQL
    with pytest.raises(psycopg.errors.UndefinedColumn):
        real_db.execute(old, (pytest.real_pids[0],))


@pytest.mark.anyio
async def test_list_physicians_pages_cover_every_match_once(live):
    seen = []
    for offset in range(0, N_PHYSICIANS, 2):
        out = await call("list_physicians", {"limit": 2, "offset": offset})
        assert out["total"] == N_PHYSICIANS and "total_count" not in out["columns"]
        assert all("total_count" not in r for r in out["rows"])
        seen += [r["physician_id"] for r in out["rows"]]
    assert sorted(seen) == sorted(pytest.real_pids) and len(set(seen)) == N_PHYSICIANS
    past = await call("list_physicians", {"limit": 2, "offset": 50})
    assert past["rows"] == [] and past["row_count"] == 0 and "total" not in past


@pytest.mark.anyio
async def test_list_physicians_offset_is_bounded(live):
    t = next(t for t in GOVERNANCE_TOOLS if t.name == "list_physicians")
    for bad in (-1, studio_tools.MAX_OFFSET + 1):
        with pytest.raises(Exception):
            await t.ainvoke({"offset": bad}, config=CFG)


# --- chat: one failing tool must not abort the run -------------------------------------------------

def _request(name="physician_profile"):
    from types import SimpleNamespace

    return SimpleNamespace(tool_call={"name": name, "id": "call-1", "args": {}})


@pytest.mark.anyio
async def test_a_tool_error_becomes_a_tool_message():
    async def failing(request):
        raise ToolError("The governance database read failed.")

    msg = await ToolErrorToResult().awrap_tool_call(_request(), failing)
    assert msg.status == "error" and msg.tool_call_id == "call-1" and msg.content == "The governance database read failed."


@pytest.mark.anyio
async def test_other_errors_still_propagate():
    async def boom(request):
        raise RuntimeError("x")

    with pytest.raises(RuntimeError):
        await ToolErrorToResult().awrap_tool_call(_request(), boom)


@pytest.mark.anyio
async def test_tool_node_keeps_sibling_results_when_one_tool_fails(monkeypatch):
    """Through langgraph's real ToolNode: profile fails, signal_snapshots still answers."""
    from langchain_core.messages import AIMessage
    from langgraph.graph import START, MessagesState, StateGraph
    from langgraph.prebuilt import ToolNode

    async def fetch(sql, params):
        if sql == ALL_SQL["physician_profile"]:
            raise RuntimeError("UndefinedColumn")
        return [{"day": "2026-10-21"}]

    async def audit(row):
        pass

    monkeypatch.setenv("STUDIO_LIVE_READS", "1")
    monkeypatch.setattr(studio_tools, "fetch_rows", fetch)
    monkeypatch.setattr(studio_audit, "audit_sink", audit)
    pid = "22222222-2222-4222-8222-222222222222"
    ai = AIMessage(
        content="",
        tool_calls=[
            {"name": "physician_profile", "args": {"physician_id": pid}, "id": "a"},
            {"name": "signal_snapshots", "args": {"physician_id": pid}, "id": "b"},
        ],
    )

    def graph(node):
        g = StateGraph(MessagesState)
        g.add_node("tools", node)
        g.add_edge(START, "tools")
        return g.compile()

    with pytest.raises(ToolError):  # the premise: without the middleware the whole turn dies
        await graph(ToolNode(GOVERNANCE_TOOLS)).ainvoke({"messages": [ai]}, CFG)
    guarded = ToolNode(GOVERNANCE_TOOLS, awrap_tool_call=ToolErrorToResult().awrap_tool_call)
    out = await graph(guarded).ainvoke({"messages": [ai]}, CFG)
    by_id = {m.tool_call_id: m for m in out["messages"] if m.type == "tool"}
    assert by_id["a"].status == "error" and by_id["b"].status != "error"
