"""Role x tool matrix for the agent (gov/role-parity). tests/access_matrix.json is pinned against the TS table too
(apps/app/src/lib/zone/__tests__/role-matrix.test.ts), so the two cannot drift."""

import asyncio
import json
import pathlib
import time
import uuid

import jwt
import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import ToolMessage

from src import studio_access as acc
from src import studio_screen, studio_tools
from src.studio_auth import AUDIENCE, Denied, verify_actor

MATRIX = json.loads((pathlib.Path(__file__).parent / "access_matrix.json").read_text())
PERSONAS = MATRIX["personas"]
SECRET = "actor-secret-0123456789abcdef0123456789"


def roles_of(persona):
    return acc.parse_roles(PERSONAS[persona])


def test_screen_matrix():
    for screen, allowed in MATRIX["screens"].items():
        for persona in PERSONAS:
            assert acc.can_access_screen(roles_of(persona), screen) == (persona in allowed), (screen, persona)


def test_tool_matrix_and_unknown_tools_refused():
    for tool, allowed in MATRIX["tools"].items():
        for persona in PERSONAS:
            assert acc.can_use_tool(roles_of(persona), tool) == (persona in allowed), (tool, persona)
    assert MATRIX["tools"]["not_a_tool"] == [] and MATRIX["tools"]["migrate_db"] == []


def test_role_claim_parsing_fails_closed():
    assert acc.parse_roles("super_admin") == {"super_admin"}  # older single-role shape
    for bad in (None, "", "doctor", "staff,doctor", "site_head", 5, ["staff"]):
        assert acc.parse_roles(bad) is None, bad
    assert not acc.can_use_tool(None, "overview_counts") and not acc.can_use_tool([], "plan_visualization")


def token(role):
    now = int(time.time())
    return jwt.encode({"sub": "s", "role": role, "aud": AUDIENCE, "iat": now, "exp": now + 45, "jti": uuid.uuid4().hex}, SECRET, algorithm="HS256")


def test_actor_jwt_admits_every_known_role_combination_and_rejects_unknown():
    for persona, role in PERSONAS.items():
        assert verify_actor(token(role), SECRET)["role"] == role
    for bad in ("doctor", "staff,doctor", ""):
        with pytest.raises(Denied):
            verify_actor(token(bad), SECRET)


def test_screen_door_refuses_a_tool_the_role_may_not_use():
    # Every governance read tool is open to every active staff member today; the door still checks per tool.
    for persona in PERSONAS:
        status, body = asyncio.run(studio_screen.run_screen_tool("not_a_tool", {}, "s", roles_of(persona)))
        assert status == 404
    status, body = asyncio.run(studio_screen.run_screen_tool("overview_counts", {}, "s", []))
    assert (status, body) == (403, {"ok": False, "error": "forbidden"})
    status, body = asyncio.run(studio_screen.run_screen_tool("overview_counts", {}, "s", None))
    assert status == 403


def test_http_audit_door_refuses_rows_for_tools_the_role_cannot_run():
    row = {"tool": "surgical_write", "params": {}, "row_count": 0, "duration_ms": 1, "outcome": "ok"}
    for persona in PERSONAS:
        status, _ = asyncio.run(studio_screen.record_http_audit(row, "s", roles_of(persona)))
        assert (status == 403) == (persona != "super_admin"), persona


class Req:
    def __init__(self, name, tools=()):
        self.tool_call = {"name": name, "id": "c1"}
        self.tools = list(tools)

    def override(self, **kw):
        out = Req(self.tool_call["name"], kw.get("tools", self.tools))
        return out


class FakeTool:
    def __init__(self, name):
        self.name = name


def with_roles(monkeypatch, persona):
    monkeypatch.setattr(studio_tools, "_roles_from_run", lambda: roles_of(persona) if persona else frozenset())


@pytest.mark.parametrize("persona", [*PERSONAS, None])
def test_chat_gate_hides_and_refuses_disallowed_tools(monkeypatch, persona):
    with_roles(monkeypatch, persona)
    gate = studio_tools.RoleToolGate()
    names = ["plan_visualization", "write_todos", "overview_counts", "eiris_incidents", "surgical_vcs", "audit_findings", "admin_users", "onboarding_pipeline"]
    kept = []

    async def model_handler(req):
        kept.extend(t.name for t in req.tools)
        return "ok"

    asyncio.run(gate.awrap_model_call(Req("x", [FakeTool(n) for n in names]), model_handler))
    roles = roles_of(persona) if persona else frozenset()
    for n in names:
        gated = acc.screen_for_tool(n) is not None
        expect = (not gated) or acc.can_use_tool(roles, n)
        assert (n in kept) == expect, (persona, n)

    async def tool_handler(req):
        return ToolMessage(content="RAN", name=req.tool_call["name"], tool_call_id="c1")

    for n in names:
        res = asyncio.run(gate.awrap_tool_call(Req(n), tool_handler))
        gated = acc.screen_for_tool(n) is not None
        should_run = (not gated) or acc.can_use_tool(roles, n)
        assert (res.content == "RAN") == should_run, (persona, n)
        if not should_run:
            assert res.status == "error"
