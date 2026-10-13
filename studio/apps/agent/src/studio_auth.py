"""Studio agent auth layer: the FIRST ASGI middleware, before any route or graph work.

A request is served only when ALL of these hold:
  1. X-Studio-Service-Token equals env STUDIO_SERVICE_TOKEN (constant-time compare);
  2. X-Studio-Actor is an HS256 JWT signed with env STUDIO_ACTOR_SECRET with aud
     "studio-agent", a role in ALLOWED_ROLES, exp not passed, exp - iat <= 60 s, and
     iat not more than 5 s in the future;
  3. its jti has not been seen (in-memory LRU, then the studio_nonce table, insert-or-fail);
  4. the staff id is within its token bucket (env STUDIO_RATE_PER_MIN, default 30).

Failures answer a bare JSON code. Nothing from the request is echoed or logged beyond the
staff id and the code. Cookies are never read.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import time
from collections import OrderedDict
from typing import Awaitable, Callable, Optional, Protocol

import jwt

logger = logging.getLogger("studio.auth")

AUDIENCE = "studio-agent"
MAX_LIFETIME_S = 60
IAT_SKEW_S = 5
ALLOWED_ROLES = frozenset({"super_admin"})  # M0-S2: super_admin only
HEALTH_PATH = "/agent/health"
STATE_KEY = "studio_actor"


class NonceStore(Protocol):
    async def claim(self, jti: str, exp: float) -> bool:
        """True when the jti was unseen and is now recorded; False on replay. Raises on store failure."""


class MemoryNonceStore:
    """Bounded LRU of seen jtis. Entries are pruned once their token has expired."""

    def __init__(self, max_entries: int = 10_000):
        self.max_entries = max_entries
        self._seen: "OrderedDict[str, float]" = OrderedDict()

    async def claim(self, jti: str, exp: float) -> bool:
        now = time.time()
        while self._seen:
            oldest, oldest_exp = next(iter(self._seen.items()))
            if oldest_exp < now - IAT_SKEW_S:
                self._seen.popitem(last=False)
            else:
                break
        if jti in self._seen:
            return False
        self._seen[jti] = exp
        while len(self._seen) > self.max_entries:
            self._seen.popitem(last=False)
        return True


class LayeredNonceStore:
    """In-memory LRU first (cheap replay rejection), then a durable insert-or-fail store."""

    def __init__(self, memory: NonceStore, durable: NonceStore):
        self.memory = memory
        self.durable = durable

    async def claim(self, jti: str, exp: float) -> bool:
        if not await self.memory.claim(jti, exp):
            return False
        return await self.durable.claim(jti, exp)


class PostgresNonceStore:
    """INSERT INTO studio_nonce (jti): the unique primary key makes a replay fail on any instance."""

    def __init__(self, connect: Callable[[], Awaitable["AsyncConn"]]):
        self._connect = connect

    async def claim(self, jti: str, exp: float) -> bool:
        conn = await self._connect()
        try:
            cur = await conn.execute(
                "INSERT INTO studio_nonce (jti) VALUES (%s) ON CONFLICT (jti) DO NOTHING", (jti,)
            )
            return cur.rowcount == 1
        finally:
            await conn.close()


class AsyncConn(Protocol):
    async def execute(self, query: str, params: tuple = ...): ...
    async def close(self) -> None: ...


class TokenBucket:
    """Per staff id. Capacity == refill per minute, so a burst up to the limit is allowed."""

    def __init__(self, per_minute: int, clock: Callable[[], float] = time.monotonic, max_keys: int = 5_000):
        self.per_minute = max(1, per_minute)
        self.clock = clock
        self.max_keys = max_keys
        self._state: "OrderedDict[str, tuple[float, float]]" = OrderedDict()

    def allow(self, key: str) -> bool:
        now = self.clock()
        tokens, last = self._state.pop(key, (float(self.per_minute), now))
        tokens = min(float(self.per_minute), tokens + (now - last) * self.per_minute / 60.0)
        allowed = tokens >= 1.0
        if allowed:
            tokens -= 1.0
        self._state[key] = (tokens, now)
        while len(self._state) > self.max_keys:
            self._state.popitem(last=False)
        return allowed


def rate_per_minute() -> int:
    try:
        return max(1, int(os.environ.get("STUDIO_RATE_PER_MIN", "30")))
    except ValueError:
        return 30


class Denied(Exception):
    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status = status
        self.code = code


def service_token_ok(presented: Optional[str], expected: Optional[str]) -> bool:
    if not expected or not presented:
        return False
    return hmac.compare_digest(presented.encode(), expected.encode())


def verify_actor(token: Optional[str], secret: Optional[str], now: Optional[float] = None) -> dict:
    """Return the verified claims or raise Denied(401). Does not touch the nonce store."""
    if not token or not secret:
        raise Denied(401, "bad_actor")
    try:
        claims = jwt.decode(
            token,
            secret,
            algorithms=["HS256"],
            audience=AUDIENCE,
            options={"require": ["exp", "iat", "sub", "jti", "aud"], "verify_iat": False, "verify_exp": False},
        )
    except jwt.PyJWTError:
        raise Denied(401, "bad_actor") from None
    now = time.time() if now is None else now
    try:
        exp, iat = float(claims["exp"]), float(claims["iat"])
    except (TypeError, ValueError):
        raise Denied(401, "bad_actor") from None
    if exp <= now:
        raise Denied(401, "expired")
    if iat > now + IAT_SKEW_S:
        raise Denied(401, "future_iat")
    if exp - iat > MAX_LIFETIME_S:
        raise Denied(401, "lifetime")
    if not isinstance(claims["sub"], str) or not claims["sub"] or not isinstance(claims["jti"], str) or not claims["jti"]:
        raise Denied(401, "bad_actor")
    if claims.get("role") not in ALLOWED_ROLES:
        raise Denied(403, "role")
    return claims


class StudioAuthMiddleware:
    """Pure ASGI (no response buffering, so SSE streams untouched)."""

    def __init__(
        self,
        app,
        *,
        nonce_store: Optional[NonceStore] = None,
        bucket: Optional[TokenBucket] = None,
        service_token: Callable[[], Optional[str]] = lambda: os.environ.get("STUDIO_SERVICE_TOKEN"),
        actor_secret: Callable[[], Optional[str]] = lambda: os.environ.get("STUDIO_ACTOR_SECRET"),
    ):
        self.app = app
        self.nonce_store = nonce_store or MemoryNonceStore()
        self.bucket = bucket or TokenBucket(rate_per_minute())
        self._service_token = service_token
        self._actor_secret = actor_secret

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            return await self.app(scope, receive, send)
        if scope["type"] != "http":
            # No websockets here. Close before any app code runs.
            if scope["type"] == "websocket":
                await receive()
                await send({"type": "websocket.close", "code": 1008})
            return
        try:
            claims = await self._authenticate(scope)
        except Denied as d:
            return await self._reject(send, d.status, d.code)
        except Exception:  # nonce store / unexpected failure: fail closed
            logger.warning("auth failure: nonce store unavailable")
            return await self._reject(send, 503, "auth_unavailable")
        scope.setdefault("state", {})[STATE_KEY] = {"staff_id": claims["sub"], "role": claims["role"], "jti": claims["jti"]}
        return await self.app(scope, receive, send)

    async def _authenticate(self, scope) -> dict:
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        if not service_token_ok(headers.get("x-studio-service-token"), self._service_token()):
            raise Denied(401, "bad_service_token")
        claims = verify_actor(headers.get("x-studio-actor"), self._actor_secret())
        if not await self.nonce_store.claim(claims["jti"], float(claims["exp"])):
            raise Denied(401, "replay")
        if scope.get("path") != HEALTH_PATH and not self.bucket.allow(claims["sub"]):
            raise Denied(429, "rate_limited")
        return claims

    async def _reject(self, send, status: int, code: str):
        body = json.dumps({"ok": False, "error": code}).encode()
        extra = [(b"retry-after", b"60")] if status == 429 else []
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()), *extra],
            }
        )
        await send({"type": "http.response.body", "body": body})
