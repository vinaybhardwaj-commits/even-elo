"""Document-audit read tools (M2): unit contract, screen door, fixtures, view SQL, and the REAL even-elo schema.

The real-schema half builds the database from src/lib/migrations.ts, creates the two column-scoped views from
ops/neon/0007_docaudits_views.sql (the DDL only: the file's preflight demands a non-superuser owner and the
studio_gov_ro role, which the scratch server does not have), seeds audits with findings and runs every tool."""

import json
import re
from pathlib import Path

import pytest

from src import studio_audit, studio_docaudit_tools as dat, studio_screen, studio_tools
from src.studio_tools import ToolError, assert_read_only
from tests.test_studio_tools_real_schema import real_db  # noqa: F401  (module-scoped fixture)

STAFF = "11111111-1111-4111-8111-111111111111"
CFG = {"configurable": {studio_tools.STAFF_KEY: STAFF}}
MIGRATION = Path(__file__).resolve().parents[4] / "ops" / "neon" / "0007_docaudits_views.sql"
SYSTEM_AUTHOR = "CDMSS audit (pending RMO review)"
AID = "33333333-3333-4333-8333-333333333333"


def tool(name):
    return next(t for t in dat.DOCAUDIT_TOOLS if t.name == name)


async def call(name, args):
    return json.loads(await tool(name).ainvoke(args, config=CFG))


@pytest.fixture
def rec(monkeypatch):
    calls, audits = [], []

    async def fetch(sql, params):
        calls.append((sql, params))
        return []

    async def audit(row):
        audits.append(row)

    monkeypatch.setenv("STUDIO_LIVE_READS", "1")
    monkeypatch.setattr(studio_tools, "fetch_rows", fetch)
    monkeypatch.setattr(studio_audit, "audit_sink", audit)
    return calls, audits


# --- contract ---------------------------------------------------------------------------------------

def test_tool_names_and_screen_allowlist():
    assert dat.DOCAUDIT_TOOL_NAMES == ["list_document_audits", "document_audit_detail", "document_audit_doctor_rollup", "document_audit_headline"]
    for n in dat.DOCAUDIT_TOOL_NAMES:
        assert n in studio_screen.SCREEN_TOOLS
    assert not set(dat.DOCAUDIT_SQL) & set(studio_tools.ALL_SQL)  # the six M1 tools and their grant test are untouched


def test_no_tool_accepts_sql_or_a_staff_id():
    for t in dat.DOCAUDIT_TOOLS:
        assert not set(t.args) & {"sql", "query", "statement", "staff_id", "actor", "config"}, t.name


@pytest.mark.parametrize("name", sorted(dat.DOCAUDIT_SQL))
def test_every_statement_is_a_parameterised_select(name):
    sql = dat.DOCAUDIT_SQL[name]
    assert_read_only(sql)
    assert "%s" in sql and not re.search(r"\{|\bf\"", sql)


def test_sql_reads_only_the_views_and_physicians():
    joined = " ".join(dat.DOCAUDIT_SQL.values()).lower()
    from_tables = set(re.findall(r"(?:from|join)\s+([a-z_.]+)", joined))
    assert from_tables - {"lateral"} == {"studio_ro.document_audit_list", "studio_ro.document_audit_finding_list", "physicians"}
    for banned in ("citations", "patient_json", "sync_error", "doctor_uid", "document_audits ", "document_audit_findings "):
        assert banned not in joined, banned
    detail = dat.DOCAUDIT_SQL["document_audit_detail"].lower()
    for shown in ("finding_body", "evidence_excerpt", "response_comment", "authored_by_name", "pdf_url"):
        assert shown in detail, shown


def test_placeholders_match_the_bound_params(rec):
    import asyncio

    async def run():
        await call("list_document_audits", {"filter": {"hospital_code": "H1", "severity": "high", "doctor_name_contains": "a_b"}})
        await call("document_audit_detail", {"audit_id": AID})
        await call("document_audit_doctor_rollup", {"hospital_code": "H1", "window_days": 30})
        await call("document_audit_headline", {})

    asyncio.run(run())
    for sql, params in rec[0]:
        assert sql.count("%s") == len(params), sql[:60]


@pytest.mark.anyio
async def test_audit_row_per_call_and_filter_is_escaped(rec):
    calls, audits = rec
    await call("list_document_audits", {"filter": {"doctor_name_contains": "50%_x"}})
    assert len(audits) == 1 and audits[0].tool == "list_document_audits" and audits[0].staff_id == STAFF
    assert "50\\%\\_x" in calls[0][1][-4]  # the LIKE pattern is escaped, never interpolated


@pytest.mark.anyio
async def test_bad_args_are_refused(rec):
    for name, args in [
        ("list_document_audits", {"filter": {"severity": "extreme"}}),
        ("list_document_audits", {"offset": -1}),
        ("document_audit_detail", {"audit_id": "not-a-uuid"}),
        ("document_audit_doctor_rollup", {"window_days": 0}),
    ]:
        with pytest.raises(Exception):
            await tool(name).ainvoke(args, config=CFG)
    assert rec[0] == []


@pytest.mark.anyio
async def test_audit_failure_returns_no_data(monkeypatch):
    async def fetch(sql, params):
        return [{"metric": "audits_total", "value": 1}]

    async def broken(row):
        raise RuntimeError("down")

    monkeypatch.setenv("STUDIO_LIVE_READS", "1")
    monkeypatch.setattr(studio_tools, "fetch_rows", fetch)
    monkeypatch.setattr(studio_audit, "audit_sink", broken)
    with pytest.raises(ToolError, match="audit log is unavailable"):
        await call("document_audit_headline", {})


@pytest.mark.anyio
async def test_kill_switch_serves_synthetic_fixtures(monkeypatch):
    async def audit(row):
        pass

    monkeypatch.setenv("STUDIO_LIVE_READS", "0")
    monkeypatch.setattr(studio_audit, "audit_sink", audit)

    async def no_db(sql, params):
        raise AssertionError("database touched in fixture mode")

    monkeypatch.setattr(studio_tools, "fetch_rows", no_db)
    for name, args in [("list_document_audits", {}), ("document_audit_detail", {"audit_id": AID}),
                       ("document_audit_doctor_rollup", {}), ("document_audit_headline", {})]:
        out = await call(name, args)
        assert out["mode"] == "fixture" and out["synthetic"] is True and out["row_count"] > 0, name
        assert out["source"]["tool"] == name and re.fullmatch(r"[0-9a-f]{12}", out["source"]["query_hash"])
        assert list(out["rows"][0]) == out["columns"]  # fixture columns match the row keys


def test_query_hashes_differ_per_tool():
    hashes = {studio_tools.query_hash(n, s) for n, s in dat.DOCAUDIT_SQL.items()}
    assert len(hashes) == 4


@pytest.mark.anyio
async def test_screen_door_runs_a_docaudit_tool(rec):
    status, body = await studio_screen.run_screen_tool("document_audit_headline", {}, STAFF, ["super_admin"])
    assert status == 200 and body["source"]["tool"] == "document_audit_headline"
    status, _ = await studio_screen.run_screen_tool("document_audit_detail", {"audit_id": "x"}, STAFF, ["super_admin"])
    assert status == 422
    status, _ = await studio_screen.run_screen_tool("list_document_audits", {"sql": "select 1"}, STAFF, ["super_admin"])
    assert status == 422


# --- the REAL schema --------------------------------------------------------------------------------

def view_ddl() -> str:
    text = MIGRATION.read_text()
    stmts = re.findall(r"^CREATE VIEW .*?;\n", text, re.S | re.M)
    assert len(stmts) == 2
    drops = "DROP VIEW IF EXISTS studio_ro.document_audit_finding_list;\nDROP VIEW IF EXISTS studio_ro.document_audit_list;\n"
    return "CREATE SCHEMA IF NOT EXISTS studio_ro;\n" + drops + "\n".join(stmts)


@pytest.fixture
def live(real_db, monkeypatch):  # noqa: F811
    real_db.execute(view_ddl())
    pids = pytest.real_pids
    real_db.execute("DELETE FROM document_audits")
    audits = {}
    for i, (pid, doc, ref) in enumerate([(pids[0], "progress", "AUD-1"), (pids[0], "ot", "AUD-2"), (pids[1], "discharge", "AUD-3")]):
        audits[ref] = real_db.execute(
            "INSERT INTO document_audits (external_ref, hospital_code, physician_id, doc_type, note_date, cdmss_pdf_url, note_class) "
            "VALUES (%s, 'H1', %s, %s, current_date - %s, %s, 'progress') RETURNING id::text AS id",
            (ref, pid, doc, i, "https://cdmss.example/x.pdf" if i == 0 else None),
        ).fetchone()["id"]
    def f(ref, label, sev, status, author, pid, **kw):
        real_db.execute(
            "INSERT INTO document_audit_findings (audit_id, finding_label, finding_body, evidence_excerpt, severity, status, authored_by_name, physician_id, doctor_response_verb, doctor_response_comment) "
            "VALUES (%s, %s, 'BODY TEXT', 'EVIDENCE TEXT', %s, %s, %s, %s, %s, 'DOCTOR COMMENT')",
            (audits[ref], label, sev, status, author, pid, kw.get("verb")),
        )
    f("AUD-1", "L1", "high", "open", "Dr RMO One", pids[0])
    f("AUD-1", "L2", "low", "remediated", SYSTEM_AUTHOR, pids[0], verb="agree")
    f("AUD-2", "L3", "critical", "contested", SYSTEM_AUTHOR, pids[0])
    f("AUD-3", "L4", "medium", "open", "Dr RMO Two", pids[1])
    pytest.audit_ids = audits

    async def fetch(sql, params):
        studio_tools.assert_read_only(sql)
        return real_db.execute(sql, params).fetchall()

    async def audit(row):
        pass

    monkeypatch.setenv("STUDIO_LIVE_READS", "1")
    monkeypatch.setattr(studio_tools, "fetch_rows", fetch)
    monkeypatch.setattr(studio_audit, "audit_sink", audit)
    return real_db


@pytest.mark.anyio
async def test_list_and_filters_on_the_real_schema(live):
    out = await call("list_document_audits", {})
    assert out["mode"] == "live" and out["synthetic"] is False and out["total"] == 3 and "total_count" not in out["columns"]
    by_ref = {r["external_ref"]: r for r in out["rows"]}
    assert by_ref["AUD-1"]["findings"] == 2 and by_ref["AUD-1"]["open_findings"] == 1 and by_ref["AUD-1"]["top_severity"] == "high"
    assert by_ref["AUD-1"]["has_pdf"] is True and by_ref["AUD-2"]["has_pdf"] is False
    assert by_ref["AUD-2"]["top_severity"] == "critical"
    only = await call("list_document_audits", {"filter": {"severity": "critical"}})
    assert [r["external_ref"] for r in only["rows"]] == ["AUD-2"]
    only = await call("list_document_audits", {"filter": {"status": "open", "doc_type": "discharge"}})
    assert [r["external_ref"] for r in only["rows"]] == ["AUD-3"]
    only = await call("list_document_audits", {"filter": {"physician_id": pytest.real_pids[1]}})
    assert only["row_count"] == 1
    assert (await call("list_document_audits", {"filter": {"hospital_code": "NOPE"}}))["rows"] == []
    assert (await call("list_document_audits", {"filter": {"doctor_name_contains": "sample 0"}}))["total"] == 2
    paged = await call("list_document_audits", {"limit": 2, "offset": 2})
    assert paged["row_count"] == 1 and paged["total"] == 3


@pytest.mark.anyio
async def test_detail_headline_and_rollup_on_the_real_schema(live):
    out = await call("document_audit_detail", {"audit_id": pytest.audit_ids["AUD-1"]})
    assert out["row_count"] == 2
    by_label = {r["finding_label"]: r for r in out["rows"]}
    assert by_label["L1"]["author_confirmed"] is True and by_label["L2"]["author_confirmed"] is False
    assert by_label["L2"]["response_verb"] == "agree"
    assert (await call("document_audit_detail", {"audit_id": AID}))["rows"] == []
    h = {r["metric"]: r["value"] for r in (await call("document_audit_headline", {}))["rows"]}
    assert h["audits_total"] == 3 and h["findings_total"] == 4 and h["findings_open"] == 3
    assert h["critical_high_open"] == 2 and h["doctors_with_findings"] == 2 and h["findings_responded"] == 1
    assert h["days_since_last_ingest"] == 0
    assert {r["metric"]: r["value"] for r in (await call("document_audit_headline", {"hospital_code": "NOPE"}))["rows"]}["audits_total"] == 0
    roll = await call("document_audit_doctor_rollup", {})
    top = roll["rows"][0]
    assert top["physician_id"] == pytest.real_pids[0] and top["audits"] == 2 and top["findings"] == 3
    assert top["open_findings"] == 2 and top["critical_high_open"] == 2 and top["contested"] == 1 and top["responded"] == 1
    assert roll["total"] == 2 and "total_count" not in roll["columns"]


@pytest.mark.anyio
async def test_detail_returns_finding_text_evidence_comment_author_and_pdf(live):
    out = await call("document_audit_detail", {"audit_id": pytest.audit_ids["AUD-1"]})
    by_label = {r["finding_label"]: r for r in out["rows"]}
    assert by_label["L1"]["finding_body"] == "BODY TEXT" and by_label["L1"]["evidence_excerpt"] == "EVIDENCE TEXT"
    assert by_label["L1"]["authored_by_name"] == "Dr RMO One" and by_label["L2"]["response_comment"] == "DOCTOR COMMENT"
    assert all(r["pdf_url"] == "https://cdmss.example/x.pdf" for r in out["rows"])
    listing = await call("list_document_audits", {})
    assert "BODY TEXT" not in json.dumps(listing)  # the list stays a register; text is in the detail


def test_views_expose_no_free_text_column_and_no_name_regex_hit(live):
    cols = [r["column_name"] for r in live.execute(
        "SELECT table_name || '.' || column_name AS column_name FROM information_schema.columns WHERE table_schema = 'studio_ro'").fetchall()]
    cols = [c for c in cols if not c.startswith("incident_register.")]  # 0009's view, installed by the shared real-schema fixture
    assert cols
    # the migration's post-check is an explicit allowlist (a renamed note_class/note_date would have slipped past a name regex)
    from tests.test_lc1_live_probe import DOCAUDIT_VIEW_COLUMNS
    assert sorted(cols) == sorted(f"{v}.{c}" for v, cs in DOCAUDIT_VIEW_COLUMNS.items() for c in cs)
    assert all(f"'{c}'" in MIGRATION.read_text() for c in cols)
    for gone in ("citations_json", "patient_json", "cdmss_sync_error", "doctor_uid", "authored_by_profile_id"):
        assert not any(c.endswith("." + gone) for c in cols)
