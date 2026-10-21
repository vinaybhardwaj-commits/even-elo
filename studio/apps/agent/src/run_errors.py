"""Map a failed agent run to a fixed AG-UI RUN_ERROR. Codes only: never exception text."""

from __future__ import annotations

import psycopg
import psycopg_pool
from ag_ui.core import EventType, RunErrorEvent

DATA_UNAVAILABLE = "data_unavailable"
AGENT_ERROR = "agent_error"

_MESSAGES = {
    DATA_UNAVAILABLE: "The governance data source is unavailable.",
    AGENT_ERROR: "The agent run failed.",
}


def _chain(exc: BaseException):
    seen: set[int] = set()
    stack = [exc]
    while stack:
        e = stack.pop()
        if e is None or id(e) in seen:
            continue
        seen.add(id(e))
        yield e
        stack.extend([e.__cause__, e.__context__, *getattr(e, "exceptions", ())])


def classify(exc: BaseException) -> str:
    """data_unavailable for connection-level database failures (anywhere in the cause chain)."""
    for e in _chain(exc):
        if isinstance(e, (psycopg.OperationalError, psycopg_pool.PoolTimeout, psycopg_pool.PoolClosed)):
            return DATA_UNAVAILABLE
    return AGENT_ERROR


def run_error_event(exc: BaseException) -> RunErrorEvent:
    code = classify(exc)
    return RunErrorEvent(type=EventType.RUN_ERROR, message=_MESSAGES[code], code=code)
