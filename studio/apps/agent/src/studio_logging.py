"""Logging policy: ids, hashes and timings only. Never message, tool or chat content.

ContentFilter is installed on every handler (root and the uvicorn loggers) because a filter on a
logger does not see records propagated from child loggers, but a handler filter sees all of them.

  * Records from chat/tool libraries (CHATTY_LOGGER_PREFIXES) are DROPPED below WARNING and
    REWRITTEN at WARNING and above: their message and args are replaced by a fixed text, so no
    argument (resume payload, tool-call args excerpt, exception text) can be emitted.
  * Any record carrying content (attributes, LangChain messages, content-keyed args) is dropped.
  * Exception text and tracebacks are never emitted by any logger: only the exception class and a
    short hash of its text (so repeated errors can be correlated without revealing them).
  * uvicorn.access loses its query string.
"""

from __future__ import annotations

import hashlib
import logging
import os
from typing import Any

from langchain_core.messages import BaseMessage

CONTENT_ATTRS = ("content", "messages", "prompt", "completion", "studio_content")
CONTENT_KEYS = frozenset({"content", "messages", "text", "prompt", "completion", "arguments", "args", "result", "output", "input"})
CHATTY_LOGGER_PREFIXES = (
    "langchain",
    "langgraph",
    "deepagents",
    "ag_ui",
    "copilotkit",
    "uvicorn.error",
    "httpx",
    "httpcore",
    "psycopg",  # psycopg.pool logs "error connecting in %r: %s" with server host and user
    "openai",
    "anthropic",
)


def _carries_content(value: Any, depth: int = 0) -> bool:
    if isinstance(value, BaseMessage):
        return True
    if depth > 3:
        return False
    if isinstance(value, dict):
        return any(k in CONTENT_KEYS for k in value) or any(_carries_content(v, depth + 1) for v in value.values())
    if isinstance(value, (list, tuple, set)):
        return any(_carries_content(v, depth + 1) for v in value)
    return False


def _exc_summary(record: logging.LogRecord) -> str:
    exc = record.exc_info[1] if record.exc_info else None
    if exc is None:
        return ""
    digest = hashlib.sha256(str(exc).encode("utf-8", "replace")).hexdigest()[:12]
    return f" [exc={type(exc).__name__} hash={digest}]"


def _strip_query(args: Any) -> Any:
    if isinstance(args, tuple) and len(args) >= 3 and isinstance(args[2], str):
        return args[:2] + (args[2].split("?", 1)[0],) + args[3:]
    return args


class ContentFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if any(getattr(record, attr, None) is not None for attr in CONTENT_ATTRS):
            return False
        chatty = record.name.startswith(CHATTY_LOGGER_PREFIXES)
        if chatty and record.levelno < logging.WARNING:
            return False
        if record.name == "uvicorn.access":
            record.args = _strip_query(record.args)
        elif chatty:
            # Fixed text only: the original message and args may embed payloads or exception text.
            suffix = _exc_summary(record)
            record.msg, record.args = f"{record.name} {record.levelname.lower()} (details suppressed){suffix}", None
            record.exc_info = record.exc_text = record.stack_info = None
            return True
        args = record.args
        if args:
            if isinstance(args, dict):
                args = (args,)
            if any(_carries_content(a) for a in args):
                return False
        if _carries_content(record.msg):
            return False
        if record.exc_info or record.exc_text:
            suffix = _exc_summary(record)
            record.msg = f"{record.getMessage()}{suffix}"
            record.args = None
            record.exc_info = record.exc_text = record.stack_info = None
        return True


def log_level() -> int:
    name = os.environ.get("STUDIO_LOG_LEVEL", "INFO").strip().upper()
    level = logging.getLevelName(name)
    return level if isinstance(level, int) else logging.INFO


def configure_logging() -> None:
    """Idempotent. Level from STUDIO_LOG_LEVEL (default INFO); content filter on every handler."""
    root = logging.getLogger()
    if not root.handlers:
        logging.basicConfig(format="%(asctime)s %(levelname)s %(name)s %(message)s")
    root.setLevel(log_level())
    install_filter()


def install_filter() -> None:
    names = ["", "uvicorn", "uvicorn.error", "uvicorn.access", "fastapi"]
    seen: set[int] = set()
    for name in names:
        for handler in logging.getLogger(name).handlers:
            if id(handler) in seen:
                continue
            seen.add(id(handler))
            if not any(isinstance(f, ContentFilter) for f in handler.filters):
                handler.addFilter(ContentFilter())
