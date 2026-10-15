import importlib
import sys
import time
import uuid

import jwt
import pytest
from fastapi.testclient import TestClient

SERVICE = "svc-token-not-real"
SECRET = "actor-secret-not-real-0123456789abcdef"


@pytest.fixture
def main(monkeypatch):
    monkeypatch.setenv("STUDIO_SERVICE_TOKEN", SERVICE)
    monkeypatch.setenv("STUDIO_ACTOR_SECRET", SECRET)
    sys.modules.pop("main", None)
    mod = importlib.import_module("main")
    yield mod
    sys.modules.pop("main", None)


def actor(sub="staff-1", **over):
    now = int(time.time())
    claims = {"sub": sub, "role": "super_admin", "aud": "studio-agent", "iat": now, "exp": now + 45, "jti": uuid.uuid4().hex, **over}
    return jwt.encode(claims, SECRET, algorithm="HS256")


def headers(token=None, **kw):
    return {"X-Studio-Service-Token": SERVICE, "X-Studio-Actor": token or actor(**kw)}


BODY = {"threadId": "t1", "runId": "r1", "state": {}, "messages": [], "tools": [], "context": [], "forwardedProps": {}}


class FakeAgent:
    def __init__(self):
        self.runs = []
        self.config = {}

    def clone(self):
        c = FakeAgent()
        c.runs = self.runs
        return c

    async def run(self, input_data):
        self.runs.append((self.config, input_data.thread_id))
        if False:
            yield


def test_surface_is_only_agent_routes_and_no_docs(main):
    paths = {r.path for r in main.app.routes}
    assert paths == {"/agent", "/agent/health"}
    c = TestClient(main.app)
    for p in ("/docs", "/openapi.json", "/redoc", "/health", "/"):
        assert c.get(p).status_code == 401  # auth runs before routing, even for unknown paths


def test_health_requires_both_credentials(main):
    c = TestClient(main.app)
    assert c.get("/agent/health").status_code == 401
    assert c.get("/agent/health", headers=headers()).status_code == 200


def test_staff_id_and_scoped_thread_reach_the_graph_config(main):
    fake = FakeAgent()
    main.app.state.studio_agent = fake
    c = TestClient(main.app)
    r = c.post("/agent", json=BODY, headers=headers(sub="staff-9"))
    assert r.status_code == 200
    config, thread = fake.runs[0]
    assert config == {"configurable": {"studio_staff_id": "staff-9"}}
    assert thread == "staff-9:t1"
    # A client echoing the scoped id back does not double-prefix; someone else's id cannot be reused.
    c.post("/agent", json={**BODY, "threadId": "staff-9:t1"}, headers=headers(sub="staff-9"))
    c.post("/agent", json={**BODY, "threadId": "staff-9:t1"}, headers=headers(sub="staff-2"))
    assert fake.runs[1][1] == "staff-9:t1"
    assert fake.runs[2][1] == "staff-2:staff-9:t1"


def test_forwardedprops_cannot_inject_a_staff_id(main):
    fake = FakeAgent()
    main.app.state.studio_agent = fake
    body = {**BODY, "forwardedProps": {"studio_staff_id": "attacker", "configurable": {"studio_staff_id": "attacker"}}}
    TestClient(main.app).post("/agent", json=body, headers=headers(sub="staff-1"))
    assert fake.runs[0][0] == {"configurable": {"studio_staff_id": "staff-1"}}


def test_unauthenticated_post_never_reaches_the_graph(main):
    fake = FakeAgent()
    main.app.state.studio_agent = fake
    c = TestClient(main.app)
    assert c.post("/agent", json=BODY).status_code == 401
    assert c.post("/agent", json=BODY, headers={"X-Studio-Service-Token": SERVICE}).status_code == 401
    assert c.post("/agent", content=b"not json", headers=headers()).status_code in (400, 422)
    assert fake.runs == []


def test_governance_tools_are_registered_and_no_write_tool_exists(main):
    names = {t.name for t in main.TOOLS}
    assert {"list_physicians", "physician_profile", "signal_snapshots", "interventions", "incident_summary", "overview_counts"} <= names
    assert not any(w in n for n in names for w in ("write", "update", "delete", "insert", "create"))
