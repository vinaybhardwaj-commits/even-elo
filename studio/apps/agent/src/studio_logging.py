"""Logging policy: ids, hashes and timings only. Never message, tool or chat content.

ContentFilter is installed on every handler (root and the uvicorn loggers) because a filter on a
logger does not see records propagated from child loggers, but a handler filter sees all of them.
A record is DROPPED when it carries content:
  * an attribute `content`, `messages`, `prompt`, `completion` or `studio_content`;
  * a LangChain message object, or a mapping/sequence holding content-bearing keys, in its args;
  * it comes from a chat/tool library at a level below WARNING (these emit prompts and payloads
    at DEBUG/INFO).
"""

from __future__ import annotations

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
    "httpx",
    "httpcore",
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


class ContentFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if any(getattr(record, attr, None) is not None for attr in CONTENT_ATTRS):
            return False
        args = record.args
        if args:
            if isinstance(args, dict):
                args = (args,)
            if any(_carries_content(a) for a in args):
                return False
        if record.levelno < logging.WARNING and record.name.startswith(CHATTY_LOGGER_PREFIXES):
            return False
        if _carries_content(record.msg):
            return False
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
