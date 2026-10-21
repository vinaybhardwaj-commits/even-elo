"""POST /agent/tools/{name}: the screen door onto the six read tools (M1)."""

import importlib
import logging
import sys
import time
import uuid

import jwt
import pytest
from fastapi.testclient import TestClient

from src import studio_audit, studio_tools

SERVICE = "svc-token-not-real"
SECRET = "actor-secret-not-real-0123456789abcdef"
STAFF = "staff-7"
PID = "22222222-2222-4222-8222-222222222222"


@pytest.fixture
def main(monkeypatch):
    monkeypatch.setenv("STUDIO_SERVICE_TOKEN", SERVICE)
    monkeypatch.setenv("STUDIO_ACTOR_SECRET", SECRET)
    monkeypatch.delenv("STUDIO_LIVE_READS", raising=False)
    sys.modules.pop("main", None)
    mod = importlib.import_module("main")
    yield mod
    sys.modules.pop("main", None)


def headers(sub=STAFF, role="super_admin"):
    now = int(time.time())
    claims = {"sub": sub, "role": role, "aud": "studio-agent", "iat": now, "exp": now + 45, "jti": uuid.uuid4().hex}
    return {"X-Studio-Service-Token": SERVICE, "X-Studio-Actor": jwt.encode(claims, SECRET, algorithm="HS256")}


@pytest.fixture
def db(monkeypatch):
    calls, audits = [], []

    async def fake_fetch(sql, params):
        calls.append((sql, params))
        return [{"metric": "physicians_active", "value": 3}]

    async def fake_audit(row):
        audits.append(row)

    monkeypatch.setattr(studio_tools, "fetch_rows", fake_fetch)
    monkeypatch.setattr(studio_audit, "audit_sink", fake_audit)
    return calls, audits


def test_requires_service_token_and_actor(main, db):
    c = TestClient(main.app)
    assert c.post("/agent/tools/overview_counts", json={}).status_code == 401
    assert c.post("/agent/tools/overview_counts", json={}, headers={"X-Studio-Service-Token": SERVICE}).status_code == 401
    assert c.post("/agent/tools/overview_counts", json={}, headers=headers(role="doctor")).status_code == 403
    assert db[0] == [] and db[1] == []


def test_runs_one_tool_with_source_line_and_one_audit_row(main, db):
    calls, audits = db
    r = TestClient(main.app).post("/agent/tools/overview_counts", json={}, headers=headers())
    assert r.status_code == 200
    body = r.json()
    assert body["source"]["tool"] == "overview_counts" and len(body["source"]["query_hash"]) == 12
    assert body["rows"] == [{"metric": "physicians_active", "value": 3}] and body["mode"] == "live"
    assert len(calls) == 1
    assert len(audits) == 1 and audits[0].staff_id == STAFF and audits[0].tool == "overview_counts" and audits[0].outcome == "ok"


def test_staff_id_comes_from_the_token_not_the_body(main, db):
    calls, audits = db
    body = {"physician_id": PID, "staff_id": "attacker"}
    assert TestClient(main.app).post("/agent/tools/interventions", json=body, headers=headers()).status_code == 422
    r = TestClient(main.app).post("/agent/tools/interventions", json={"physician_id": PID, "limit": 5}, headers=headers())
    assert r.status_code == 200
    assert calls[-1][1] == (PID, PID, 5)
    assert audits[-1].staff_id == STAFF


@pytest.mark.parametrize(
    "name",
    ["plan_visualization", "write_file", "execute", "sql", "..%2fhealth", "overview_counts2", "LIST_PHYSICIANS", "ls", "task", "edit_file"],
)
def test_only_the_six_read_tools_are_reachable(main, db, name):
    r = TestClient(main.app).post(f"/agent/tools/{name}", json={}, headers=headers())
    assert r.status_code == 404
    assert db[0] == [] and db[1] == []


@pytest.mark.parametrize(
    "name,body",
    [
        ("physician_profile", {}),
        ("physician_profile", {"physician_id": "not-a-uuid"}),
        ("interventions", {"limit": 0}),
        ("interventions", {"limit": 201}),
        ("signal_snapshots", {"window_days": 366}),
        ("incident_summary", {"window_days": "x"}),
        ("incident_summary", {"sql": "select 1"}),
        ("overview_counts", {"anything": 1}),
        ("list_physicians", {"filter": {"status": "bogus"}}),
        ("list_physicians", [1, 2]),
    ],
)
def test_param_validation_rejects_before_any_read(main, db, name, body):
    r = TestClient(main.app).post(f"/agent/tools/{name}", json=body, headers=headers())
    assert r.status_code == 422 and r.json() == {"ok": False, "error": "bad_params"}
    assert db[0] == [] and db[1] == []


def test_malformed_and_oversized_bodies(main, db):
    c = TestClient(main.app)
    assert c.post("/agent/tools/overview_counts", content=b"{nope", headers=headers()).status_code == 422
    assert c.post("/agent/tools/overview_counts", json={"pad": "x" * 5000}, headers=headers()).status_code == 422
    assert c.post("/agent/tools/overview_counts", content=b"", headers=headers()).status_code == 200
    assert len(db[0]) == 1


def test_list_physicians_filter_is_passed_as_parameters(main, db):
    calls, _ = db
    r = TestClient(main.app).post(
        "/agent/tools/list_physicians", json={"filter": {"status": "active", "name_contains": "a_b%"}, "limit": 10}, headers=headers()
    )
    assert r.status_code == 200
    sql, params = calls[0]
    assert "a_b" not in sql and "active" not in sql.split("WHERE")[1]
    assert "%a\\_b\\%%" in params and params[-2:] == (10, 0)


def test_failed_read_is_audited_and_leaks_no_exception_text(main, monkeypatch, caplog):
    audits = []

    async def boom(sql, params):
        raise RuntimeError("host=db.internal.example password=hunter2")

    async def fake_audit(row):
        audits.append(row)

    monkeypatch.setattr(studio_tools, "fetch_rows", boom)
    monkeypatch.setattr(studio_audit, "audit_sink", fake_audit)
    with caplog.at_level(logging.DEBUG):
        r = TestClient(main.app).post("/agent/tools/overview_counts", json={}, headers=headers())
    assert r.status_code == 502
    assert r.json() == {"ok": False, "error": "tool_failed", "message": "The governance database read failed."}
    assert "hunter2" not in r.text and "db.internal" not in r.text
    assert "hunter2" not in caplog.text and "db.internal" not in caplog.text
    assert len(audits) == 1 and audits[0].outcome == "error" and audits[0].row_count == 0


def test_audit_failure_fails_closed_without_data(main, monkeypatch):
    async def fetch(sql, params):
        return [{"metric": "m", "value": 1}]

    async def broken_audit(row):
        raise RuntimeError("studio db password=hunter2")

    monkeypatch.setattr(studio_tools, "fetch_rows", fetch)
    monkeypatch.setattr(studio_audit, "audit_sink", broken_audit)
    r = TestClient(main.app).post("/agent/tools/overview_counts", json={}, headers=headers())
    assert r.status_code == 502
    assert "rows" not in r.json() and "hunter2" not in r.text


def test_unexpected_exception_is_a_fixed_code(main, monkeypatch):
    async def explode(*a, **k):
        raise ValueError("secret-in-message")

    from src import studio_screen

    class Bad:
        args_schema = studio_screen.SCREEN_TOOLS["overview_counts"].args_schema
        ainvoke = staticmethod(explode)

    monkeypatch.setitem(studio_screen.SCREEN_TOOLS, "overview_counts", Bad)
    r = TestClient(main.app).post("/agent/tools/overview_counts", json={}, headers=headers())
    assert r.status_code == 502 and r.json() == {"ok": False, "error": "tool_failed"}
    assert "secret-in-message" not in r.text


def test_fixture_mode_is_labelled_synthetic(main, monkeypatch):
    audits = []

    async def fake_audit(row):
        audits.append(row)

    monkeypatch.setattr(studio_audit, "audit_sink", fake_audit)
    monkeypatch.setenv("STUDIO_LIVE_READS", "0")
    r = TestClient(main.app).post("/agent/tools/overview_counts", json={}, headers=headers())
    if r.status_code == 200:  # fixture file present
        assert r.json()["synthetic"] is True and r.json()["mode"] == "fixture"
        assert audits[0].mode == "fixture"


# --- POST /agent/audit: audit rows for the app-side HTTP tools (M1-http) ---------------------


def _audit_body(**over):
    body = {"tool": "eiris_incidents", "params": {"view": "summary"}, "row_count": 4, "duration_ms": 120, "outcome": "ok"}
    body.update(over)
    return body


def test_http_audit_writes_one_metadata_row(main, db):
    c = TestClient(main.app)
    r = c.post("/agent/audit", json=_audit_body(), headers=headers())
    assert r.status_code == 200 and r.json() == {"ok": True}
    (row,) = db[1]
    assert (row.staff_id, row.tool, row.row_count, row.duration_ms, row.mode, row.outcome) == (STAFF, "eiris_incidents", 4, 120, "live", "ok")
    assert row.params_hash == studio_audit.params_hash({"view": "summary"})
    assert db[0] == []  # no database read happened


def test_http_audit_requires_auth(main, db):
    c = TestClient(main.app)
    assert c.post("/agent/audit", json=_audit_body()).status_code == 401
    assert c.post("/agent/audit", json=_audit_body(), headers=headers(role="doctor")).status_code == 403
    assert db[1] == []


@pytest.mark.parametrize(
    "over",
    [
        {"tool": "overview_counts"},
        {"tool": "sql"},
        {"row_count": -1},
        {"row_count": True},
        {"row_count": "3"},
        {"duration_ms": 10**9},
        {"outcome": "denied"},
        {"params": "x"},
        {"staff_id": "someone-else"},
    ],
)
def test_http_audit_refuses_bad_bodies(main, db, over):
    c = TestClient(main.app)
    assert c.post("/agent/audit", json=_audit_body(**over), headers=headers()).status_code == 422
    assert db[1] == []


def test_http_audit_fails_closed_when_the_sink_fails(main, db, monkeypatch):
    async def boom(row):
        raise RuntimeError("secret host name")

    monkeypatch.setattr(studio_audit, "audit_sink", boom)
    r = TestClient(main.app).post("/agent/audit", json=_audit_body(), headers=headers())
    assert r.status_code == 503 and r.json() == {"ok": False, "error": "audit_unavailable"}
    assert "secret" not in r.text


def test_http_audit_staff_id_comes_from_the_token_not_the_body(main, db):
    c = TestClient(main.app)
    c.post("/agent/audit", json=_audit_body(), headers=headers(sub="staff-9"))
    assert db[1][0].staff_id == "staff-9"
