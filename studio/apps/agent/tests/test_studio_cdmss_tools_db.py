"""CDMSS Phase 1 tools against a scratch Postgres holding the REAL cdmss_ro view DDL (ops/cdmss/0002) on the CDMSS schema, read as the
studio_cdmss_ro role, plus a second scratch database standing in for the governance DB (physicians, hospitals, DB13 extract views).
Every expected value below is computed by hand from the seed in `seed()`; the module's own math is never used to produce a literal.
Synthetic rows only. Nothing here touches a real database."""

import datetime as dt
import json
import math
from zoneinfo import ZoneInfo

import psycopg
import pytest
from psycopg.rows import dict_row

from src import studio_audit, studio_cdmss_tools as ct, studio_tools
from src.studio_tools import STAFF_KEY, assert_read_only
from tests.cdmss_harness import ROLE, cdmss, needs_env  # noqa: F401  (fixture)

pytestmark = needs_env

STAFF = "11111111-1111-4111-8111-111111111111"
CFG = {"configurable": {STAFF_KEY: STAFF}}
TODAY = dt.datetime(2026, 10, 23, 12, 0, tzinfo=ZoneInfo("Asia/Kolkata"))
LATE_AT = "2026-10-20T06:00:00Z"  # 11:30 IST on the 20th: inside the 7-day window 10-17..10-23
EARLY_AT = "2026-10-13T06:00:00Z"  # inside the previous window 10-10..10-16
R5 = ct.R5_RULE_REF


def sc(weight=0.25):
    return {"headline": 80, "domains": [{"domain": "documentation", "weight": 0.3}, {"domain": "note_quality", "weight": weight}]}


def f(subject, verdict="low-value", **kw):
    return {"subject": subject, "verdict": verdict, "domain": "appropriateness", "confidence": 0.8, "rationale": kw.pop("rationale", f"why {subject}"),
            "evidence": kw.pop("evidence", [f"quote for {subject}"]), **kw}


def seed(c):
    """Late-window notes (hand-computable):
    D1 (site SITEA) 20 notes i=1..20: assessed i<=12 (nqi 90 for i<=6, 70 for 7..12), unassessed (nqi 100) otherwise; clinical (a=80,p=60) i<=10 else (a=50,p=NULL);
       completeness 90 i<=10 else 70; band MODERATE i<=10 else LOW; low-value findings: i=1..5 (note 1 has two), informational + underuse on 6 (not counted),
       dup (context) on 7, NSAID+warfarin interaction on 8, R5 on 9; ICD J02.9 on 9, J06.9 on 10; DB13: 5 meds i<=4 else 2, 3 tests i<=10 else 1.
    D2 (SITEA) 20 notes: assessed nqi 60 (C), a=40/p=NULL, LOW, low-value on 10 notes.   D3 (SITEB) 5 notes: assessed nqi 50, a=40, unbanded.
    D4 (SITEB) 30 notes: 12 assessed nqi 90, 18 unassessed nqi 100, a=40, MODERATE, no findings.   D5 (SITEA) 60 notes: assessed nqi 80, a=80, HIGH, low-value on 30 notes.
    Early window: D1 20 assessed nqi 80, D2 20 assessed nqi 75."""
    n = [0]

    def ins(uid, doctor, at, nqi, band, assessed, appr, psafe, comp, cband, findings, ver="0.81.21", model="gemini-2.5-pro", excl=None, audited="2026-10-22T20:00:00Z"):
        c.su_exec(
            """INSERT INTO opd_note_audits (uid, engine_version, model, note_quality_index, band, excluded_reason, audited_at, app_source, findings, scorecard,
                   doctor_uid, note_date, score_appropriateness, score_prescribing_safety, completeness_pct, complexity_band)
               VALUES (%s,%s,%s,%s,%s,%s,%s,'standalone',%s,%s,%s,%s,%s,%s,%s,%s)""",
            (uid, f"opd-note-audit/{ver}", model, nqi, band, excl, audited, json.dumps(findings), json.dumps(sc()) if assessed else None, doctor, at, appr, psafe, comp, cband),
        )
        n[0] += 1

    for i in range(1, 21):
        fnd = []
        if i <= 5:
            fnd.append(f("lv%d" % i))
        if i == 1:
            fnd.append(f("lv1b"))
        if i == 6:
            fnd += [f("info", informational=True), f("under", direction="underuse")]
        if i == 7:
            fnd.append(f("dup", "context", signal_type="duplicate_prescription"))
        if i == 8:
            fnd.append(f("ddi", "context", signal_type="drug_interaction", rationale="NSAID with warfarin raises bleeding risk"))
        if i == 9:
            fnd.append(f("abx", "context", rule_ref=R5, signal_type="antibiotic_stewardship"))
        assessed = i <= 12
        ins(f"D1-L-{i:02d}", "D1", LATE_AT, (90 if i <= 6 else 70) if assessed else 100, "A" if (not assessed or i <= 6) else "B", assessed, 80 if i <= 10 else 50,
            60 if i <= 10 else None, 90 if i <= 10 else 70, "MODERATE" if i <= 10 else "LOW", fnd)
    for i in range(1, 21):
        ins(f"D2-L-{i:02d}", "D2", LATE_AT, 60, "C", True, 40, None, 80, "LOW", [f("lv")] if i <= 10 else [])
    for i in range(1, 6):
        ins(f"D3-L-{i:02d}", "D3", LATE_AT, 50, "D", True, 40, None, 80, None, [])
    for i in range(1, 31):
        ins(f"D4-L-{i:02d}", "D4", LATE_AT, 90 if i <= 12 else 100, "A", i <= 12, 40, None, 80, "MODERATE", [])
    for i in range(1, 61):
        ins(f"D5-L-{i:02d}", "D5", LATE_AT, 80, "B", True, 80, None, 80, "HIGH", [f("lv")] if i <= 30 else [],
            audited="2026-10-23T01:15:00Z" if i == 60 else "2026-10-22T20:00:00Z")
    for i in range(1, 21):
        ins(f"D1-E-{i:02d}", "D1", EARLY_AT, 80, "B", True, 70, None, 80, "LOW", [])
        ins(f"D2-E-{i:02d}", "D2", EARLY_AT, 75, "B", True, 70, None, 80, "LOW", [])
    # rows the views must keep out of every figure: an older engine version of a counted note, an excluded row, a foreign engine
    ins("D1-L-01", "D1", LATE_AT, 10, "E", True, 0, 0, 0, "LOW", [f("zzz")], ver="0.81.20")
    ins("D1-X-01", "D1", LATE_AT, 10, "E", True, 0, 0, 0, "LOW", [f("zzz")], excl="house_account")
    c.su_exec("INSERT INTO opd_note_audits (uid, engine_version, note_quality_index, band, doctor_uid, note_date) VALUES ('D1-F-01','other-engine/1.0',1,'E','D1',%s)", (LATE_AT,))
    sig = "INSERT INTO opd_gov_signal (reference, doctor_uid, signal_type, importance, response_required, status, sla_due_at) VALUES (%s,%s,%s,%s,%s,%s,%s)"
    c.su_exec(sig, ("SITEA-AUD-2026-0001", "D5", "low_value_pattern", "high", "doctor_response", "routed", "2026-10-15T00:00:00Z"))
    c.su_exec(sig, ("SITEA-AUD-2026-0002", "D2", "low_value_pattern", "medium", "none", "closed", "2026-10-15T00:00:00Z"))
    c.su_exec(sig, ("SITEB-AUD-2026-0003", "D4", "documentation", "low", "none", "routed", "2027-01-01T00:00:00Z"))


GOV_DDL = """
CREATE SCHEMA studio_ro;
CREATE TABLE hospitals (id int PRIMARY KEY, code text);
CREATE TABLE physicians (id int PRIMARY KEY, full_name text, primary_specialty text, cdmss_doctor_uid text);
CREATE TABLE physician_engagements (physician_id int, hospital_id int, status text);
CREATE TABLE studio_ro.dw_individuals_prescriptions (uid text, doctor_uid text, "timestamp" timestamptz, is_draft boolean, medications jsonb,
  further_investigation jsonb, diagnosis_icd_codes text[], impression_icd_codes text[]);
CREATE TABLE studio_ro.dw_extract_status (status text, db13_snapshot_now timestamptz);
INSERT INTO hospitals VALUES (1, 'SITEA'), (2, 'SITEB');
INSERT INTO physicians VALUES (1,'Dr One','Medicine','D1'),(2,'Dr Two','Medicine','D2'),(3,'Dr Three','Surgery','D3'),(4,'Dr Four','Surgery','D4'),(5,'Dr Five','Medicine','D5'),(6,'Dr Six','Medicine','D6');
INSERT INTO physician_engagements VALUES (1,1,'active'),(2,1,'active'),(3,2,'active'),(4,2,'active'),(5,1,'active'),(6,1,'active'),(6,2,'active'),(2,2,'terminated');
INSERT INTO studio_ro.dw_extract_status VALUES ('ok','2026-10-22T17:00:00Z'),('failed','2026-10-23T17:00:00Z');
"""


@pytest.fixture(scope="module")
def world(cdmss):  # noqa: F811
    c = cdmss
    seed(c)
    with psycopg.connect(c.su, autocommit=True) as conn:
        conn.execute("DROP DATABASE IF EXISTS govdb")
        conn.execute("CREATE DATABASE govdb")
    gov_url = c.su.replace("@/postgres?", "@/govdb?")
    with psycopg.connect(gov_url, autocommit=True) as g:
        g.execute(GOV_DDL)
        for i in range(1, 21):  # D1's audited notes found in the DB13 extract
            g.execute(
                "INSERT INTO studio_ro.dw_individuals_prescriptions VALUES (%s,'D1','2026-10-20T06:00:00Z',false,%s,%s,%s,%s)",
                (f"D1-L-{i:02d}", json.dumps([{"g": "x"}] * (5 if i <= 4 else 2)), json.dumps([{"t": "y"}] * (3 if i <= 10 else 1)),
                 ["J02.9"] if i == 9 else [], ["J06.9"] if i == 10 else []),
            )
        g.execute("INSERT INTO studio_ro.dw_individuals_prescriptions VALUES ('D1-L-03','D1','2026-10-19T06:00:00Z',false,'[]','[]',NULL,NULL)")  # older duplicate uid: DISTINCT ON keeps the newest

    async def fetch_cdmss(sql, params):
        assert_read_only(sql)
        with psycopg.connect(c.su_cdmss, autocommit=True, row_factory=dict_row) as conn:
            conn.execute(f"SET ROLE {ROLE}")
            return conn.execute(sql, params).fetchall()

    async def fetch_gov(sql, params):
        assert_read_only(sql)
        with psycopg.connect(gov_url, autocommit=True, row_factory=dict_row) as conn:
            return conn.execute(sql, params).fetchall()

    audits = []

    async def sink(row):
        audits.append(row)

    mp = pytest.MonkeyPatch()
    mp.setattr(ct, "fetch_cdmss", fetch_cdmss)
    mp.setattr(ct, "fetch_gov", fetch_gov)
    mp.setattr(ct, "now_ist", lambda: TODAY)
    mp.setattr(studio_audit, "audit_sink", sink)
    yield audits
    mp.undo()


def tool(name):
    return next(t for t in ct.CDMSS_TOOLS if t.name == name)


async def call(name, args, audits=None):
    return json.loads(await tool(name).ainvoke(args, config=CFG))


def groups(body):
    return {g["key"]: g["stat"] for g in body["view"]["groups"]}


def instant(text):
    return dt.datetime.fromisoformat(text.replace("Z", "+00:00"))


def approx(a, b, tol=1e-9):
    return a is not None and abs(a - b) <= tol


# --- M-OPD-01 .. 05 over all sites -------------------------------------------------------------------------

@pytest.mark.anyio
async def test_nqi_is_over_assessed_notes_only_with_coverage(world):
    body = await call("cdmss_metric", {"metric_id": "M-OPD-01", "window_days": 7})
    s = groups(body)["ALL"]
    # assessed: D1 12 (6x90 + 6x70 = 960), D2 20x60 = 1200, D3 5x50 = 250, D4 12x90 = 1080, D5 60x80 = 4800 -> 8290 / 109
    assert s["numerator"] == 8290 and s["denominator"] == 109 and s["n"] == 109
    assert approx(s["value"], 8290 / 109)
    assert s["coverage"] == {"assessed": 109, "total": 135, "pct": 80.7} and s["status"] == "ok"
    assert s["band"] == "B" and s["metric_id"] == "M-OPD-01" and s["unit"] == "score"
    lo, hi = s["ci95"]
    assert lo < s["value"] < hi and s["ci_method"] == "mean_normal"
    assert s["window"] == {"from": "2026-10-17", "to": "2026-10-23", "days": 7, "tz": "Asia/Kolkata", "anchor": "today (IST calendar days, inclusive)"}


@pytest.mark.anyio
async def test_the_view_keeps_old_versions_excluded_and_foreign_rows_out(world):
    body = await call("cdmss_metric", {"metric_id": "M-OPD-04", "window_days": 7, "group_by": "doctor"})
    d1 = groups(body)["D1"]
    # D1 has 20 notes (not 21+): the 0.81.20 duplicate, the house-account row and the foreign engine never count. completeness (10x90 + 10x70) / 20 = 80
    assert d1["n"] == 20 and d1["numerator"] == 1600 and approx(d1["value"], 80)


@pytest.mark.anyio
async def test_clinical_nqi_reweights_two_domains_over_all_notes(world):
    body = await call("cdmss_metric", {"metric_id": "M-OPD-03", "window_days": 7})
    s = groups(body)["ALL"]
    # D1 10x70 + 10x50 (appropriateness only) = 1200; D2 20x40 = 800; D3 5x40 = 200; D4 30x40 = 1200; D5 60x80 = 4800 -> 8200 / 135
    assert s["numerator"] == 8200 and s["denominator"] == 135 and approx(s["value"], 8200 / 135)
    assert s["coverage"] is None  # unassessed PDQI-9 notes stay in the denominator of Clinical NQI


@pytest.mark.anyio
async def test_band_mix_uses_raw_band_over_assessed_notes(world):
    s = groups(await call("cdmss_metric", {"metric_id": "M-OPD-02", "window_days": 7}))["ALL"]
    # assessed raw bands: A = D1 6 + D4 12 = 18; B = D1 6 + D5 60 = 66; C = D2 20; D = D3 5 -> A-B 84 of 109
    assert s["extra"]["counts"] == {"A": 18, "B": 66, "C": 20, "D": 5, "E": 0}
    assert s["numerator"] == 84 and s["denominator"] == 109 and approx(s["value"], 100 * 84 / 109)
    assert approx(s["extra"]["pct_ce"], 100 * 25 / 109)
    lo, hi = s["ci95"]
    z = 1.96
    p, n = 84 / 109, 109
    d = 1 + z * z / n
    assert approx(lo, 100 * ((p + z * z / (2 * n)) - z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d)


@pytest.mark.anyio
async def test_low_value_per_100_excludes_informational_and_underuse(world):
    s = groups(await call("cdmss_metric", {"metric_id": "M-OPD-05", "window_days": 7}))["ALL"]
    # findings: D1 6 (note 1 has two; the informational and the underuse one on note 6 do not count) + D2 10 + D5 30 = 46 of 135 notes
    assert s["numerator"] == 46 and s["denominator"] == 135 and approx(s["value"], 100 * 46 / 135)
    assert s["extra"]["notes_with_one_or_more"] == 45 and approx(s["extra"]["pct_notes_with_one_or_more"], 100 * 45 / 135)


# --- groups, min-n, coverage greying, change ----------------------------------------------------------------

@pytest.mark.anyio
async def test_doctor_min_n_and_coverage_greying(world):
    g = groups(await call("cdmss_metric", {"metric_id": "M-OPD-01", "window_days": 7, "group_by": "doctor"}))
    assert g["D3"]["status"] == "count_only" and g["D3"]["value"] is None and g["D3"]["ci95"] is None and g["D3"]["grey_reason"] == "min_n"
    assert g["D3"]["n"] == 5  # the count is kept
    assert g["D4"]["status"] == "greyed" and g["D4"]["grey_reason"] == "coverage_lt_50" and approx(g["D4"]["value"], 90) and g["D4"]["coverage"]["pct"] == 40.0
    assert g["D1"]["status"] == "ok" and approx(g["D1"]["value"], 80) and g["D1"]["coverage"]["pct"] == 60.0
    assert g["D5"]["status"] == "ok" and approx(g["D5"]["value"], 80)
    assert "D6" not in g  # a doctor with no audited notes in the window has no row


@pytest.mark.anyio
async def test_site_groups_use_the_home_site_and_the_15_note_floor(world):
    g = groups(await call("cdmss_metric", {"metric_id": "M-OPD-01", "window_days": 7, "group_by": "site"}))
    # SITEA = D1 + D2 + D5: assessed 12 + 20 + 60 = 92, sum 960 + 1200 + 4800 = 6960 ; SITEB = D3 + D4: assessed 5 + 12 = 17 of 35 notes (48.6% < 50%)
    assert g["SITEA"]["numerator"] == 6960 and g["SITEA"]["denominator"] == 92 and g["SITEA"]["status"] == "ok"
    assert g["SITEB"]["denominator"] == 17 and g["SITEB"]["status"] == "greyed" and g["SITEB"]["coverage"]["pct"] == 48.6
    # D6 (two engaged hospitals) has no notes, so MULTI does not appear; none of the audited doctors is unmapped
    assert set(g) == {"SITEA", "SITEB"}


@pytest.mark.anyio
async def test_change_requires_p_below_005_and_relative_change_of_10_percent(world):
    g = groups(await call("cdmss_metric", {"metric_id": "M-OPD-01", "window_days": 7, "group_by": "doctor"}))
    d2 = g["D2"]["change"]  # early 20 x 75 -> late 20 x 60: relative -20%, zero variance in both so p = 0
    assert d2["direction"] == "falling" and approx(d2["relative_change"], -0.2) and d2["p_value"] < 0.05
    assert d2["early"] == {"from": "2026-10-10", "to": "2026-10-16", "value": 75.0, "n": 20}
    assert d2["late"]["from"] == "2026-10-17" and d2["late"]["to"] == "2026-10-23" and d2["late"]["value"] == 60.0
    assert g["D1"]["change"]["direction"] == "no clear change"  # early 80 vs late 80
    assert g["D5"]["change"] is None  # no earlier notes: nothing to compare, so no claim


# --- O/E, funnel, contributors ------------------------------------------------------------------------------

@pytest.mark.anyio
async def test_lvc_observed_expected_uses_band_strata_and_excludes_unbanded(world):
    g = groups(await call("cdmss_metric", {"metric_id": "M-OPD-06", "window_days": 7, "group_by": "doctor"}))
    # strata (late window, all doctors): LOW = D1 10 (o 0) + D2 20 (o 10) -> 10/30 ; MODERATE = D1 10 (o 5) + D4 30 -> 5/40 ; HIGH = D5 60 (o 30) -> 1/2
    assert approx(g["D1"]["value"], 5 / (10 * 10 / 30 + 10 * 5 / 40)) and g["D1"]["numerator"] == 5
    assert approx(g["D2"]["value"], 10 / (20 * 10 / 30))
    assert approx(g["D5"]["value"], 1.0)
    assert g["D4"]["numerator"] == 0 and approx(g["D4"]["value"], 0.0)
    assert g["D3"]["status"] == "count_only"  # 5 notes, all unbanded
    assert "age" in g["D1"]["note"].lower()


@pytest.mark.anyio
async def test_v3_funnel_centre_limits_and_greying(world):
    body = await call("cdmss_v3_doctor_variation", {"window_days": 7, "metric": "lv_rate"})
    v = body["view"]
    assert v["funnel"]["centre"] == 0.5  # only D5 has 50+ audited notes: 30 / 60
    lim = {l["n"]: l for l in v["funnel"]["limits"]}
    first = lim[min(lim)]
    assert first["n"] == 10 and approx(first["lo95"], 0.5 - 1.96 * math.sqrt(0.25 / 10)) and approx(first["hi998"], min(1.0, 0.5 + 3.09 * math.sqrt(0.25 / 10)))
    docs = {d["doctor_uid"]: d for d in v["doctors"]}
    assert docs["D5"]["position"] == "within" and approx(docs["D5"]["value"], 0.5) and docs["D5"]["n"] == 60
    assert docs["D1"]["position"] == "greyed" and docs["D2"]["position"] == "greyed"  # 10-49 notes: listed, never positioned
    assert docs["D3"]["value"] is None and docs["D3"]["rank"] is None and docs["D3"]["position"] == "greyed"
    lo, hi = docs["D2"]["ci95"]
    assert lo < 0.5 < hi  # Wilson interval for 10 of 20
    assert v["excluded"]["count"] == 1
    assert body["columns"][:3] == ["doctor_uid", "doctor_name", "site"] and body["row_count"] == 5


@pytest.mark.anyio
async def test_v4_contributors_shares_and_site_rate_without_top(world):
    v = (await call("cdmss_v4_contributors", {"site": "SITEA", "window_days": 7}))["view"]
    # SITEA: 45 of 100 notes have a low-value finding (D1 5, D2 10, D5 30); the other site has none -> the gap is the whole 45
    assert approx(v["site_rate"]["numerator"], 45) and v["site_rate"]["denominator"] == 100 or v["site_rate"]["n"] == 100
    assert approx(v["gap"]["absolute"], 0.45)
    c = {x["doctor_uid"]: x for x in v["contributors"]}
    assert approx(c["D5"]["share_of_gap"], 30 / 45) and approx(c["D2"]["share_of_gap"], 10 / 45) and approx(c["D1"]["share_of_gap"], 5 / 45)
    assert approx(c["D5"]["site_rate_without"], 15 / 40)
    assert v["top_contributor_removed"]["doctor_uid"] == "D5" and v["contributors"][0]["doctor_uid"] == "D5"


# --- Rx denominators from the DB13 extract ------------------------------------------------------------------

@pytest.mark.anyio
async def test_prescribing_rates_use_db13_denominators(world):
    for mid, num, den, val in (("M-OPD-08", 1, 20, 50.0), ("M-OPD-12", 1, 20, 50.0), ("M-OPD-13", 4, 20, 20.0)):
        body = await call("cdmss_metric", {"metric_id": mid, "window_days": 7})
        s = groups(body)["ALL"]
        assert (s["numerator"], s["denominator"]) == (num, den) and approx(s["value"], val), mid
        assert instant(body["view"]["envelope"]["provenance"]["db13_as_of"]) == instant("2026-10-22T17:00:00Z")  # the ok run, not the later failed one
    tests = groups(await call("cdmss_metric", {"metric_id": "M-OPD-14", "window_days": 7}))["ALL"]
    assert tests["numerator"] == 40 and tests["denominator"] == 20 and approx(tests["value"], 2.0)  # 10 notes x 3 + 10 x 1 over 20 consults
    wil = groups(await call("cdmss_metric", {"metric_id": "M-OPD-13", "window_days": 7}))["ALL"]["ci95"]
    z, p, n = 1.96, 0.2, 20
    d = 1 + z * z / n
    assert approx(wil[0], 100 * ((p + z * z / (2 * n)) - z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d)


@pytest.mark.anyio
async def test_urti_antibiotic_flag_is_over_audited_urti_consults(world):
    s = groups(await call("cdmss_metric", {"metric_id": "M-AMS-03", "window_days": 7}))["ALL"]
    assert (s["numerator"], s["denominator"]) == (1, 2) and "lower bound" in (s["note"] or "").lower() or s["status"] == "count_only"
    assert s["status"] == "count_only" and s["value"] is None  # 2 consults is under the group floor: the counts are shown, the rate is not


@pytest.mark.anyio
async def test_unavailable_metrics_say_why_and_run_no_query(world):
    before = len(world)
    body = await call("cdmss_metric", {"metric_id": "M-AMS-01", "window_days": 7})
    s = body["view"]["envelope"]["stats"][0]
    assert s["status"] == "unavailable" and s["value"] is None and "AWaRe" in s["note"] and s["grey_reason"] == "not_available"
    assert len(world) == before and body["view"]["groups"] == []


# --- views: envelope on every payload ------------------------------------------------------------------------

def assert_envelope(body, tool_name):
    assert body["source"]["tool"] == tool_name and len(body["source"]["query_hash"]) == 12 and body["mode"] == "live" and body["synthetic"] is False
    assert body["row_count"] == len(body["rows"]) and all(set(r) == set(body["columns"]) for r in body["rows"])
    env = body["view"]["envelope"]
    p = env["provenance"]
    assert p["window"]["tz"] == "Asia/Kolkata" and p["sources"] and p["engine_family"].startswith("opd-note-audit/0.81.3+")
    assert p["query_hashes"] or p["sources"] == [ct.NO_DB_SOURCE]
    assert env["headline"]["sentence"] and env["precision_line"].startswith("About 1 in 5") and "action_line" in env and env["caveats"] is not None
    return env


@pytest.mark.anyio
async def test_v1_has_tiles_coming_families_and_the_envelope(world):
    body = await call("cdmss_v1_this_week", {})
    env = assert_envelope(body, "cdmss_v1_this_week")
    assert env["provenance"]["window"]["days"] == 7 and instant(env["provenance"]["data_cutoff"]) == instant("2026-10-23T01:15:00Z")  # newest audited_at read
    assert env["provenance"]["db13_as_of"] is not None
    fam = {f["family"]: f for f in body["view"]["families"]}
    assert fam["opd"]["status"] == "live" and fam["ams"]["status"] == "live"
    assert [f for f in fam if fam[f]["status"] == "coming"] == ["ipd", "ot", "preop", "readmission"] and "tiles" not in fam["ipd"]
    ids = [t["stat"]["metric_id"] for t in fam["opd"]["tiles"]]
    assert ids == ["M-OPD-01", "M-OPD-03", "M-OPD-02", "M-OPD-05", "M-OPD-04"]
    nqi = fam["opd"]["tiles"][0]
    assert "7" not in nqi["headline"] or "2026-10-17" in nqi["headline"]
    assert "81% of notes" in nqi["headline"].replace("80.7", "81") or "81% of notes" in nqi["headline"]
    assert any("not a clinician scorecard" in c for c in env["caveats"])
    assert [t["stat"]["status"] for t in fam["ams"]["tiles"]].count("unavailable") == 4
    for t in [*fam["opd"]["tiles"], *fam["ams"]["tiles"]]:
        s = t["stat"]
        assert {"metric_id", "numerator", "denominator", "n", "window", "status", "change"} <= set(s)


@pytest.mark.anyio
async def test_v2_matrix_trend_and_site_basis(world):
    body = await call("cdmss_v2_scorecard", {"window_days": 28})
    assert_envelope(body, "cdmss_v2_scorecard")
    v = body["view"]
    assert v["site_basis"] == "doctor_home_site" and v["sites"] == ["ALL", "SITEA", "SITEB"]
    cells = {m["site"]: m["cells"] for m in v["matrix"]}
    assert cells["SITEB"]["M-OPD-01"]["status"] == "greyed" and cells["SITEA"]["M-OPD-01"]["status"] == "ok"
    pts = next(t for t in v["trend"] if t["site"] == "SITEA" and t["metric_id"] == "M-OPD-01")["points"]
    assert len(pts) == 4 and pts[-1]["week_to"] == "2026-10-23" and pts[0]["week_from"] == "2026-09-26"
    assert pts[-1]["n"] == 92 and pts[-2]["n"] == 40 and pts[0]["n"] == 0 and pts[0]["status"] == "count_only"  # assessed notes per IST week
    assert any("home site" in c for c in v["envelope"]["caveats"])


@pytest.mark.anyio
async def test_v5_dossiers_carry_evidence_quotes_and_case_links(world):
    body = await call("cdmss_v5_redflags", {"window_days": 28})
    assert_envelope(body, "cdmss_v5_redflags")
    dos = {d["doctor_uid"]: d for d in body["view"]["dossiers"]}
    assert set(dos) == {"D5", "D4"}  # D2's thread is closed
    d5 = dos["D5"]
    assert d5["site"] == "SITEA" and d5["signals"][0]["overdue"] is True and d5["signals"][0]["response_required"] is True
    ev = d5["evidence"]
    assert 0 < len(ev) <= 5 and ev[0]["quote"] == "quote for lv" and ev[0]["case"]["url"] == f"https://even-cdmss.vercel.app/care/{ev[0]['uid']}"
    assert body["rows"][0]["doctor_uid"] == "D5"  # high importance first
    only_b = await call("cdmss_v5_redflags", {"window_days": 28, "site": "SITEB"})
    assert [d["doctor_uid"] for d in only_b["view"]["dossiers"]] == ["D4"]


@pytest.mark.anyio
async def test_v8_worklists_and_paging(world):
    lv = await call("cdmss_v8_worklists", {"list": "low_value_findings", "window_days": 28, "site": "SITEA", "limit": 10, "offset": 0})
    assert_envelope(lv, "cdmss_v8_worklists")
    assert lv["total"] == 46 and lv["row_count"] == 10 and lv["rows"][0]["doctor_name"] and lv["rows"][0]["quote"].startswith("quote for")
    page2 = await call("cdmss_v8_worklists", {"list": "low_value_findings", "window_days": 28, "site": "SITEA", "limit": 10, "offset": 10})
    assert page2["rows"][0]["uid"] != lv["rows"][0]["uid"] or page2["rows"][0]["finding_no"] != lv["rows"][0]["finding_no"]
    miss = await call("cdmss_v8_worklists", {"list": "missing_pdqi", "window_days": 7, "doctor_uid": "D4"})
    assert miss["total"] == 18 and all(r["doctor_uid"] == "D4" and r["raw_band"] == "A" for r in miss["rows"])
    od = await call("cdmss_v8_worklists", {"list": "signals_overdue"})
    assert [r["reference"] for r in od["rows"]] == ["SITEA-AUD-2026-0001"]
    op = await call("cdmss_v8_worklists", {"list": "signals_open"})
    assert [r["reference"] for r in op["rows"]] == ["SITEA-AUD-2026-0001", "SITEB-AUD-2026-0003"]  # overdue first; the closed thread is absent
    assert op["rows"][0]["site"] == "SITEA" and "not limited to the window" in " ".join(op["view"]["envelope"]["caveats"])
    empty = await call("cdmss_v8_worklists", {"list": "low_value_findings", "site": "NOWHERE"})
    assert empty["rows"] == [] and empty["total"] == 0


@pytest.mark.anyio
async def test_drilldown_and_finding_detail(world):
    dd = await call("cdmss_drilldown", {"metric_id": "M-OPD-08", "window_days": 7})
    assert dd["total"] == 1 and dd["rows"][0]["uid"] == "D1-L-07" and dd["rows"][0]["site"] == "SITEA"
    nq = await call("cdmss_drilldown", {"metric_id": "M-OPD-01", "window_days": 7, "doctor_uid": "D2", "limit": 3})
    assert nq["total"] == 20 and nq["row_count"] == 3 and nq["rows"][0]["value"] == 60
    r5 = await call("cdmss_drilldown", {"metric_id": "M-AMS-03", "window_days": 7})
    assert [r["uid"] for r in r5["rows"]] == ["D1-L-09"]
    none = await call("cdmss_drilldown", {"metric_id": "M-OPD-13", "window_days": 7})
    assert none["rows"] == [] and any("DB13" in c for c in none["view"]["envelope"]["caveats"])
    det = await call("cdmss_finding_detail", {"uid": "D1-L-01"})
    assert_envelope(det, "cdmss_finding_detail")
    assert det["view"]["note"]["doctor_name"] == "Dr One" and det["view"]["note"]["pdqi9_assessed"] is True and det["view"]["note"]["raw_band"] == "A"
    assert [x["subject"] for x in det["view"]["findings"]] == ["lv1", "lv1b"] and det["view"]["findings"][0]["quote"] == "quote for lv1"
    assert det["view"]["case"]["url"].endswith("/care/D1-L-01")
    one = await call("cdmss_finding_detail", {"uid": "D1-L-01", "finding_no": 2})
    assert [x["subject"] for x in one["view"]["findings"]] == ["lv1b"]
    gone = await call("cdmss_finding_detail", {"uid": "NOPE"})
    assert gone["view"]["note"] is None and gone["rows"] == []


@pytest.mark.anyio
async def test_catalogue_lists_every_phase1_metric(world):
    body = await call("cdmss_metric_catalogue", {})
    assert_envelope(body, "cdmss_metric_catalogue")
    ids = [m["id"] for m in body["view"]["metrics"]]
    assert ids == ["M-OPD-01", "M-OPD-02", "M-OPD-03", "M-OPD-04", "M-OPD-05", "M-OPD-06", "M-OPD-08", "M-OPD-09", "M-OPD-10", "M-OPD-11", "M-OPD-12", "M-OPD-13", "M-OPD-14",
                   "M-AMS-01", "M-AMS-02", "M-AMS-03", "M-AMS-04", "M-AMS-05"]
    assert {m["id"] for m in body["view"]["metrics"] if m["status"] == "unavailable"} == {"M-OPD-09", "M-OPD-10", "M-OPD-11", "M-AMS-01", "M-AMS-02", "M-AMS-04", "M-AMS-05"}


@pytest.mark.anyio
async def test_every_query_is_audited_with_user_tool_and_query_hash(world):
    world.clear()
    await call("cdmss_v3_doctor_variation", {"window_days": 7})
    assert world and all(r.staff_id == STAFF and r.tool == "cdmss_v3_doctor_variation" and r.mode == "live" and r.outcome == "ok" for r in world)
    assert len({r.params_hash for r in world}) == len(world)  # the SQL hash is inside params_hash, so each query has its own
    again = list(world)
    world.clear()
    await call("cdmss_v3_doctor_variation", {"window_days": 7})
    assert [r.params_hash for r in world] == [r.params_hash for r in again]  # stable


# --- fixtures for builder B ----------------------------------------------------------------------------------
# tests/fixtures/cdmss/<tool>.json: one payload per tool, produced by the real SQL over the seed above, relabelled mode "fixture" / synthetic true.
# The agent never serves them (there is no fixture mode for CDMSS tools). CDMSS_WRITE_FIXTURES=1 rewrites them; otherwise the test fails if the SHAPE drifts.

import os
from pathlib import Path

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "cdmss"
FIXTURE_CALLS = {
    "cdmss_v1_this_week": {},
    "cdmss_v2_scorecard": {"window_days": 28},
    "cdmss_v3_doctor_variation": {"window_days": 7},
    "cdmss_v4_contributors": {"site": "SITEA", "window_days": 7},
    "cdmss_v5_redflags": {"window_days": 28},
    "cdmss_v8_worklists": {"list": "low_value_findings", "window_days": 28, "limit": 10},
    "cdmss_metric_catalogue": {},
    "cdmss_metric": {"metric_id": "M-OPD-01", "window_days": 7, "group_by": "doctor"},
    "cdmss_drilldown": {"metric_id": "M-OPD-05", "window_days": 7, "limit": 10},
    "cdmss_finding_detail": {"uid": "D1-L-01"},
}


def shape(x):
    if isinstance(x, dict):
        return {k: shape(v) for k, v in sorted(x.items())}
    if isinstance(x, list):
        return [shape(x[0])] if x else []
    return "scalar"


@pytest.mark.anyio
async def test_fixtures_for_the_app_match_the_real_payload_shape(world):
    assert set(FIXTURE_CALLS) == set(ct.CDMSS_TOOL_NAMES)
    for name, args in FIXTURE_CALLS.items():
        body = await call(name, args)
        body["mode"], body["synthetic"] = "fixture", True
        path = FIXTURE_DIR / f"{name}.json"
        if os.environ.get("CDMSS_WRITE_FIXTURES") == "1":
            FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(body, indent=1, sort_keys=True) + "\n")
        committed = json.loads(path.read_text())
        assert committed["mode"] == "fixture" and committed["synthetic"] is True
        assert shape(committed) == shape(body), f"{name}: run with CDMSS_WRITE_FIXTURES=1 to refresh tests/fixtures/cdmss/{name}.json"
