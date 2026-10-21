"""M3-surgical: the app-side surgical tools report to POST /agent/audit; the agent itself has no surgical tool."""

import importlib
import sys
import time
import uuid

import jwt
import pytest
from fastapi.testclient import TestClient

from src import studio_audit, studio_tools
from src.prompt import SYSTEM_PROMPT

SERVICE = "svc-token-not-real"
SECRET = "actor-secret-not-real-0123456789abcdef"
STAFF = "staff-7"

SURGICAL_READS = [
    "surgical_overview",
    "surgical_leaderboard",
    "surgical_vcs",
    "surgical_vc_detail",
    "surgical_cases",
    "surgical_streams",
    "surgical_weights",
    "surgical_positions",
    "surgical_audit_log",
]


@pytest.fixture
def main(monkeypatch):
    monkeypatch.setenv("STUDIO_SERVICE_TOKEN", SERVICE)
    monkeypatch.setenv("STUDIO_ACTOR_SECRET", SECRET)
    sys.modules.pop("main", None)
    mod = importlib.import_module("main")
    yield mod
    sys.modules.pop("main", None)


def headers(role="super_admin"):
    now = int(time.time())
    claims = {"sub": STAFF, "role": role, "aud": "studio-agent", "iat": now, "exp": now + 45, "jti": uuid.uuid4().hex}
    return {"X-Studio-Service-Token": SERVICE, "X-Studio-Actor": jwt.encode(claims, SECRET, algorithm="HS256")}


@pytest.fixture
def audits(monkeypatch):
    rows = []

    async def fake_audit(row):
        rows.append(row)

    async def no_db(sql, params):
        raise AssertionError("surgical audit must not touch the governance database")

    monkeypatch.setattr(studio_audit, "audit_sink", fake_audit)
    monkeypatch.setattr(studio_tools, "fetch_rows", no_db)
    return rows


def body(tool, **over):
    b = {"tool": tool, "params": {"vc_id": "x"}, "row_count": 3, "duration_ms": 50, "outcome": "ok"}
    b.update(over)
    return b


@pytest.mark.parametrize("tool", SURGICAL_READS + ["surgical_write"])
def test_surgical_tools_land_one_metadata_audit_row(main, audits, tool):
    r = TestClient(main.app).post("/agent/audit", json=body(tool), headers=headers())
    assert r.status_code == 200
    (row,) = audits
    assert (row.staff_id, row.tool, row.mode) == (STAFF, tool, "live")
    assert row.params_hash == studio_audit.params_hash({"vc_id": "x"})


@pytest.mark.parametrize("tool", ["surgical_sql", "surgical_delete", "surgical_", "SURGICAL_WRITE"])
def test_unlisted_surgical_names_are_refused(main, audits, tool):
    assert TestClient(main.app).post("/agent/audit", json=body(tool), headers=headers()).status_code == 422
    assert audits == []


def test_surgical_audit_needs_the_actor_token(main, audits):
    c = TestClient(main.app)
    assert c.post("/agent/audit", json=body("surgical_vcs")).status_code == 401
    assert c.post("/agent/audit", json=body("surgical_vcs"), headers=headers(role="doctor")).status_code == 403
    assert audits == []


def test_agent_has_no_surgical_tool_and_cannot_be_asked_to_screen_one(main, audits):
    assert not [t for t in studio_tools.__dict__ if t.startswith("surgical")]
    r = TestClient(main.app).post("/agent/tools/surgical_vcs", json={}, headers=headers())
    assert r.status_code in (404, 422)
    assert audits == []


def test_prompt_tells_the_model_it_cannot_write():
    assert "surgical_vc_detail" in SYSTEM_PROMPT
    assert "cannot change this data" in SYSTEM_PROMPT
