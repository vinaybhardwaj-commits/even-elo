"""Agent code must not import OpenAI, LangSmith, or BYOK credential plumbing."""

import ast
from pathlib import Path

AGENT_ROOT = Path(__file__).resolve().parents[1]
BANNED_IMPORTS = ("openai", "langchain_openai", "langsmith")


def agent_files():
    files = [AGENT_ROOT / "main.py", *(AGENT_ROOT / "src").rglob("*.py"), *(AGENT_ROOT / "tests").rglob("*.py")]
    return [f for f in files if f.name != Path(__file__).name]


def test_no_openai_or_langsmith_imports():
    offenders = []
    for path in agent_files():
        for node in ast.walk(ast.parse(path.read_text())):
            names = []
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                names = [node.module]
            for name in names:
                if name.split(".")[0] in BANNED_IMPORTS:
                    offenders.append(f"{path.name}: {name}")
    assert offenders == []


def test_no_openai_or_langsmith_dependencies_declared():
    text = (AGENT_ROOT / "pyproject.toml").read_text().lower()
    for name in ("openai", "langsmith"):
        assert name not in text


def test_no_byok_headers_or_chat_latest_default():
    for path in (AGENT_ROOT / "main.py", *(AGENT_ROOT / "src").rglob("*.py")):
        text = path.read_text().lower()
        assert "x-openai-api-key" not in text, path.name
        assert "x-jev-api-key" not in text, path.name
        assert "chat-latest" not in text, path.name


def test_agent_tools_list_is_planning_plus_read_only_governance():
    import importlib
    import sys

    sys.modules.pop("main", None)
    try:
        main = importlib.import_module("main")
        assert [t.name for t in main.TOOLS] == [
            "plan_visualization",
            "list_physicians",
            "physician_profile",
            "signal_snapshots",
            "interventions",
            "incident_summary",
            "overview_counts",
            "physician_privileges",
            "physician_oppe",
            "physician_metrics",
            "physician_qualifications",
            "capture_gaps",
            "feedback_by_physician",
            "list_document_audits",
            "document_audit_detail",
            "document_audit_doctor_rollup",
            "document_audit_headline",
            "cdmss_v1_this_week",
            "cdmss_v2_scorecard",
            "cdmss_v3_doctor_variation",
            "cdmss_v4_contributors",
            "cdmss_v5_redflags",
            "cdmss_v8_worklists",
            "cdmss_metric_catalogue",
            "cdmss_metric",
            "cdmss_drilldown",
            "cdmss_finding_detail",
        ]
    finally:
        sys.modules.pop("main", None)


def test_tracing_disabled_after_import_even_if_host_enables_it(monkeypatch):
    import importlib
    import sys

    for name in ("LANGSMITH_TRACING", "LANGSMITH_TRACING_V2", "LANGCHAIN_TRACING_V2", "LANGCHAIN_TRACING"):
        monkeypatch.setenv(name, "true")
    sys.modules.pop("main", None)
    try:
        importlib.import_module("main")
        from langsmith.utils import tracing_is_enabled

        assert tracing_is_enabled() is False
    finally:
        sys.modules.pop("main", None)


def test_credential_bearing_loggers_pinned_against_root_debug():
    import importlib
    import logging
    import sys

    names = ("botocore", "boto3", "urllib3", "google.auth", "httpx")
    root = logging.getLogger()
    old_root = root.level
    for n in names:
        logging.getLogger(n).setLevel(logging.NOTSET)
    sys.modules.pop("main", None)
    try:
        importlib.import_module("main")
        root.setLevel(logging.DEBUG)
        for n in names:
            lg = logging.getLogger(n)
            assert lg.level == logging.WARNING
            assert not lg.isEnabledFor(logging.DEBUG), n
            assert not lg.isEnabledFor(logging.INFO), n
    finally:
        root.setLevel(old_root)
        sys.modules.pop("main", None)
