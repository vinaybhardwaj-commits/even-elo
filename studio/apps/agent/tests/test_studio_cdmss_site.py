"""Phase 1.1: OPD site resolution (governance, then KX hospital ids, then none), the derived KX map and its bar, the basis caption and
coverage, and the cache pre-warmer. Pure parts need no database; the resolution test runs the real 0002 view DDL in pgserver with a scratch
governance database. Synthetic rows only."""

import asyncio
import datetime as dt
import json
import logging
from zoneinfo import ZoneInfo

import psycopg
import pytest
from psycopg.rows import dict_row

from src import studio_audit, studio_cdmss_tools as ct
from src.studio_tools import STAFF_KEY, assert_read_only
from tests.cdmss_harness import ROLE, cdmss, needs_env  # noqa: F401  (fixture)

STAFF = "33333333-3333-4333-8333-333333333333"
CFG = {"configurable": {STAFF_KEY: STAFF}}


def kx(uid, keys, sites=()):
    return {"doctor_uid": uid, "kx_keys": list(keys), "gov_sites": list(sites)}


# --- the KX key -> site map and its bar ---------------------------------------------------------------------------

def test_map_is_accepted_at_90_percent_and_3_doctors_and_rejected_below():
    rows = [kx(f"a{i}", ["KA"], ["S1"]) for i in range(3)]  # 3 of 3
    rows += [kx(f"b{i}", ["KB"], ["S1"]) for i in range(9)] + [kx("b9", ["KB"], ["S2"])]  # 9 of 10 = exactly 90%
    rows += [kx(f"c{i}", ["KC"], ["S1"]) for i in range(8)] + [kx("c8", ["KC"], ["S2"]), kx("c9", ["KC"], ["S2"])]  # 8 of 10 = 80%
    rows += [kx(f"d{i}", ["KD"], ["S1"]) for i in range(2)]  # only 2 doctors: not enough
    rows += [kx("e0", ["KE"], ["S1"]), kx("e1", ["KE"], ["S1"]), kx("e2", ["KE", "KF"], ["S1"]), kx("e3", ["KE"], ["S1", "S2"]), kx("e4", ["KE"], [])]  # only e0, e1 count (one key AND one site)
    derived, ev = ct.derive_kx_map(rows)
    assert derived == {"KA": "S1", "KB": "S1"}
    assert ev["KC"] == {"n": 10, "site": "S1", "agree": 8, "counts": {"S1": 8, "S2": 2}, "enough": True, "accepted": False}
    assert ev["KD"]["enough"] is False and ev["KD"]["accepted"] is False
    assert ev["KE"]["n"] == 2 and "KF" not in ev
    assert ct.KX_MAP_MIN_AGREE == 0.90 and ct.KX_MAP_MIN_N == 3


def test_effective_map_runtime_wins_only_when_it_meets_the_bar(caplog):
    ct._kx_warned.clear()
    derived = {"KA": "S1"}
    evidence = {"KA": {"n": 5, "enough": True}, "KC": {"n": 10, "enough": True, "accepted": False}, "KD": {"n": 2, "enough": False, "accepted": False}}
    constant = {"KA": "S9", "KC": "S1", "KD": "S2", "KZ": "S3"}
    with caplog.at_level(logging.WARNING, logger="studio.cdmss"):
        out = ct.effective_kx_map(derived, evidence, constant)
    assert out["KA"] == "S1"  # runtime meets the bar and wins over the constant
    assert "KC" not in out  # runtime judged it and rejected it: maps to nothing, whatever the constant says
    assert out["KD"] == "S2" and out["KZ"] == "S3"  # runtime cannot judge (n < 3 / no data): the constant stands
    assert any("kx map drift" in r.message for r in caplog.records)
    caplog.clear()
    ct.effective_kx_map(derived, evidence, constant)
    assert not caplog.records  # once per distinct map, not on every directory load
    caplog.clear()
    ct.effective_kx_map({"KA": "S1"}, {"KA": {"n": 5, "enough": True}}, {"KA": "S1"})
    assert not caplog.records  # agreement is silent


def test_shipped_constant_is_empty_until_live_evidence_exists():
    assert ct.KX_SITE_MAP == {}


# --- resolution order -----------------------------------------------------------------------------------------------

def test_resolution_order_governance_then_kx_then_none():
    docs = {
        "G1": ct.Doc("G1", "Gov one", None, ["S1"], "governance"),
        "G2": ct.Doc("G2", "Gov two sites", None, ["S1", "S2"], "governance"),
        "P1": ct.Doc("P1", "Physician without engagement"),  # in governance but no site: KX may place it
    }
    rows = [kx("G1", ["KB"]), kx("G2", ["KA"]), kx("P1", ["KA"]), kx("U1", ["KA"]), kx("U2", ["KA", "KB"]), kx("U3", ["KB"]), kx("U4", ["KX9"]), kx("U5", [])]
    ct.apply_kx_sites(docs, rows, {"KA": "S1"})
    assert docs["G1"].site == "S1" and docs["G1"].basis == "governance"  # (a) beats a KX key that would say otherwise
    assert docs["G2"].site == "MULTI" and docs["G2"].basis == "governance"  # governance multi-site stays MULTI, KX does not rescue it
    assert docs["P1"].site == "S1" and docs["P1"].basis == "kx"
    assert docs["U1"].site == "S1" and docs["U1"].basis == "kx"  # (b) one mapped key
    assert docs["U2"].site == "MULTI" and docs["U2"].basis == "kx"  # (b) several keys
    assert "U3" not in docs and "U4" not in docs and "U5" not in docs  # one key with no mapping, an unknown key, no key: (c) UNMAPPED
    assert ct.Doc("U3").site == "UNMAPPED" and ct.Doc("U3").basis == "none"


def test_kx_statement_is_read_only_and_touches_only_the_granted_objects():
    assert_read_only(ct.KX_SQL)
    assert "studio_ro.dw_doctors" in ct.KX_SQL and "public." not in ct.KX_SQL
    assert "%(" not in ct.KX_SQL  # no user value reaches it


# --- the real views, a scratch governance DB --------------------------------------------------------------------------

TODAY = dt.datetime(2026, 11, 20, 12, 0, tzinfo=ZoneInfo("Asia/Kolkata"))  # a different window from the other DB module's October data
AT = "2026-11-17T06:00:00Z"

GOV = """
CREATE SCHEMA studio_ro;
CREATE TABLE hospitals (id int PRIMARY KEY, code text);
CREATE TABLE physicians (id int PRIMARY KEY, full_name text, primary_specialty text, cdmss_doctor_uid text);
CREATE TABLE physician_engagements (physician_id int, hospital_id int, status text);
CREATE TABLE studio_ro.dw_individuals_prescriptions (uid text, doctor_uid text, "timestamp" timestamptz, is_draft boolean, medications jsonb,
  further_investigation jsonb, diagnosis_icd_codes text[], impression_icd_codes text[]);
CREATE TABLE studio_ro.dw_extract_status (status text, db13_snapshot_now timestamptz);
CREATE TABLE studio_ro.dw_doctors (uid text, karexpert_metadata__practitioner_id_by_hospital jsonb);
INSERT INTO hospitals VALUES (1,'SITEA'),(2,'SITEB');
"""
# governance-linked doctors: G1..G4 SITEA with key KA (KA -> SITEA, 4 of 4); G5..G7 SITEB with key KB (3 of 3); G8, G9 SITEA + G10 SITEB with KC (2 of 3: rejected);
# G11 SITEA with KD (1 doctor: not enough); G12 has two engagements (MULTI, governance). G1 also carries a KX key that agrees; its site comes from governance.
GOV_DOCTORS = {"G1": ("SITEA", "KA"), "G2": ("SITEA", "KA"), "G3": ("SITEA", "KA"), "G4": ("SITEA", "KA"), "G5": ("SITEB", "KB"), "G6": ("SITEB", "KB"), "G7": ("SITEB", "KB"),
               "G8": ("SITEA", "KC"), "G9": ("SITEA", "KC"), "G10": ("SITEB", "KC"), "G11": ("SITEA", "KD")}
# unlinked doctors (no governance physician): K1 key KA -> SITEA via KX; K2 keys KA+KB -> MULTI via KX; K3 key KC (rejected) -> none; K4 key KD (not enough) -> none;
# K5 no DB13 row -> none; K6 key KB -> SITEB via KX.  notes in the window: G1 20, K1 15, K2 12, K3 10, K4 10, K5 10, G12 10, K6 12 = 99; placed = 20 + 15 + 12 = 47
NOTES = {"G1": 20, "K1": 15, "K2": 12, "K3": 10, "K4": 10, "K5": 10, "G12": 10, "K6": 12}


@pytest.fixture(scope="module")
def site_world(cdmss):  # noqa: F811
    c = cdmss
    for doctor, n in NOTES.items():
        for i in range(n):
            c.su_exec(
                """INSERT INTO opd_note_audits (uid, engine_version, model, note_quality_index, band, audited_at, app_source, findings, scorecard, doctor_uid, note_date,
                       score_appropriateness, completeness_pct, complexity_band)
                   VALUES (%s,'opd-note-audit/0.81.21','gemini-2.5-pro',70,'B','2026-11-19T20:00:00Z','standalone','[]',%s,%s,%s,60,80,'LOW')""",
                (f"S-{doctor}-{i:02d}", json.dumps({"domains": [{"domain": "note_quality", "weight": 0.25}]}), doctor, AT),
            )
    with psycopg.connect(c.su, autocommit=True) as conn:
        conn.execute("DROP DATABASE IF EXISTS siteworld")
        conn.execute("CREATE DATABASE siteworld")
    gov_url = c.su.replace("@/postgres?", "@/siteworld?")
    with psycopg.connect(gov_url, autocommit=True) as g:
        g.execute(GOV)
        ids = {"SITEA": 1, "SITEB": 2}
        for i, (uid, (site, key)) in enumerate(GOV_DOCTORS.items(), 1):
            g.execute("INSERT INTO physicians VALUES (%s,%s,'Medicine',%s)", (i, f"Dr {uid}", uid))
            g.execute("INSERT INTO physician_engagements VALUES (%s,%s,'active')", (i, ids[site]))
            g.execute("INSERT INTO studio_ro.dw_doctors VALUES (%s,%s)", (uid, json.dumps({key: "pid"})))
        g.execute("INSERT INTO physicians VALUES (12,'Dr G12','Medicine','G12')")
        g.execute("INSERT INTO physician_engagements VALUES (12,1,'active'),(12,2,'active')")
        for uid, keys in {"K1": ["KA"], "K2": ["KA", "KB"], "K3": ["KC"], "K4": ["KD"], "K6": ["KB"]}.items():
            g.execute("INSERT INTO studio_ro.dw_doctors VALUES (%s,%s)", (uid, json.dumps({k: "pid" for k in keys})))

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
    ct.clear_cache()
    yield c, audits
    mp.undo()
    c.su_exec("DELETE FROM opd_note_audits WHERE uid LIKE 'S-%'")
    ct.clear_cache()


async def call(name, args):
    return json.loads(await next(t for t in ct.CDMSS_TOOLS if t.name == name).ainvoke(args, config=CFG))


@needs_env
@pytest.mark.anyio
async def test_each_doctor_gets_the_site_the_order_says_and_the_caption_shows_the_split(site_world):
    ct.clear_cache()
    body = await call("cdmss_metric", {"metric_id": "M-OPD-04", "window_days": 7, "group_by": "doctor"})
    by = {g["key"]: g for g in body["view"]["groups"]}
    site = {k: g["site"] for k, g in by.items()}
    assert site == {"G1": "SITEA", "K1": "SITEA", "K2": "MULTI", "K3": "UNMAPPED", "K4": "UNMAPPED", "K5": "UNMAPPED", "G12": "MULTI", "K6": "SITEB"}
    # keys: KA -> SITEA (G1..G4, 4 of 4), KB -> SITEB (3 of 3); KC 2 of 3 is rejected, KD has 1 doctor: neither maps
    d = await ct.load_directory(ct.Run("cdmss_metric", {}, CFG))
    assert d["K1"].basis == "kx" and d["K6"].basis == "kx" and d["K2"].basis == "kx" and d["G1"].basis == "governance" and d["G12"].basis == "governance"
    assert "K3" not in d and "K4" not in d and "K5" not in d  # unplaced doctors stay out of the directory: UNMAPPED, basis none
    assert ct.Doc("K3").site == "UNMAPPED"


@needs_env
@pytest.mark.anyio
async def test_coverage_counts_governance_plus_kx_and_the_caption_says_so(site_world):
    ct.clear_cache()
    body = await call("cdmss_v2_scorecard", {"window_days": 7})
    sc = body["view"]["site_comparison"]
    # 99 notes; placed = G1 20 (governance) + K1 15 + K6 12 (KX) = 47
    assert sc["notes"] == 99 and sc["notes_with_site"] == 47 and abs(sc["coverage"] - 47 / 99) < 1e-4
    assert sc["basis"] == {"governance": {"doctors": 1, "notes": 20}, "kx": {"doctors": 2, "notes": 27}, "none": {"doctors": 5, "notes": 52}}
    assert sc["basis_caption"] == "Site from governance for 1 doctors, from KX hospital ids for 2, none for 5; 47% of notes have a site."
    assert sc["withheld"] is True and sc["caption"].startswith("Site comparison withheld: 53% of notes have no site")
    cav = body["view"]["envelope"]["caveats"]
    assert sc["basis_caption"] in cav and any("KX hospital ids" in c for c in cav)
    assert body["view"]["sites"] == [{"code": "ALL", "label": "All sites", "n": 99}]  # still withheld: no per-site counts


@needs_env
@pytest.mark.anyio
async def test_the_switch_opens_when_governance_plus_kx_reach_90_percent(site_world):
    c, _ = site_world
    c.su_exec("DELETE FROM opd_note_audits WHERE uid LIKE 'S-K2-%' OR uid LIKE 'S-K3-%' OR uid LIKE 'S-K4-%' OR uid LIKE 'S-K5-%' OR uid LIKE 'S-G12-%'")
    ct.clear_cache()
    body = await call("cdmss_v2_scorecard", {"window_days": 7})
    sc = body["view"]["site_comparison"]
    assert sc["notes"] == 47 and sc["coverage"] == 1.0 and sc["withheld"] is False and sc["caption"] is None
    assert sc["basis_caption"] == "Site from governance for 1 doctors, from KX hospital ids for 2, none for 0; 100% of notes have a site."
    assert body["view"]["sites"] == [{"code": "ALL", "label": "All sites", "n": 47}, {"code": "SITEA", "label": "SITEA", "n": 35}, {"code": "SITEB", "label": "SITEB", "n": 12}]
    cells = {m["site"]: m["cells"] for m in body["view"]["matrix"]}
    assert cells["SITEA"]["M-OPD-01"]["status"] == "ok" and cells["SITEB"]["M-OPD-01"]["status"] == "count_only"  # 12 notes: under the site floor of 15


# --- the pre-warmer -----------------------------------------------------------------------------------------------------

@pytest.fixture
def warm(monkeypatch):
    calls, audits = [], []

    async def fetch(sql, params):
        calls.append(sql)
        await asyncio.sleep(0)
        return []

    async def sink(row):
        audits.append(row)

    monkeypatch.setattr(ct, "fetch_cdmss", fetch)
    monkeypatch.setattr(ct, "fetch_gov", fetch)
    monkeypatch.setattr(studio_audit, "audit_sink", sink)
    monkeypatch.setattr(ct, "now_ist", lambda: dt.datetime(2026, 10, 23, 9, 0, tzinfo=ct.KOLKATA))
    monkeypatch.setenv("CDMSS_RO_DATABASE_URL", "postgresql://x@127.0.0.1:6432/cdmss")
    monkeypatch.delenv("CDMSS_PREWARM", raising=False)
    ct.clear_cache()
    ct._prewarm_state.update(failures=0, skip=0, runs=0)
    yield calls, audits
    ct.clear_cache()


@pytest.mark.anyio
async def test_prewarm_builds_v1_and_v2_as_the_system_actor_and_users_then_hit_the_cache(warm):
    calls, audits = warm
    assert await ct.prewarm_once() == "ok"
    assert audits and {a.staff_id for a in audits} == {"system:prewarm"} and {a.tool for a in audits} == {"cdmss_v1_this_week", "cdmss_v2_scorecard"}
    n = len(calls)
    assert n > 0 and len([k for k in ct._cache if k[0] != "directory"]) == 2
    user = json.loads(await next(t for t in ct.CDMSS_TOOLS if t.name == "cdmss_v1_this_week").ainvoke({}, config=CFG))
    assert user["view"]["envelope"]["provenance"]["cached"] is True and len(calls) == n  # served from the warmed entry: no new query
    user2 = json.loads(await next(t for t in ct.CDMSS_TOOLS if t.name == "cdmss_v2_scorecard").ainvoke({}, config=CFG))
    assert user2["view"]["envelope"]["provenance"]["cached"] is True and len(calls) == n
    assert await ct.prewarm_once() == "ok" and len(calls) == n + (n - 2)  # a cycle rebuilds the views even though they are fresh (the directory's 2 reads stay cached)
    assert [a.staff_id for a in audits if a.staff_id != "system:prewarm"] == [STAFF] * 2  # the two user hits are audited as the user


@pytest.mark.anyio
async def test_prewarm_entries_outlive_the_ttl_by_the_grace_so_the_next_cycle_replaces_them_first(warm):
    await ct.prewarm_once()
    ages = [ct.CACHE_TTL_S - (__import__("time").monotonic() - v[0]) for k, v in ct._cache.items() if k[0] != "directory"]
    assert len(ages) == 2 and all(a > ct.CACHE_TTL_S for a in ages)  # monotonic_at is in the future by PREWARM_GRACE_S
    assert ct.PREWARM_GRACE_S > 0 and ct.PREWARM_INTERVAL_S == 300


@pytest.mark.anyio
async def test_only_one_prewarm_build_runs_at_a_time(warm, monkeypatch):
    calls, _ = warm
    gate = asyncio.Event()
    real = ct.fetch_cdmss

    async def slow(sql, params):
        await gate.wait()
        return await real(sql, params)

    monkeypatch.setattr(ct, "fetch_cdmss", slow)
    first = asyncio.ensure_future(ct.prewarm_once())
    await asyncio.sleep(0.05)
    assert await ct.prewarm_once() == "busy" and await ct.prewarm_once() == "busy"
    gate.set()
    assert await first == "ok"
    assert ct._prewarm_state["runs"] == 1


@pytest.mark.anyio
async def test_prewarm_skips_when_unhealthy_and_backs_off_after_repeated_failures(warm, monkeypatch):
    calls, _ = warm
    monkeypatch.setenv("STUDIO_LIVE_READS", "0")
    assert await ct.prewarm_once() == "unhealthy" and not calls
    monkeypatch.delenv("STUDIO_LIVE_READS")
    monkeypatch.delenv("CDMSS_RO_DATABASE_URL")
    assert await ct.prewarm_once() == "unhealthy" and not calls  # no CDMSS database configured
    monkeypatch.setenv("CDMSS_RO_DATABASE_URL", "postgresql://x@127.0.0.1:6432/cdmss")

    async def boom(sql, params):
        raise RuntimeError("host secret")

    monkeypatch.setattr(ct, "fetch_cdmss", boom)
    assert [await ct.prewarm_once() for _ in range(3)] == ["failed"] * 3
    assert [await ct.prewarm_once() for _ in range(3)] == ["unhealthy"] * 3  # cooling off
    assert await ct.prewarm_once() == "failed"  # one probe, then it counts again


def test_prewarm_is_off_unless_the_env_says_so(monkeypatch):
    monkeypatch.delenv("CDMSS_PREWARM", raising=False)
    assert ct.prewarm_enabled() is False and asyncio.run(_start_none()) is None
    monkeypatch.setenv("CDMSS_PREWARM", "0")
    assert ct.prewarm_enabled() is False
    monkeypatch.setenv("CDMSS_PREWARM", "1")
    assert ct.prewarm_enabled() is True


async def _start_none():
    return ct.start_prewarm()


@pytest.mark.anyio
async def test_prewarm_task_stops_cleanly_on_shutdown_even_mid_build(warm, monkeypatch):
    calls, _ = warm
    monkeypatch.setenv("CDMSS_PREWARM", "1")
    handle = ct.start_prewarm()
    assert handle is not None and not handle[0].done()
    await asyncio.sleep(0.05)
    await ct.stop_prewarm(handle)
    assert handle[0].done() and not handle[0].cancelled()  # the loop saw the stop event and returned
    # a build that never finishes is cancelled after the timeout instead of hanging shutdown
    gate = asyncio.Event()

    async def hang(sql, params):
        await gate.wait()
        return []

    monkeypatch.setattr(ct, "fetch_cdmss", hang)
    ct.clear_cache()
    handle = ct.start_prewarm()
    await asyncio.sleep(0.05)
    await ct.stop_prewarm(handle, timeout=0.1)
    assert handle[0].done() and ct._prewarm_lock.locked() is False
    await ct.stop_prewarm(None)  # nothing to stop is fine


# --- P11B: pool size from the environment, and the cached directory ------------------------------------------------------

def test_pool_per_db_reads_env_with_bounds(monkeypatch):
    monkeypatch.delenv("CDMSS_POOL_PER_DB", raising=False)
    assert ct.pool_per_db() == 2  # the safe default until the relay pool is 4
    for raw, want in (("1", 1), ("3", 3), ("4", 4), ("0", 1), ("-5", 1), ("9", 4), ("99", 4), ("abc", 2), ("", 2), ("2.5", 2)):
        monkeypatch.setenv("CDMSS_POOL_PER_DB", raw)
        assert ct.pool_per_db() == want, raw


@pytest.mark.anyio
async def test_semaphores_follow_the_env(monkeypatch):
    monkeypatch.setenv("CDMSS_POOL_PER_DB", "3")
    ct._SEMS.clear()
    sems = ct._semaphores()
    assert sems["cdmss"]._value == 3 and sems["gov"]._value == 3
    ct._SEMS.clear()


def test_conftest_scrubs_prewarm_and_pool_env():
    import os

    assert "CDMSS_PREWARM" not in os.environ and "CDMSS_POOL_PER_DB" not in os.environ


@pytest.fixture
def dirs(monkeypatch):
    gov, audits = [], []

    async def fetch(sql, params):
        gov.append(sql)
        await asyncio.sleep(0.01)
        if sql == ct.DIRECTORY_SQL:
            return [{"doctor_uid": "G1", "full_name": "Dr G1", "primary_specialty": "Med", "sites": ["S1"]}]
        if sql == ct.KX_SQL:
            return [{"doctor_uid": "U1", "kx_keys": ["KA", "KA2"], "gov_sites": []}]
        if "GROUP BY s.doctor_uid" in sql:  # one doctor (MULTI via KX, so unplaced): coverage 0 -> site comparison withheld
            return [{"doctor_uid": "U1", "period": "late", "complexity_band": None, "n": 20, "cutoff": None, "versions": []}]
        return []

    async def sink(row):
        audits.append(row)

    monkeypatch.setattr(ct, "fetch_gov", fetch)
    monkeypatch.setattr(ct, "fetch_cdmss", fetch)
    monkeypatch.setattr(studio_audit, "audit_sink", sink)
    monkeypatch.setattr(ct, "now_ist", lambda: dt.datetime(2026, 10, 23, 9, 0, tzinfo=ct.KOLKATA))
    ct.clear_cache()
    return gov


@pytest.mark.anyio
async def test_directory_is_read_once_per_ist_day_and_ttl_with_independent_copies(dirs, monkeypatch):
    gov = dirs
    a = await ct.load_directory(ct.Run("cdmss_metric", {}, CFG))
    assert len(gov) == 2 and a["G1"].site == "S1" and a["U1"].site == "MULTI" and a["U1"].basis == "kx"
    a["G1"].name = "mutated"
    a["ZZ"] = ct.Doc("ZZ")
    run2 = ct.Run("cdmss_v4_contributors", {}, CFG)
    b = await ct.load_directory(run2)
    assert len(gov) == 2  # no second read: the refusal path and the views share it
    assert b["G1"].name == "Dr G1" and "ZZ" not in b  # a caller's additions never reach the next caller
    assert set(run2.sources) >= set(ct.DIRECTORY_SOURCES)  # provenance still names the sources
    monkeypatch.setattr(ct, "now_ist", lambda: dt.datetime(2026, 10, 24, 0, 5, tzinfo=ct.KOLKATA))  # next IST day
    await ct.load_directory(ct.Run("cdmss_metric", {}, CFG))
    assert len(gov) == 4
    monkeypatch.setattr(ct, "CACHE_TTL_S", 0)  # expired
    await ct.load_directory(ct.Run("cdmss_metric", {}, CFG))
    assert len(gov) == 6


@pytest.mark.anyio
async def test_concurrent_directory_loads_share_one_read_and_a_failure_is_not_cached(dirs, monkeypatch):
    gov = dirs
    runs = [ct.Run("cdmss_metric", {}, CFG) for _ in range(5)]
    out = await asyncio.gather(*(ct.load_directory(r) for r in runs))
    assert len(gov) == 2 and all(o["G1"].site == "S1" for o in out) and len({id(o) for o in out}) == 5
    ct.clear_cache()
    gov.clear()
    calls = {"n": 0}
    real = ct.fetch_gov

    async def flaky(sql, params):
        calls["n"] += 1
        if calls["n"] <= 2:
            raise RuntimeError("boom")
        return await real(sql, params)

    monkeypatch.setattr(ct, "fetch_gov", flaky)
    with pytest.raises(ct.ToolError):
        await ct.load_directory(ct.Run("cdmss_metric", {}, CFG))
    assert (await ct.load_directory(ct.Run("cdmss_metric", {}, CFG)))["G1"].site == "S1"  # the failure left nothing behind


@pytest.mark.anyio
async def test_a_site_refusal_reuses_the_cached_directory(dirs):
    gov = dirs
    await ct.load_directory(ct.Run("cdmss_metric", {}, CFG))
    n = len(gov)
    with pytest.raises(ct.ToolError):  # withheld (no notes with a site) -> refused, and the directory was not read again
        await next(t for t in ct.CDMSS_TOOLS if t.name == "cdmss_metric").ainvoke({"metric_id": "M-OPD-01", "site": "S1"}, config=CFG)
    assert gov.count(ct.DIRECTORY_SQL) == 1 and gov.count(ct.KX_SQL) == 1 and len(gov) >= n
