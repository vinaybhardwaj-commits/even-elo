import json
import time

import jwt
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from src.studio_auth import (
    AUDIENCE,
    LayeredNonceStore,
    MemoryNonceStore,
    StudioAuthMiddleware,
    TokenBucket,
)

SERVICE = "svc-token-not-real"
SECRET = "actor-secret-not-real-0123456789abcdef"


def actor(now=None, **over):
    now = int(now or time.time())
    claims = {"sub": "staff-1", "role": "super_admin", "aud": AUDIENCE, "iat": now, "exp": now + 45, "jti": f"jti-{time.monotonic_ns()}"}
    claims.update(over)
    claims = {k: v for k, v in claims.items() if v is not None}
    return jwt.encode(claims, SECRET, algorithm="HS256")


def make_client(**kw):
    app = FastAPI()
    seen = []

    # Pass-through route that records that app code ran and what the middleware set.
    @app.post("/agent")
    async def run(request: Request):
        seen.append(request.scope["state"]["studio_actor"])
        return {"ok": True}

    @app.get("/agent/health")
    async def health():
        return {"status": "ok"}

    app.add_middleware(
        StudioAuthMiddleware,
        service_token=lambda: SERVICE,
        actor_secret=lambda: SECRET,
        **kw,
    )
    return TestClient(app), seen


def h(token=None, service=SERVICE):
    headers = {}
    if service is not None:
        headers["X-Studio-Service-Token"] = service
    if token is not None:
        headers["X-Studio-Actor"] = token
    return headers


def test_valid_request_reaches_the_app_with_actor_in_scope():
    client, seen = make_client()
    r = client.post("/agent", headers=h(actor()))
    assert r.status_code == 200 and seen == [{"staff_id": "staff-1", "role": "super_admin", "jti": seen[0]["jti"]}]


def test_no_token_at_all():
    client, seen = make_client()
    assert client.post("/agent").status_code == 401
    assert client.post("/agent", headers=h(actor(), service=None)).status_code == 401
    assert client.post("/agent", headers=h(None)).status_code == 401
    assert seen == []


def test_bad_service_token():
    client, seen = make_client()
    r = client.post("/agent", headers=h(actor(), service="wrong"))
    assert r.status_code == 401 and seen == []
    assert r.json() == {"ok": False, "error": "bad_service_token"}


def test_unconfigured_service_token_fails_closed():
    app = FastAPI()

    @app.post("/agent")
    async def run():
        return {}

    app.add_middleware(StudioAuthMiddleware, service_token=lambda: None, actor_secret=lambda: SECRET)
    c = TestClient(app)
    assert c.post("/agent", headers={"X-Studio-Service-Token": "", "X-Studio-Actor": actor()}).status_code == 401
    assert c.post("/agent", headers=h(actor(), service="anything")).status_code == 401


def test_bad_signature_wrong_alg_and_garbage():
    client, seen = make_client()
    now = int(time.time())
    forged = jwt.encode({"sub": "s", "role": "super_admin", "aud": AUDIENCE, "iat": now, "exp": now + 30, "jti": "x"}, "other-secret-0123456789abcdef0123", algorithm="HS256")
    other_alg = jwt.encode({"sub": "s", "role": "super_admin", "aud": AUDIENCE, "iat": now, "exp": now + 30, "jti": "y"}, SECRET + "0" * 20, algorithm="HS384")
    unsigned = jwt.encode({"sub": "s", "role": "super_admin", "aud": AUDIENCE, "iat": now, "exp": now + 30, "jti": "z"}, None, algorithm="none")
    for token in (forged, other_alg, unsigned, "garbage"):
        assert client.post("/agent", headers=h(token)).status_code == 401
    assert seen == []


def test_wrong_audience_and_missing_claims():
    client, seen = make_client()
    assert client.post("/agent", headers=h(actor(aud="someone-else"))).status_code == 401
    assert client.post("/agent", headers=h(actor(aud=None))).status_code == 401
    for claim in ("sub", "jti", "exp", "iat"):
        assert client.post("/agent", headers=h(actor(**{claim: None}))).status_code == 401, claim
    assert seen == []


def test_expired():
    client, _ = make_client()
    now = int(time.time())
    r = client.post("/agent", headers=h(actor(iat=now - 100, exp=now - 10)))
    assert r.status_code == 401 and r.json()["error"] == "expired"


def test_future_iat_beyond_skew_but_not_within():
    client, _ = make_client()
    now = int(time.time())
    far = client.post("/agent", headers=h(actor(iat=now + 30, exp=now + 60)))
    assert far.status_code == 401 and far.json()["error"] == "future_iat"
    near = client.post("/agent", headers=h(actor(iat=now + 3, exp=now + 40)))
    assert near.status_code == 200


def test_lifetime_over_60_seconds():
    client, _ = make_client()
    now = int(time.time())
    assert client.post("/agent", headers=h(actor(iat=now, exp=now + 61))).status_code == 401
    assert client.post("/agent", headers=h(actor(iat=now, exp=now + 60))).status_code == 200


def test_role_must_be_super_admin():
    client, seen = make_client()
    assert client.post("/agent", headers=h(actor(role="site_head"))).status_code == 403
    assert client.post("/agent", headers=h(actor(role=None))).status_code == 403
    assert seen == []


def test_replay_same_jti_twice():
    client, seen = make_client()
    token = actor(jti="fixed-jti")
    assert client.post("/agent", headers=h(token)).status_code == 200
    again = client.post("/agent", headers=h(token))
    assert again.status_code == 401 and again.json()["error"] == "replay"
    assert len(seen) == 1


class RecordingDurable:
    def __init__(self, fail=False, taken=()):
        self.claims, self.fail, self.taken = [], fail, set(taken)

    async def claim(self, jti, exp):
        if self.fail:
            raise RuntimeError("db down")
        self.claims.append(jti)
        if jti in self.taken:
            return False
        self.taken.add(jti)
        return True


def test_replay_detected_by_durable_store_on_another_instance():
    durable = RecordingDurable(taken={"seen-elsewhere"})
    client, seen = make_client(nonce_store=LayeredNonceStore(MemoryNonceStore(), durable))
    r = client.post("/agent", headers=h(actor(jti="seen-elsewhere")))
    assert r.status_code == 401 and r.json()["error"] == "replay" and seen == []
    assert client.post("/agent", headers=h(actor(jti="fresh"))).status_code == 200
    assert durable.claims == ["seen-elsewhere", "fresh"]


def test_nonce_store_failure_fails_closed():
    client, seen = make_client(nonce_store=LayeredNonceStore(MemoryNonceStore(), RecordingDurable(fail=True)))
    r = client.post("/agent", headers=h(actor()))
    assert r.status_code == 503 and seen == []


def test_memory_store_is_bounded_lru():
    import asyncio

    store = MemoryNonceStore(max_entries=3)
    far = time.time() + 600

    async def go():
        for i in range(5):
            assert await store.claim(f"j{i}", far)
        assert len(store._seen) == 3
        assert not await store.claim("j4", far)  # newest still remembered

    asyncio.run(go())


def test_rate_limit_per_staff_id():
    clock = [0.0]
    client, seen = make_client(bucket=TokenBucket(3, clock=lambda: clock[0]))
    codes = [client.post("/agent", headers=h(actor(sub="a"))).status_code for _ in range(5)]
    assert codes == [200, 200, 200, 429, 429]
    assert client.post("/agent", headers=h(actor(sub="b"))).status_code == 200  # other staff unaffected
    clock[0] += 20.0  # 1 token refilled (3/min)
    assert client.post("/agent", headers=h(actor(sub="a"))).status_code == 200
    r = client.post("/agent", headers=h(actor(sub="a")))
    assert r.status_code == 429 and r.headers["retry-after"] == "60"


def test_rate_limit_env_default_is_30(monkeypatch):
    from src.studio_auth import rate_per_minute

    assert rate_per_minute() == 30
    monkeypatch.setenv("STUDIO_RATE_PER_MIN", "7")
    assert rate_per_minute() == 7
    monkeypatch.setenv("STUDIO_RATE_PER_MIN", "nope")
    assert rate_per_minute() == 30


def test_health_needs_the_service_token_too():
    client, _ = make_client()
    assert client.get("/agent/health").status_code == 401
    assert client.get("/agent/health", headers=h(None)).status_code == 401  # service token alone is not enough
    assert client.get("/agent/health", headers=h(actor())).status_code == 200


def test_health_does_not_consume_rate_budget():
    client, _ = make_client(bucket=TokenBucket(1))
    for _ in range(3):
        assert client.get("/agent/health", headers=h(actor(sub="a"))).status_code == 200
    assert client.post("/agent", headers=h(actor(sub="a"))).status_code == 200


def test_rejection_body_reveals_nothing():
    client, _ = make_client()
    r = client.post("/agent", headers=h("garbage"))
    assert set(json.loads(r.text)) == {"ok", "error"}
    assert "garbage" not in r.text


def test_cookies_are_ignored():
    client, seen = make_client()
    client.cookies.set("epi_session", "x")
    r = client.post("/agent", headers=h(None))
    assert r.status_code == 401 and seen == []
