import io
import logging

from langchain_core.messages import AIMessage, ToolMessage

from src.studio_logging import ContentFilter, configure_logging, log_level


def capture(name="studio.test"):
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.addFilter(ContentFilter())
    logger = logging.getLogger(name)
    logger.handlers = [handler]
    logger.propagate = False
    logger.setLevel(logging.DEBUG)
    return logger, stream


def test_ids_hashes_and_timings_pass():
    logger, out = capture()
    logger.info("tool=%s staff=%s rows=%d ms=%d hash=%s", "list_physicians", "staff-1", 3, 12, "abc123")
    assert "tool=list_physicians staff=staff-1 rows=3 ms=12" in out.getvalue()


def test_records_carrying_message_content_are_dropped():
    logger, out = capture()
    logger.info("got %s", ToolMessage(content="patient secret", tool_call_id="x"))
    logger.info("got %s", AIMessage(content="answer text"))
    logger.info("payload %s", {"messages": [{"content": "hello"}]})
    logger.info("payload %s", {"result": "rows..."})
    logger.info("tool output", extra={"content": "row data"})
    logger.info("run", extra={"studio_content": True})
    logger.warning({"content": "x"})
    logger.info("list %s", [ToolMessage(content="c", tool_call_id="y")])
    assert out.getvalue() == ""


def test_chat_and_tool_libraries_are_silenced_below_warning_only():
    for name in ("langchain_core.callbacks", "langgraph.pregel", "ag_ui_langgraph.agent", "copilotkit.x", "httpx", "deepagents.graph"):
        logger, out = capture(name)
        logger.debug("prompt: %s", "text that could be anything")
        logger.info("tool call args %s", "x")
        logger.warning("retrying after timeout")
        assert out.getvalue().count("\n") == 1, name  # only the WARNING survives


def test_filter_reaches_propagated_records_through_the_handler():
    root = logging.getLogger()
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    root.addHandler(handler)
    try:
        configure_logging()
        assert any(isinstance(f, ContentFilter) for f in handler.filters)
        configure_logging()  # idempotent
        assert sum(isinstance(f, ContentFilter) for f in handler.filters) == 1
        logging.getLogger("some.child").warning("x %s", ToolMessage(content="secret", tool_call_id="z"))
        logging.getLogger("some.child").warning("ok id=%s", "abc")
        assert "secret" not in stream.getvalue() and "ok id=abc" in stream.getvalue()
    finally:
        root.removeHandler(handler)


def test_level_comes_from_studio_log_level(monkeypatch):
    assert log_level() == logging.INFO
    monkeypatch.setenv("STUDIO_LOG_LEVEL", "debug")
    assert log_level() == logging.DEBUG
    monkeypatch.setenv("STUDIO_LOG_LEVEL", "nonsense")
    assert log_level() == logging.INFO
    monkeypatch.setenv("STUDIO_LOG_LEVEL", "WARNING")
    root = logging.getLogger()
    old = root.level
    try:
        configure_logging()
        assert root.level == logging.WARNING
    finally:
        root.setLevel(old)
