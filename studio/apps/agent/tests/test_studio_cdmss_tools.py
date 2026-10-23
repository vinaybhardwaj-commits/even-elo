"""CDMSS Phase 1 tools: statistics vs known values, the Stat gates, the contract with the app, access, audit and failure behaviour.
No database: the fetchers are replaced. The real-view-DDL half is tests/test_studio_cdmss_tools_db.py."""

import datetime as dt
import json
import math
import re
from pathlib import Path

import pytest

from src import studio_access, studio_audit, studio_cdmss_tools as ct, studio_screen, studio_tools
from src.studio_tools import STAFF_KEY, ToolError, assert_read_only

STAFF = "22222222-2222-4222-8222-222222222222"
CFG = {"configurable": {STAFF_KEY: STAFF}}
W = ct.Window(dt.date(2026, 10, 17), dt.date(2026, 10, 23))
ROOT = Path(__file__).resolve().parents[4]


def near(a, b, tol=1e-4):
    return abs(a - b) <= tol


# --- statistics against known values -------------------------------------------------------------------------

def test_wilson_known_values():
    lo, hi = ct.wilson(5, 10)
    assert near(lo, 0.2366) and near(hi, 0.7634)
    lo, hi = ct.wilson(0, 10)
    assert lo == 0.0 and near(hi, 0.2775)
    lo, hi = ct.wilson(10, 10)
    assert hi == 1.0 and near(lo, 0.7225)
    assert ct.wilson(1, 0) is None


def test_funnel_limits_known_values():
    lo, hi = ct.funnel_limit(0.3, 100, ct.Z95)
    assert near(lo, 0.3 - 1.96 * math.sqrt(0.21 / 100)) and near(hi, 0.3898, 1e-3) and near(lo, 0.2102, 1e-3)
    lo, hi = ct.funnel_limit(0.3, 100, ct.Z998)
    assert near(hi, 0.3 + 3.09 * 0.045826, 1e-4)
    assert ct.funnel_limit(0.02, 10, 3.09)[0] == 0.0  # clamped to [0, 1]
    assert ct.funnel_limit(0.4, 0, 1.96) == (0.4, 0.4)
    assert (ct.Z95, ct.Z998) == (1.96, 3.09)


def test_funnel_position_bands():
    n = 100
    assert ct.position(0.30, 0.30, n) == "within"
    assert ct.position(0.40, 0.30, n) == "above_95" and ct.position(0.45, 0.30, n) == "above_998"
    assert ct.position(0.20, 0.30, n) == "below_95" and ct.position(0.15, 0.30, n) == "below_998"


def test_p_values_and_change_rule():
    assert near(ct.two_sided_p(1.959964), 0.05, 1e-5)
    assert near(ct.prop_change_p(40, 100, 55, 100), 0.0337, 1e-3)  # pooled 0.475, z = 2.124
    assert ct.prop_change_p(1, 0, 1, 10) is None
    assert ct.classify_change(10, 11.5, 0.01) == ("rising", pytest.approx(0.15))
    assert ct.classify_change(10, 8, 0.01) == ("falling", pytest.approx(-0.2))
    assert ct.classify_change(10, 10.5, 0.01)[0] == "small change (under 10%)"  # significant (p < 0.05) but under 10% relative
    assert ct.classify_change(10, 10.5, 0.30)[0] == "no clear change"  # not significant: still no clear change
    assert ct.classify_change(10, 12, 0.20)[0] == "no clear change"  # 20% but p >= 0.05
    assert ct.classify_change(10, 12, 0.05)[0] == "no clear change"  # p must be strictly below 0.05
    assert ct.classify_change(0, 5, 0.001) == ("no clear change", None) and ct.classify_change(None, 5, 0.001)[0] == "no clear change"


def test_mean_ci_and_welch():
    # values 2, 4, 6: n 3, mean 4, sd 2, interval 4 +/- 1.96 * 2 / sqrt(3)
    lo, hi = ct.mean_ci(3, 12, 56)
    assert near(lo, 4 - 1.96 * 2 / math.sqrt(3)) and near(hi, 4 + 1.96 * 2 / math.sqrt(3))
    assert ct.mean_ci(1, 5, 25) is None
    assert ct.mean_change_p(20, 1500, 112500, 20, 1200, 72000) == 0.0  # zero variance, different means


def test_bands_and_plain_english():
    assert [ct.raw_band(x) for x in (85, 84.9, 70, 69.9, 55, 40, 39.9)] == ["A", "B", "B", "C", "C", "D", "E"]
    assert ct.raw_band(None) is None
    assert ct.plain_in_ten(0.31) == "about 3 in 10" and ct.plain_in_ten(0.02) == "fewer than 1 in 20" and ct.plain_in_ten(0.99) == "nearly all"


def test_windows_are_ist_calendar_days_ending_today():
    late, early = ct.window_pair(7, dt.date(2026, 10, 23))
    assert (late.frm, late.to) == (dt.date(2026, 10, 17), dt.date(2026, 10, 23)) and late.days == 7
    assert (early.frm, early.to) == (dt.date(2026, 10, 10), dt.date(2026, 10, 16)) and early.days == 7
    assert ct.now_ist().tzinfo is not None


# --- the Stat gates -------------------------------------------------------------------------------------------

def test_stat_min_n_per_kind():
    assert ct.stat("M-OPD-01", W, value=80, n=9, kind="doctor")["status"] == "count_only"
    assert ct.stat("M-OPD-01", W, value=80, n=10, kind="doctor")["status"] == "ok"
    assert ct.stat("M-OPD-01", W, value=80, n=14, kind="site")["status"] == "count_only"
    assert ct.stat("M-OPD-01", W, value=80, n=15, kind="site")["status"] == "ok"
    s = ct.stat("M-OPD-01", W, value=80, num=1, den=2, n=9, ci=(70, 90), kind="doctor", change={"direction": "rising"}, plain="x", band="B")
    assert s["value"] is None and s["ci95"] is None and s["change"] is None and s["plain"] is None and s["band"] is None and s["grey_reason"] == "min_n"
    assert s["n"] == 9 and s["numerator"] is None and s["denominator"] is None  # only the count is kept: a pair would give the value back
    assert ct.stat("M-OPD-05", W, value=None, num=3, den=0, n=40, kind="doctor")["numerator"] is None  # no_denominator hides it too
    e = ct.stat("M-OPD-02", W, value=50, num=5, den=10, n=9, kind="doctor", extra={"counts": {"A": 5}, "pct_a": 50, "band_stats": {"A": 1}})
    assert e["extra"] == {"band_stats": {"A": 1}}  # counts and shares in `extra` are dropped with the pair
    assert (ct.DOCTOR_MIN_N, ct.GROUP_MIN_N, ct.FUNNEL_MIN_N, ct.COVERAGE_GREY_PCT) == (10, 15, 50, 50.0)


def test_stat_coverage_greys_under_half():
    low = ct.stat("M-OPD-01", W, value=80, n=40, kind="doctor", coverage={"assessed": 40, "total": 80, "pct": 49.9})
    assert low["status"] == "greyed" and low["grey_reason"] == "coverage_lt_50" and low["value"] == 80  # kept so the UI can show it greyed
    assert ct.stat("M-OPD-01", W, value=80, n=40, kind="doctor", coverage={"assessed": 40, "total": 80, "pct": 50.0})["status"] == "ok"


def test_stat_shape_and_unavailable():
    s = ct.stat("M-OPD-05", W, value=30.0, num=6, den=20, n=20)
    assert set(s) >= {"metric_id", "label", "value", "unit", "numerator", "denominator", "n", "ci95", "ci_method", "window", "coverage", "status", "grey_reason", "change", "plain", "note", "band"}
    assert s["window"]["from"] == "2026-10-17" and s["unit"] == "per_100"
    u = ct.stat("M-AMS-01", W, value=50, n=100)
    assert u["status"] == "unavailable" and u["value"] is None and "AWaRe" in u["note"]
    assert all(ct.METRICS[m]["status"] == "unavailable" for m in ("M-OPD-09", "M-OPD-10", "M-OPD-11", "M-AMS-01", "M-AMS-02", "M-AMS-04", "M-AMS-05"))
    assert all(ct.METRICS[m]["status"] == "ok" for m in ("M-OPD-01", "M-OPD-02", "M-OPD-03", "M-OPD-04", "M-OPD-05", "M-OPD-06", "M-OPD-08", "M-OPD-12", "M-OPD-13", "M-OPD-14", "M-AMS-03"))


def test_metric_stat_on_empty_groups_never_divides_by_zero():
    ds = ct.Dataset(None, W, W, [], {}, {})
    g = ct.Group()
    for mid in ct.CATALOGUE_IDS:
        s = ct.metric_stat(mid, g, ds, "all")
        assert s["value"] is None and s["status"] in ("count_only", "unavailable"), mid


def test_clinical_nqi_formula_equal_weights_reweighted_to_100():
    sql = ct.ALL_SQL_TEXTS["opd_agg_early_late"]
    assert "score_prescribing_safety" in sql and "score_appropriateness" in sql
    assert "score_documentation" not in sql and "score_patient_centred" not in sql  # excluded by the ruling
    assert "pdqi9_assessed_basis = 'scorecard'" in sql  # scorecard NULL is never "assessed"


# --- the SQL ---------------------------------------------------------------------------------------------------

def all_sql():
    out = dict(ct.ALL_SQL_TEXTS)
    for k in ct.FINDING_PREDICATES:
        out[f"findings_{k}"] = ct.findings_sql(k, by_doctors=True, by_one_doctor=True)
    for k, o in ct.NOTE_ORDERS.items():
        out[f"notes_{k}"] = ct.notes_list_sql(o, True, True, True, True)
    return out


def test_every_statement_is_read_only_and_touches_only_the_granted_views():
    allowed_cdmss = set(ct.CDMSS_VIEWS)
    allowed_dw = set(ct.DW_VIEWS)
    for name, sql in all_sql().items():
        assert_read_only(sql)
        assert "uhid" not in sql.lower() and "patient_name" not in sql.lower(), name
        assert set(re.findall(r"cdmss_ro\.\w+", sql)) <= allowed_cdmss, name
        assert set(re.findall(r"studio_ro\.\w+", sql)) <= allowed_dw, name
        assert "public." not in sql, name  # never a base table
    gov = {"physicians", "physician_engagements", "hospitals"}
    assert set(re.findall(r"(?:FROM|JOIN)\s+(\w+)\b", ct.DIRECTORY_SQL)) <= gov


def test_no_statement_takes_user_text_in_the_sql():
    # f-strings were used to compose the fixed statements; every value reaches the database as a bound parameter
    for name, sql in all_sql().items():
        assert not any("%(" in lit for lit in re.findall(r"'(?:[^']|'')*'", sql)), name  # no placeholder sits inside a string literal
        assert "{" not in sql.replace("'{}'", ""), name


def test_tool_arguments_cannot_carry_sql_or_a_staff_id():
    for t in ct.CDMSS_TOOLS:
        assert not set(t.args) & {"sql", "query", "statement", "staff_id", "actor", "config", "role", "roles"}, t.name


def test_argument_validation_rejects_bad_site_uid_window_and_extras():
    for tool_name, bad in (
        ("cdmss_v4_contributors", {"site": "EH; DROP"}), ("cdmss_v4_contributors", {}), ("cdmss_v2_scorecard", {"window_days": 6}), ("cdmss_v2_scorecard", {"window_days": 400}),
        ("cdmss_metric", {"metric_id": "M-OPD-99"}), ("cdmss_metric", {"metric_id": "M-OPD-01", "doctor_uid": "a b"}), ("cdmss_v8_worklists", {"limit": 501}),
        ("cdmss_v8_worklists", {"list": "everything"}), ("cdmss_finding_detail", {"uid": "x'--"}), ("cdmss_v1_this_week", {"sql": "select 1"}),
    ):
        with pytest.raises(ValueError):
            studio_screen.validate_params(tool_name, bad)
    assert studio_screen.validate_params("cdmss_metric", {"metric_id": "M-OPD-01"}) == {"metric_id": "M-OPD-01"}


# --- access, wiring --------------------------------------------------------------------------------------------

def test_cdmss_screen_is_super_admin_sgc_and_smh_only():
    assert studio_access.SCREEN_ROLES["cdmss"] == frozenset({"super_admin", "sgc_member", "site_medical_head"})
    for roles, ok in ((["staff", "super_admin"], True), (["staff", "sgc_member"], True), (["staff", "site_medical_head"], True), (["staff"], False), (["staff", "hr"], False)):
        for name in ct.CDMSS_TOOL_NAMES:
            assert studio_access.can_use_tool(roles, name) is ok, (name, roles)
    assert studio_access.can_use_tool([], "cdmss_metric") is False


def test_tools_are_registered_for_the_screen_door_and_the_chat_agent():
    for n in ct.CDMSS_TOOL_NAMES:
        assert n in studio_screen.SCREEN_TOOLS and studio_tools.RoleToolGate._gated(n)
    assert "CDMSS_TOOLS" in (Path(__file__).resolve().parents[1] / "main.py").read_text()
    assert ct.CDMSS_TOOL_NAMES == ["cdmss_v1_this_week", "cdmss_v2_scorecard", "cdmss_v3_doctor_variation", "cdmss_v4_contributors", "cdmss_v5_redflags", "cdmss_v8_worklists",
                                   "cdmss_metric_catalogue", "cdmss_metric", "cdmss_drilldown", "cdmss_finding_detail"]


def test_args_schema_json_matches_the_real_tool_arguments():
    # The app pins its per-view parameter allowlist to this file: if an args schema changes, this fails first.
    pinned = json.loads((Path(__file__).resolve().parent / "fixtures" / "cdmss" / "args_schema.json").read_text())
    assert pinned == {t.name: sorted(t.args_schema.model_fields) for t in ct.CDMSS_TOOLS}


def test_fixtures_and_screen_map_name_the_same_tools():
    # the committed fixtures are one per tool; every tool belongs to the cdmss screen
    stems = sorted(p.stem for p in (Path(__file__).resolve().parent / "fixtures" / "cdmss").glob("*.json") if p.stem != "args_schema")
    assert sorted(ct.CDMSS_TOOL_NAMES) == stems
    for n in ct.CDMSS_TOOL_NAMES:
        assert studio_access.GOVERNANCE_SCREEN[n] == "cdmss", n


# --- running the tools with stub databases --------------------------------------------------------------------

@pytest.fixture
def stub(monkeypatch):
    calls, audits = [], []

    async def fetch(sql, params):
        calls.append((sql, params))
        return []

    async def sink(row):
        audits.append(row)

    monkeypatch.setattr(ct, "fetch_cdmss", fetch)
    monkeypatch.setattr(ct, "fetch_gov", fetch)
    monkeypatch.setattr(studio_audit, "audit_sink", sink)
    monkeypatch.setattr(ct, "now_ist", lambda: dt.datetime(2026, 10, 23, 9, 0, tzinfo=ct.KOLKATA))
    return calls, audits


ARGS = {
    "cdmss_v1_this_week": {}, "cdmss_v2_scorecard": {}, "cdmss_v3_doctor_variation": {}, "cdmss_v4_contributors": {"site": "SITEA"}, "cdmss_v5_redflags": {},
    "cdmss_v8_worklists": {}, "cdmss_metric_catalogue": {}, "cdmss_metric": {"metric_id": "M-OPD-01"}, "cdmss_drilldown": {"metric_id": "M-OPD-05"}, "cdmss_finding_detail": {"uid": "u1"},
}


@pytest.mark.anyio
@pytest.mark.parametrize("name", ct.CDMSS_TOOL_NAMES)
async def test_every_tool_returns_the_envelope_even_with_no_data(stub, name):
    calls, audits = stub
    raw = await next(t for t in ct.CDMSS_TOOLS if t.name == name).ainvoke(ARGS[name], config=CFG)
    body = json.loads(raw)
    assert set(body) >= {"source", "mode", "synthetic", "columns", "rows", "row_count", "view"} and body["source"]["tool"] == name and re.fullmatch(r"[0-9a-f]{12}", body["source"]["query_hash"])
    env = body["view"]["envelope"]
    assert set(env) == {"provenance", "headline", "stats", "caveats", "precision_line", "action_line"}
    assert set(env["provenance"]) == {"window", "data_cutoff", "sources", "engine_family", "db13_as_of", "generated_at", "query_hashes"}
    assert env["headline"]["sentence"] and env["provenance"]["window"]["to"] == "2026-10-23"
    assert len(audits) == len(calls) and all(a.staff_id == STAFF and a.tool == name for a in audits)  # one audit row per query


@pytest.mark.anyio
async def test_screen_door_enforces_the_cdmss_gate(stub):
    status, body = await studio_screen.run_screen_tool("cdmss_metric_catalogue", {}, STAFF, ["staff", "hr"])
    assert (status, body) == (403, {"ok": False, "error": "forbidden"})
    status, _ = await studio_screen.run_screen_tool("cdmss_metric_catalogue", {}, STAFF, ["staff"])
    assert status == 403
    for roles in (["staff", "sgc_member"], ["staff", "site_medical_head"], ["staff", "super_admin"]):
        status, body = await studio_screen.run_screen_tool("cdmss_metric_catalogue", {}, STAFF, roles)
        assert status == 200 and body["source"]["tool"] == "cdmss_metric_catalogue"
    assert (await studio_screen.run_screen_tool("cdmss_metric", {"metric_id": "M-OPD-01", "sql": "x"}, STAFF, ["staff", "super_admin"]))[0] == 422


@pytest.mark.anyio
async def test_kill_switch_missing_identity_and_audit_failure_fail_closed(stub, monkeypatch):
    t = next(t for t in ct.CDMSS_TOOLS if t.name == "cdmss_metric")
    monkeypatch.setenv("STUDIO_LIVE_READS", "0")
    with pytest.raises(ToolError, match="no fixtures"):
        await t.ainvoke({"metric_id": "M-OPD-01"}, config=CFG)
    monkeypatch.delenv("STUDIO_LIVE_READS")
    with pytest.raises(ToolError, match="no authenticated staff identity"):
        await t.ainvoke({"metric_id": "M-OPD-01"}, config={"configurable": {}})

    async def broken(row):
        raise RuntimeError("audit db down at host-secret")

    monkeypatch.setattr(studio_audit, "audit_sink", broken)
    with pytest.raises(ToolError) as e:
        await t.ainvoke({"metric_id": "M-OPD-01"}, config=CFG)
    assert str(e.value) == "The audit log is unavailable, so this read was refused." and "secret" not in str(e.value)


@pytest.mark.anyio
async def test_database_errors_become_fixed_strings_and_are_audited(stub, monkeypatch):
    calls, audits = stub

    async def boom(sql, params):
        raise RuntimeError("connection to host db.internal.example failed")

    monkeypatch.setattr(ct, "fetch_cdmss", boom)
    t = next(t for t in ct.CDMSS_TOOLS if t.name == "cdmss_metric")
    with pytest.raises(ToolError) as e:
        await t.ainvoke({"metric_id": "M-OPD-01"}, config=CFG)
    assert str(e.value) == "The governance database read failed." or str(e.value) == "The CDMSS database read failed."
    assert "internal.example" not in str(e.value)
    assert any(a.outcome == "error" and a.row_count == 0 for a in audits)  # sibling queries run together, so the error row is not necessarily the last
    status, body = await studio_screen.run_screen_tool("cdmss_metric", {"metric_id": "M-OPD-01"}, STAFF, ["staff", "super_admin"])
    assert status == 502 and body["error"] == "tool_failed" and "example" not in json.dumps(body)


@pytest.mark.anyio
async def test_not_configured_is_a_fixed_message(stub, monkeypatch):
    from src.studio_db import NotConfigured

    async def nc(sql, params):
        raise NotConfigured("CDMSS_RO_DATABASE_URL is not set")

    monkeypatch.setattr(ct, "fetch_cdmss", nc)
    monkeypatch.setattr(ct, "fetch_gov", nc)
    with pytest.raises(ToolError, match="not configured") as e:
        await next(t for t in ct.CDMSS_TOOLS if t.name == "cdmss_metric").ainvoke({"metric_id": "M-OPD-01"}, config=CFG)
    assert "CDMSS_RO_DATABASE_URL" not in str(e.value)


def test_case_url_and_quote_extraction(monkeypatch):
    monkeypatch.delenv("CDMSS_CASE_BASE_URL", raising=False)
    assert ct.case_url("abc-1") == "https://even-cdmss.vercel.app/care/abc-1" and ct.case_url(None) is None
    assert ct.case_url("a/b c") == "https://even-cdmss.vercel.app/care/a%2Fb%20c"
    monkeypatch.setenv("CDMSS_CASE_BASE_URL", "https://example.test/")
    assert ct.case_url("u") == "https://example.test/care/u"
    assert ct.quote_of(["first", {"quote": "second"}, {"text": "third"}, 7]) == "first | second | third"
    assert ct.quote_of(None) is None and ct.quote_of([]) is None and ct.quote_of({"excerpt": "x" * 400}).endswith("…")
    assert ct.quote_of('["from json"]') == "from json"


def test_names_come_from_the_directory_then_doctor_dim():
    import asyncio

    class R:
        def __init__(self):
            self.n = 0

        async def q(self, db, sql, params, source):
            assert db == "cdmss" and params == {"uids": ["D2", "D9"]}
            return [{"doctor_uid": "D2", "doctor_name": "Dim Two", "speciality": "ENT"}]

    docs = {"D1": ct.Doc("D1", "Dr One"), "D2": ct.Doc("D2")}
    out = asyncio.run(ct.fill_names(R(), docs, {"D1", "D2", "D9"}))
    assert out["D2"].name == "Dim Two" and out["D1"].name == "Dr One" and out["D9"].name is None
    assert ct.Doc("x", sites=[]).site == "UNMAPPED" and ct.Doc("x", sites=["A"]).site == "A" and ct.Doc("x", sites=["A", "B"]).site == "MULTI"


def test_funnel_points_cover_10_to_max_n():
    pts = ct.funnel_points(0.3, 200)
    assert pts[0]["n"] == 10 and pts[-1]["n"] == 200 and all(a["n"] < b["n"] for a, b in zip(pts, pts[1:]))
    assert all(0 <= p["lo998"] <= p["lo95"] <= 0.3 <= p["hi95"] <= p["hi998"] <= 1 for p in pts)
    assert ct.funnel_points(0.3, 5)[-1]["n"] == 60


def test_plain_rate_gloss_for_per_100_and_per_1000():
    assert ct.plain_rate(80.63, 100, "notes") == "about 81 in every 100 notes"
    assert ct.plain_rate(49.6, 1000, "prescriptions") == "about 50 in every 1,000 prescriptions"
    assert ct.plain_rate(None, 100, "notes") is None


# --- result cache, single-flight, concurrency ----------------------------------------------------------------

async def _run(name, args):
    return json.loads(await next(t for t in ct.CDMSS_TOOLS if t.name == name).ainvoke(args, config=CFG))


@pytest.mark.anyio
async def test_cache_hit_runs_no_query_says_cached_at_and_is_audited_as_one_cache_row(stub):
    calls, audits = stub
    first = await _run("cdmss_v1_this_week", {})
    ran, n_audits = len(calls), len(audits)
    assert ran > 0 and "cached_at" not in first["view"]["envelope"]["provenance"]
    second = await _run("cdmss_v1_this_week", {})
    assert len(calls) == ran  # no SQL on a hit
    prov = second["view"]["envelope"]["provenance"]
    assert prov["cached"] is True and re.fullmatch(r"\d{4}-\d{2}-\d{2}T[0-9:+]+", prov["cached_at"])
    assert second["view"]["families"] == first["view"]["families"] and second["source"] == first["source"]  # the same numbers
    cache_rows = audits[n_audits:]
    assert len(cache_rows) == 1 and cache_rows[0].staff_id == STAFF and cache_rows[0].tool == "cdmss_v1_this_week" and cache_rows[0].row_count == 0
    assert cache_rows[0].params_hash not in {a.params_hash for a in audits[:n_audits]}  # never equal to a real query's hash
    # other params, other tool: not shared
    await _run("cdmss_v1_this_week", {"window_days": 14})
    assert len(calls) > ran


@pytest.mark.anyio
async def test_cache_expires_after_300_seconds_and_a_failed_run_is_not_cached(stub, monkeypatch):
    calls, audits = stub
    await _run("cdmss_v3_doctor_variation", {})
    n = len(calls)
    key = next(iter(ct._cache))
    at, iso, payload = ct._cache[key]
    ct._cache[key] = (at - ct.CACHE_TTL_S - 1, iso, payload)
    await _run("cdmss_v3_doctor_variation", {})
    assert len(calls) > n  # expired -> recomputed
    ct.clear_cache()

    async def boom(sql, params):
        raise RuntimeError("x")

    monkeypatch.setattr(ct, "fetch_cdmss", boom)
    with pytest.raises(ToolError):
        await _run("cdmss_v1_this_week", {})
    assert not ct._cache and not ct._inflight


@pytest.mark.anyio
async def test_identical_concurrent_requests_share_one_run(stub, monkeypatch):
    import asyncio

    calls, audits = stub
    gate = asyncio.Event()

    async def slow(sql, params):
        calls.append((sql, params))
        await gate.wait()
        return []

    monkeypatch.setattr(ct, "fetch_cdmss", slow)
    monkeypatch.setattr(ct, "fetch_gov", slow)
    tasks = [asyncio.ensure_future(_run("cdmss_v1_this_week", {})) for _ in range(3)]
    await asyncio.sleep(0.05)
    started = len(calls)
    gate.set()
    results = await asyncio.gather(*tasks)
    assert len(calls) == started and started <= 2 * ct.POOL_PER_DB  # three requests, one run
    assert sum(1 for r in results if r["view"]["envelope"]["provenance"].get("cached")) == 2
    assert len(audits) == len(calls) + 2  # one row per real query + a cache row for each sharer


@pytest.mark.anyio
async def test_independent_queries_run_together_but_never_beyond_the_pool(stub, monkeypatch):
    import asyncio

    live = {"cdmss": 0, "gov": 0}
    peak = {"cdmss": 0, "gov": 0}

    def make(db):
        async def f(sql, params):
            live[db] += 1
            peak[db] = max(peak[db], live[db])
            await asyncio.sleep(0.02)
            live[db] -= 1
            return []
        return f

    monkeypatch.setattr(ct, "fetch_cdmss", make("cdmss"))
    monkeypatch.setattr(ct, "fetch_gov", make("gov"))
    await _run("cdmss_v2_scorecard", {})
    assert 1 < max(peak.values()) and all(v <= ct.POOL_PER_DB for v in peak.values()), peak


@pytest.mark.anyio
async def test_a_failing_query_cancels_its_siblings(stub, monkeypatch):
    import asyncio

    finished = []

    async def cdmss(sql, params):
        await asyncio.sleep(0.2)
        finished.append("cdmss")
        return []

    async def gov(sql, params):
        raise RuntimeError("down")

    monkeypatch.setattr(ct, "fetch_cdmss", cdmss)
    monkeypatch.setattr(ct, "fetch_gov", gov)
    with pytest.raises(ToolError):
        await _run("cdmss_v1_this_week", {})
    await asyncio.sleep(0.3)
    assert finished == []  # the sibling read was cancelled, not left running and auditing
