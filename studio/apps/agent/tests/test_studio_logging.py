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


def test_chatty_libraries_are_dropped_below_warning_and_fully_sanitised_above():
    for name in ("langchain_core.callbacks", "langgraph.pregel", "ag_ui_langgraph.agent", "copilotkit.x", "httpx", "deepagents.graph", "uvicorn.error"):
        logger, out = capture(name)
        logger.debug("prompt: %s", "text that could be anything")
        logger.info("tool call args %s", "x")
        assert out.getvalue() == "", name
        logger.warning("retrying with %s", "PHYSICIAN NAME Dr Sample")
        logger.error("boom %r", "tool args {'name': 'Dr Sample'}")
        text = out.getvalue()
        assert text.count("\n") == 2 and "details suppressed" in text, name
        assert "Dr Sample" not in text and "PHYSICIAN" not in text and "retrying" not in text


def test_ag_ui_resume_and_tool_args_records_are_sanitised():
    """The exact shapes at ag_ui_langgraph/agent.py:572 (WARNING) and :783 (ERROR)."""
    logger, out = capture("ag_ui_langgraph.agent")
    logger.warning(
        "failed to parse resume_input as JSON, treating as string (thread_id=%r, run_id=%r, error=%s): %r",
        "staff-1:t1", "run-1", "Expecting value: line 1 column 1", '{"resume": "list physicians named Dr Sample with ...',
    )
    logger.error(
        "Resetting tool_call args after JSON decode failure (tool_call_id=%r, error=%s): %r",
        "call_1", "Unterminated string", '{"filter": {"name_contains": "Sample Physician"',
    )
    text = out.getvalue()
    assert "Sample" not in text and "resume" not in text and "Expecting" not in text and "call_1" not in text
    assert text.count("details suppressed") == 2


def test_exception_text_and_tracebacks_never_emitted_only_class_and_hash():
    for name in ("uvicorn.error", "studio.test", "ag_ui_langgraph.agent"):
        logger, out = capture(name)
        try:
            raise ValueError("secret physician list: Dr Sample")
        except ValueError:
            logger.exception("Exception in ASGI application")
        text = out.getvalue()
        assert "Traceback" not in text and "Dr Sample" not in text and "secret" not in text, name
        assert "exc=ValueError hash=" in text, name


def test_same_exception_text_gives_the_same_hash_for_correlation():
    import re

    hashes = []
    for _ in range(2):
        logger, out = capture("studio.test")
        try:
            raise KeyError("same text")
        except KeyError:
            logger.exception("failed")
        hashes.append(re.search(r"hash=([0-9a-f]{12})", out.getvalue()).group(1))
    assert hashes[0] == hashes[1]


def test_uvicorn_access_log_drops_the_query_string():
    logger, out = capture("uvicorn.access")
    logger.info('%s - "%s %s HTTP/%s" %d', "127.0.0.1:1", "GET", "/agent/health?name=Dr+Sample&x=1", "1.1", 200)
    text = out.getvalue()
    assert "/agent/health" in text and "?" not in text and "Sample" not in text


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
