"""DB13 -> studio_dw extract, end to end on two scratch clusters: a stand-in DB13 (real column names, sensitive extras
that must never be copied) and a stand-in governance DB with ops/neon/0012_studio_dw.sql applied. Never touches a real
database, never reads ada.env."""
from __future__ import annotations

import datetime as dt
import importlib.util
import plistlib
import re
import stat
import sys
import uuid
from pathlib import Path

import psycopg
import pytest

from tests.pg_teardown import start_server, stop_server

REPO = Path(__file__).resolve().parents[4]
DB13 = REPO / "ops" / "db13"
SQL_0012 = REPO / "ops" / "neon" / "0012_studio_dw.sql"
sys.path.insert(0, str(DB13))
from extract import cli, job, manifest, queries  # noqa: E402
from extract.spec import BY_NAME, TABLES  # noqa: E402

pytestmark = pytest.mark.skipif(importlib.util.find_spec("pgserver") is None, reason="needs pgserver")

K = {"individuals_prescriptions": "_id", "kx_ip_admissions": "_id", "kx_discharged_completed_patients": "_id", "kx_billing_records": "_id"}
UUIDS = [str(uuid.UUID(int=i + 1)) for i in range(5)]
EXTRA = {  # source-only columns: filter columns and sensitive columns the extract must never copy
    "individuals_prescriptions": ["_update_time timestamptz", "free_text text", "patient_details__allergies text"],
    "dpipe_prescription_pipeline": ["_update_time timestamptz", "name text", "mobile text", "membership_id text"],
    "kx_ip_admissions": ["modified_at timestamptz", "patient_name text", "patient_address text", "uhid text"],
    "kx_discharged_completed_patients": ["modified_at timestamptz", "patient_age text", "payer_type text"],
    "kx_billing_records": ["amount numeric", "net_amt numeric"],
    "surgery_cases": ["updated_at timestamptz", "financial__amount numeric"],
    "doctors": ["email text", "name_with_prefix text", "type text", "disabled boolean", "mobile text", "bank_account__number text", "uploaded_proofs__pan text", "tariffs jsonb", "karexpert_metadata__mobile text"],
}
SENSITIVE = {"email", "name_with_prefix", "free_text", "patient_details__allergies", "name", "mobile", "membership_id", "patient_name", "patient_address", "patient_age",
             "payer_type", "amount", "net_amt", "financial__amount", "bank_account__number", "uploaded_proofs__pan", "tariffs",
             "karexpert_metadata__mobile"}
SRC_TYPE = {"_id": "uuid", "uploaded_at": "timestamp"}  # native types differ from the destination on purpose


def source_ddl():
    out = []
    for t in TABLES:
        cols = []
        for c in t.cols:
            ty = SRC_TYPE.get(c.name, c.type) if t.name in K or c.name == "uploaded_at" else c.type
            if c.name == "_id" and t.name not in K:
                ty = "text"
            if t.name == "kx_ip_admissions" and c.name == "uid":
                ty = "text"
            cols.append(f'"{c.name}" {ty}')
        out.append(f"CREATE TABLE {t.source} ({', '.join(cols + EXTRA.get(t.name, []))});")
    return "\n".join(out)


def sock(server):
    return server.get_uri().split("host=")[1]


def url(server, user, db="postgres"):
    return f"postgresql://{user}:@/{db}?host={sock(server)}"


def seed_source(c):
    now = "now() - interval '2 days'"
    for i, u in enumerate(UUIDS):
        c.execute(f"""INSERT INTO public."individuals-prescriptions" (_id,_parent_id,uid,doctor_uid,"timestamp",uploaded_at,_update_time,is_draft,medications,
                        diagnosis_icd_codes,consult_types,free_text) VALUES (%s,%s,%s,'d1',{now},{now},{now},false,%s::jsonb,%s,%s,'SECRET')""",
                  [u, f"p{i}", f"u{i}", '[{"generic":"x"}]', ["M54.5"], ["opd"]])
        c.execute(f"""INSERT INTO public.kx_ip_admissions (_id,uid,encounter_id,current_treating_doctor_id,facility_name,admission_date_time,
                        encounter_type,modified_at,patient_name,uhid) VALUES (%s,%s,%s,'t1','Even-EHRC',{now},'ip_admission',{now},'PHI','UH1')""",
                  [u, f"a{i}", f"e{i}"])
        c.execute(f"""INSERT INTO public.kx_discharged_completed_patients (_id,uid,encounter_id,uhid,facility_name,discharge_date,status,modified_at)
                        VALUES (%s,%s,%s,'UH1','Even',{now},'completed',{now})""", [u, f"a{i}", f"e{i}"])
        c.execute(f"INSERT INTO public.kx_billing_records (_id,uid,uhid,patient_type,bill_date_time,amount) VALUES (%s,%s,'UH1','IP',{now},99)", [u, f"b{i}"])
        c.execute(f"INSERT INTO public.dpipe_prescription_pipeline (presc_uid,individual_uid,age,uploaded_at,_update_time,medicines,name,mobile) "
                  f"VALUES (%s,'i1',{60 + i},{now},{now},'[]'::jsonb,'PHI','SENT-7c1e')", [f"rx{i}"])
        c.execute("INSERT INTO public.dpipe_prescription_pipeline__diagnosis (_parent_id,diagnosis,icd_code) VALUES (%s,'LBP','M54.5'),(%s,'HA','R51')",
                  [f"rx{i}", f"rx{i}"])
        c.execute(f"INSERT INTO public.surgery_cases (uid,individual_uid,status,created_at,updated_at,planned_surgery_date,financial__amount) "
                  f"VALUES (%s,'i1','BOOKED',{now},{now},current_date,5)", [f"s{i}"])
        c.execute("INSERT INTO public.doctors (uid,email,name_with_prefix,disabled,mobile,bank_account__number,tariffs) VALUES (%s,%s,'Dr X',false,'SENT-7c1e','123','{}')",
                  [f"d{i}", f"d{i}@x"])


@pytest.fixture(scope="module")
def clusters():
    db13, gov = start_server("db13-emu"), start_server("gov-emu")
    try:
        with psycopg.connect(db13.get_uri(), autocommit=True) as c:
            c.execute(source_ddl())
            seed_source(c)
            c.execute("CREATE ROLE ro_user LOGIN CONNECTION LIMIT 3")
            c.execute("GRANT pg_read_all_data TO ro_user")
        with psycopg.connect(gov.get_uri(), autocommit=True) as c:
            c.execute("CREATE ROLE gov_owner LOGIN CREATEROLE CREATEDB")
            c.execute("CREATE DATABASE govdb OWNER gov_owner")
            c.execute("CREATE ROLE studio_gov_ro NOLOGIN")
        with psycopg.connect(url(gov, "gov_owner", "govdb"), autocommit=True) as c:
            c.execute("CREATE SCHEMA studio_ro")
            c.execute("CREATE TABLE public.physicians (id int); CREATE TABLE public.incidents (id int, narrative text)")
            apply_0012(c)
        with psycopg.connect(gov.get_uri(), autocommit=True) as c:
            c.execute("ALTER ROLE studio_dw_writer LOGIN")  # test only: production LOGIN follows the Neon API password step
            c.execute("ALTER ROLE studio_gov_ro LOGIN")
        yield db13, gov
    finally:
        stop_server(db13)
        stop_server(gov)


def apply_0012(c):
    text = "\n".join(l for l in SQL_0012.read_text().splitlines() if not l.startswith("\\"))
    c.execute(text, prepare=False)


@pytest.fixture(autouse=True)
def spill_root(tmp_path, monkeypatch):
    root = tmp_path / "Library" / "Caches" / "gov-studio-extract"
    monkeypatch.setattr(job, "SPILL_ROOT", root)
    return root


@pytest.fixture()
def conns(clusters):
    db13, gov = clusters
    src = psycopg.connect(url(db13, "ro_user"), autocommit=True)
    dst = psycopg.connect(url(gov, "studio_dw_writer", "govdb"), autocommit=True)
    owner = psycopg.connect(url(gov, "gov_owner", "govdb"), autocommit=True)
    sup = psycopg.connect(db13.get_uri(), autocommit=True)
    owner.execute("TRUNCATE " + ", ".join(f"studio_dw.{t.name}" for t in TABLES) + ", studio_dw.extract_run_tables, studio_dw.extract_runs")
    yield src, dst, owner, sup
    for c in (src, dst, owner, sup):
        c.close()


class Clock:
    def __init__(self):
        self.t, self.sleeps = 0.0, []

    def now(self):
        return self.t

    def sleep(self, s):
        self.sleeps.append(s)
        self.t += s


def extractor(src, dst, **kw):
    ck = Clock()
    return job.Extract(src, dst, throttle=job.Throttle(clock=ck.now, sleep=ck.sleep), log=lambda *_: None, **kw), ck


def count(c, t):
    return c.execute(f"SELECT count(*) FROM studio_dw.{t}").fetchone()[0]


def test_ddl_matches_spec(conns):
    _, _, owner, _ = conns
    for t in TABLES:
        got = [r[0] for r in owner.execute("SELECT column_name FROM information_schema.columns WHERE table_schema='studio_dw' AND table_name=%s ORDER BY ordinal_position", [t.name])]
        assert got == t.colnames + ["_run_id"], t.name
        types = {r[0]: r[1] for r in owner.execute("SELECT a.attname, format_type(a.atttypid, NULL) FROM pg_attribute a WHERE a.attrelid=%s::regclass AND a.attnum>0", [f"studio_dw.{t.name}"])}
        for c in t.cols:
            want = owner.execute("SELECT %s::regtype::text", [c.type]).fetchone()[0]
            assert types[c.name] == want, (t.name, c.name)
        v = [r[0] for r in owner.execute("SELECT column_name FROM information_schema.columns WHERE table_schema='studio_ro' AND table_name=%s ORDER BY ordinal_position", [f"dw_{t.name}"])]
        assert v == t.colnames  # no _run_id


def test_spec_has_no_sensitive_columns():
    names = {c.name for t in TABLES for c in t.cols}
    assert not names & SENSITIVE
    assert len(TABLES) == 8


def test_full_extract_end_to_end(conns):
    src, dst, owner, _ = conns
    x, _ = extractor(src, dst, batch_size=2)
    run_id, counts = x.run(allow_peak=True, mode="full")
    assert counts == {"individuals_prescriptions": 5, "dpipe_prescription_pipeline": 5, "dpipe_prescription_diagnosis": 10, "kx_ip_admissions": 5,
                      "kx_discharged_completed_patients": 5, "kx_billing_records": 5, "surgery_cases": 5, "doctors": 5}
    for t, n in counts.items():
        assert count(owner, t) == n
    r = owner.execute("SELECT medications, diagnosis_icd_codes, _id, uploaded_at FROM studio_dw.individuals_prescriptions WHERE uid='u0'").fetchone()
    assert r[0] == [{"generic": "x"}] and r[1] == ["M54.5"] and r[2] == UUIDS[0] and r[3] is not None
    assert owner.execute("SELECT age FROM studio_dw.dpipe_prescription_pipeline WHERE presc_uid='rx3'").fetchone()[0] == 63
    assert owner.execute("SELECT count(*) FROM studio_dw.dpipe_prescription_diagnosis WHERE _parent_id='rx1'").fetchone()[0] == 2
    # no sensitive value anywhere in the destination
    for t in TABLES:
        dump = owner.execute(f"SELECT t::text FROM studio_dw.{t.name} t").fetchall()
        assert not any(s in row[0] for row in dump for s in ("PHI", "SECRET", "SENT-7c1e"))


def test_incremental_watermark(conns):
    src, dst, owner, sup = conns
    x, _ = extractor(src, dst, batch_size=2)
    x.run(allow_peak=True, mode="incremental")  # no prior run: everything
    assert count(owner, "kx_ip_admissions") == 5
    sup.execute("UPDATE public.kx_ip_admissions SET facility_name='Even-EHBR', modified_at=now()+interval '1 hour' WHERE uid='a2'")
    sup.execute("INSERT INTO public.kx_ip_admissions (_id,uid,encounter_id,modified_at) VALUES (%s,'a9','e9',now()+interval '1 hour')", [str(uuid.UUID(int=99))])
    sup.execute("""UPDATE public."individuals-prescriptions" SET _update_time = now() + interval '1 hour' WHERE uid='u1'""")
    try:
        _, counts = x.run(allow_peak=True, mode="incremental")
        assert counts["kx_ip_admissions"] == 2  # only the changed + new row
        assert counts["individuals_prescriptions"] == 1  # _update_time, not uploaded_at
        assert counts["surgery_cases"] == 0
        assert counts["doctors"] == 5 and counts["dpipe_prescription_diagnosis"] == 10  # no watermark: always full
        assert owner.execute("SELECT facility_name FROM studio_dw.kx_ip_admissions WHERE uid='a2'").fetchone()[0] == "Even-EHBR"
        assert count(owner, "kx_ip_admissions") == 6
        f, to = owner.execute("SELECT watermark_from, watermark_to FROM studio_dw.extract_run_tables WHERE table_name='kx_ip_admissions' "
                              "AND status='ok' ORDER BY started_at DESC LIMIT 1").fetchone()
        assert f is not None and to is not None and to > f
    finally:
        sup.execute("DELETE FROM public.kx_ip_admissions WHERE uid='a9'")
        sup.execute("UPDATE public.kx_ip_admissions SET facility_name='Even-EHRC', modified_at=now() - interval '2 days' WHERE uid='a2'")
        sup.execute("""UPDATE public."individuals-prescriptions" SET _update_time = now() - interval '2 days' WHERE uid='u1'""")


def test_full_refresh_drops_vanished_rows(conns):
    src, dst, owner, sup = conns
    x, _ = extractor(src, dst, batch_size=3)
    x.run(allow_peak=True, mode="full")
    sup.execute("INSERT INTO public.doctors (uid,email) VALUES ('gone','g@x')")
    x.run(allow_peak=True, mode="full")
    assert count(owner, "doctors") == 6
    sup.execute("DELETE FROM public.doctors WHERE uid='gone'")
    x.run(allow_peak=True, mode="full")
    assert count(owner, "doctors") == 5


def test_provenance_rows(conns):
    src, dst, owner, _ = conns
    x, _ = extractor(src, dst, batch_size=2)
    run_id, counts = x.run(allow_peak=True, mode="full")
    r = owner.execute("SELECT status, mode, rows, db13_snapshot_now, queries, started_at, ended_at, error_class FROM studio_dw.extract_runs WHERE run_id=%s", [run_id]).fetchone()
    assert r[0] == "ok" and r[1] == "full" and r[2] == counts and r[3] is not None and r[4] > 8 and r[6] >= r[5] and r[7] is None
    tabs = {n: rest for n, *rest in owner.execute("SELECT table_name, status, rows_read, fetches, db13_snapshot, db13_snapshot_now, fetch_seconds, watermark_to "
                                                   "FROM studio_dw.extract_run_tables WHERE run_id=%s", [run_id])}
    assert set(tabs) == {t.name for t in TABLES}
    for n, (st, rows, fetches, snap, snow, secs, wto) in tabs.items():
        assert st == "ok" and rows == counts[n] and fetches >= 2 and ":" in snap and snow is not None and secs is not None and wto == snow
    assert owner.execute("SELECT count(*) FROM studio_dw.extract_run_tables WHERE run_id=%s AND fetch_seconds IS NOT NULL AND load_seconds IS NOT NULL", [run_id]).fetchone()[0] == 8
    assert owner.execute("SELECT count(*) FROM studio_ro.dw_extract_status WHERE status='ok'").fetchone()[0] == 1
    assert owner.execute("SELECT count(*) FROM studio_ro.dw_extract_tables").fetchone()[0] == 8


def test_failure_stops_and_records_class_only(conns):
    src, dst, owner, sup = conns
    sup.execute("ALTER TABLE public.surgery_cases RENAME COLUMN status TO status_x")
    try:
        x, _ = extractor(src, dst)
        with pytest.raises(psycopg.errors.UndefinedColumn):
            x.run(allow_peak=True, mode="full")
        r = owner.execute("SELECT status, error_class, rows FROM studio_dw.extract_runs").fetchone()
        assert r[0] == "failed" and r[1] == "UndefinedColumn" and "doctors" not in r[2]  # stopped at the first error
        assert src.info.transaction_status == psycopg.pq.TransactionStatus.IDLE  # source txn rolled back
    finally:
        sup.execute("ALTER TABLE public.surgery_cases RENAME COLUMN status_x TO status")


def test_throttle_and_batching(conns):
    src, dst, owner, _ = conns
    x, ck = extractor(src, dst, batch_size=2)
    x.run(allow_peak=True, mode="full")
    calls = x.throttle.calls
    assert calls >= 60  # session statements + DECLARE + every FETCH all count
    assert ck.t >= 0.5 * (calls - 1) - 1e-6  # <= 2 statements per second
    assert min(ck.sleeps) > 0 and max(ck.sleeps) <= 0.5 + 1e-9
    assert owner.execute("SELECT fetches FROM studio_dw.extract_run_tables WHERE table_name='doctors'").fetchone()[0] == 4  # 2+2+1+empty
    with pytest.raises(ValueError):
        job.Throttle(qps=3)


def test_one_read_only_transaction_per_table(conns):
    src, dst, owner, _ = conns
    seen = []

    class Spy:
        def __init__(self, c):
            self.c = c

        def execute(self, sql, *a):
            seen.append(sql.split()[0])
            return self.c.execute(sql, *a)

        def cursor(self, **k):
            return self.c.cursor(**k)

    x = job.Extract(Spy(src), dst, throttle=job.Throttle(clock=Clock().now, sleep=lambda s: None), log=lambda *_: None)
    x.run(allow_peak=True, mode="full")
    assert seen.count("BEGIN") == seen.count("COMMIT") == 8 and "ROLLBACK" not in seen
    depth = 0
    for s in seen:  # transactions never nest or overlap
        depth += s == "BEGIN"
        assert depth <= 1
        depth -= s == "COMMIT"


def test_table_over_the_limit_times_out_others_continue(conns):
    src, dst, owner, _ = conns
    ck = Clock()
    x = job.Extract(src, dst, throttle=job.Throttle(clock=ck.now, sleep=ck.sleep), log=lambda *_: None, clock=ck.now,
                    batch_size=1, max_txn_seconds=1.0)
    run_id, counts = x.run(allow_peak=True, mode="full", tables=["individuals_prescriptions", "doctors"])
    st = dict(owner.execute("SELECT table_name, status FROM studio_dw.extract_run_tables WHERE run_id=%s", [run_id]).fetchall())
    assert set(st) == {"individuals_prescriptions", "doctors"} and st["individuals_prescriptions"] == "timeout"
    assert owner.execute("SELECT status FROM studio_dw.extract_runs WHERE run_id=%s", [run_id]).fetchone()[0] == "partial"
    assert "individuals_prescriptions" not in x.previous_watermarks()  # a timed-out table never advances its watermark
    assert src.info.transaction_status == psycopg.pq.TransactionStatus.IDLE
    assert job.MAX_TXN_SECONDS == 900  # default: no DB13 transaction longer than 15 minutes
    ck2 = Clock()
    y = job.Extract(src, dst, throttle=job.Throttle(clock=ck2.now, sleep=ck2.sleep), log=lambda *_: None, clock=ck2.now, batch_size=1, max_txn_seconds=1000)
    rid, _ = y.run(allow_peak=True, mode="full", tables=["doctors"])
    assert owner.execute("SELECT status FROM studio_dw.extract_runs WHERE run_id=%s", [rid]).fetchone()[0] == "ok"


def test_large_tables_only_in_the_offpeak_window(conns):
    src, dst, owner, _ = conns
    x, _ = extractor(src, dst)
    day = dt.datetime(2026, 10, 22, 14, 0, tzinfo=job.IST)
    run_id, counts = x.run(mode="full", now=day)
    skipped = {n for (n,) in owner.execute("SELECT table_name FROM studio_dw.extract_run_tables WHERE run_id=%s AND status='skipped'", [run_id])}
    assert skipped == {t.name for t in TABLES if t.large} == {"individuals_prescriptions", "dpipe_prescription_pipeline", "dpipe_prescription_diagnosis", "kx_billing_records"}
    assert set(counts) == {t.name for t in TABLES if not t.large}
    assert owner.execute("SELECT status FROM studio_dw.extract_runs WHERE run_id=%s", [run_id]).fetchone()[0] == "partial"
    assert count(owner, "individuals_prescriptions") == 0 and count(owner, "doctors") == 5
    night = dt.datetime(2026, 10, 22, 23, 0, tzinfo=job.IST)
    run_id, counts = x.run(mode="full", now=night)
    assert set(counts) == {t.name for t in TABLES} and count(owner, "individuals_prescriptions") == 5


def test_child_view_shows_only_the_latest_ok_run(conns):
    src, dst, owner, _ = conns
    x, _ = extractor(src, dst)
    x.run(allow_peak=True, mode="full")
    x.run(allow_peak=True, mode="full")
    assert count(owner, "dpipe_prescription_diagnosis") == 10  # older run's rows deleted
    assert owner.execute("SELECT count(*) FROM studio_ro.dw_dpipe_prescription_diagnosis").fetchone()[0] == 10
    owner.execute("INSERT INTO studio_dw.dpipe_prescription_diagnosis (_parent_id, diagnosis, icd_code, _run_id) VALUES ('zz','x','y',gen_random_uuid())")
    assert owner.execute("SELECT count(*) FROM studio_ro.dw_dpipe_prescription_diagnosis").fetchone()[0] == 10  # a run in progress is invisible


def test_killed_run_is_recorded_and_rolled_back(conns):
    src, dst, owner, _ = conns

    class KillAt(job.Throttle):
        def wait(self):
            super().wait()
            if self.calls == 17:
                raise job.Killed(15)

    ck = Clock()
    x = job.Extract(src, dst, throttle=KillAt(clock=ck.now, sleep=ck.sleep), log=lambda *_: None)
    with pytest.raises(job.Killed):
        x.run(allow_peak=True, mode="full")
    assert owner.execute("SELECT status, error_class FROM studio_dw.extract_runs").fetchone() == ("killed", "Killed")
    assert "killed" in {s for (s,) in owner.execute("SELECT status FROM studio_dw.extract_run_tables")}
    assert src.info.transaction_status == psycopg.pq.TransactionStatus.IDLE


def test_idle_in_transaction_is_5_minutes_statement_timeout_60s(conns):
    src, _, _, _ = conns
    job.begin_read_only(job.Session(src, throttle=job.Throttle(clock=Clock().now, sleep=lambda s_: None)))
    assert src.execute("SHOW idle_in_transaction_session_timeout").fetchone()[0] == "5min"
    assert src.execute("SHOW statement_timeout").fetchone()[0] == "1min"
    src.execute("ROLLBACK")


def test_readonly_enforced(conns):
    src, dst, owner, _ = conns
    job.begin_read_only(job.Session(src, throttle=job.Throttle(clock=Clock().now, sleep=lambda s: None)))
    with pytest.raises(psycopg.errors.ReadOnlySqlTransaction, match="cannot execute CREATE TABLE in a read-only transaction"):
        src.execute("CREATE TABLE public.nope (a int)")
    src.execute("ROLLBACK")

    class NotReadOnly:  # a source that silently drops READ ONLY (e.g. a pooler): the job must refuse
        def __init__(self, c):
            self.c, self.seen = c, []

        def execute(self, sql, *a):
            self.seen.append(sql)
            return self.c.execute(sql.replace("READ ONLY ISOLATION LEVEL REPEATABLE READ", "READ WRITE"), *a)

    w = NotReadOnly(src)
    x = job.Extract(w, dst, log=lambda *_: None, throttle=job.Throttle(clock=Clock().now, sleep=lambda s: None))
    with pytest.raises(job.ReadOnlyRefused):
        x.run(allow_peak=True, mode="full")
    assert not any("FROM public" in s for s in w.seen)  # no data query was sent
    assert owner.execute("SELECT status, error_class FROM studio_dw.extract_runs").fetchone() == ("failed", "ReadOnlyRefused")


def test_verify_session(conns):
    src, _, _, _ = conns
    lines = []
    assert job.verify_session(src, "ro_user", log=lines.append, throttle=job.Throttle(clock=Clock().now, sleep=lambda s: None)) is True
    assert len(lines) == 6 and sum(l.startswith("PASS") for l in lines) == 5 and sum(l.startswith("INFO") for l in lines) == 1
    lines.clear()
    assert job.verify_session(src, "someone_else", log=lines.append, throttle=job.Throttle(clock=Clock().now, sleep=lambda s: None)) is False
    assert sum(l.startswith("FAIL") for l in lines) == 1


def test_offpeak_window():
    ist = job.IST
    assert job.in_offpeak_window(dt.datetime(2026, 10, 22, 22, 0, tzinfo=ist))
    assert job.in_offpeak_window(dt.datetime(2026, 10, 22, 6, 59, tzinfo=ist))
    assert not job.in_offpeak_window(dt.datetime(2026, 10, 22, 7, 0, tzinfo=ist))
    assert not job.in_offpeak_window(dt.datetime(2026, 10, 22, 14, 0, tzinfo=ist))


def test_studio_gov_ro_reads_views_not_tables(clusters):
    _, gov = clusters
    with psycopg.connect(url(gov, "studio_gov_ro", "govdb"), autocommit=True) as c:
        for t in TABLES:
            c.execute(f"SELECT count(*) FROM studio_ro.dw_{t.name}").fetchone()
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                c.execute(f"SELECT 1 FROM studio_dw.{t.name} LIMIT 1")
        c.execute("SELECT count(*) FROM studio_ro.dw_extract_status").fetchone()
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute("SELECT 1 FROM studio_dw.extract_runs")


def test_writer_confined_to_studio_dw(clusters):
    _, gov = clusters
    with psycopg.connect(url(gov, "studio_dw_writer", "govdb"), autocommit=True) as c:
        c.execute("INSERT INTO studio_dw.doctors (uid, _run_id) VALUES ('w', gen_random_uuid())")
        c.execute("DELETE FROM studio_dw.doctors WHERE uid='w'")
        for sql in ("SELECT 1 FROM public.physicians", "SELECT 1 FROM public.incidents", "INSERT INTO public.physicians VALUES (1)",
                    "SELECT 1 FROM studio_ro.dw_doctors", "TRUNCATE studio_dw.doctors", "CREATE TABLE public.x (a int)",
                    "CREATE TABLE studio_dw.x (a int)", "CREATE SCHEMA evil", "DROP TABLE studio_dw.doctors"):
            with pytest.raises(psycopg.errors.Error):
                c.execute(sql)
    with psycopg.connect(url(gov, "gov_owner", "govdb"), autocommit=True) as o:
        r = o.execute("SELECT rolcanlogin FROM pg_roles WHERE rolname='studio_dw_writer'").fetchone()
        assert r[0] is True  # flipped by the fixture only; 0012 itself creates it NOLOGIN (next test)


def test_0012_creates_nologin_and_is_idempotent(clusters):
    _, gov = clusters
    with psycopg.connect(url(gov, "gov_owner", "govdb"), autocommit=True) as o:
        text = SQL_0012.read_text()
        assert "NOLOGIN" in text and not re.search(r"PASSWORD\s+'", text, re.I)
        apply_0012(o)
        apply_0012(o)
        assert o.execute("SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname IN ('studio_dw_writer','studio_gov_ro')").fetchone()[0] == 0


def test_0012_postcheck_rejects_leaks(clusters):
    _, gov = clusters
    cases = (
        ("GRANT SELECT ON studio_dw.doctors TO studio_gov_ro", "REVOKE ALL ON studio_dw.doctors FROM studio_gov_ro", "studio_gov_ro can read"),
        ("GRANT SELECT ON public.physicians TO PUBLIC", "REVOKE ALL ON public.physicians FROM PUBLIC", "outside studio_dw"),
        ("GRANT TRUNCATE ON studio_dw.doctors TO PUBLIC", "REVOKE ALL ON studio_dw.doctors FROM PUBLIC", "not exactly"),
    )
    with psycopg.connect(url(gov, "gov_owner", "govdb"), autocommit=True) as o:
        for grant, revoke, msg in cases:
            o.execute(grant)
            try:
                with pytest.raises(psycopg.errors.Error, match=msg):
                    apply_0012(o)
                o.execute("ROLLBACK")  # the file's BEGIN is left open by the failed post-check
            finally:
                o.execute(revoke)
        # a direct grant to the writer is simply reset by the file
        o.execute("GRANT SELECT ON public.physicians TO studio_dw_writer")
        apply_0012(o)
        assert not o.execute("SELECT has_table_privilege('studio_dw_writer','public.physicians','SELECT')").fetchone()[0]


def test_cli_env_and_flags(tmp_path, monkeypatch, capsys):
    f = tmp_path / "ada.env"
    f.write_text("\n".join(f"{k}=value-{k}" for k in cli.NEEDED) + "\nDATA_BACKEND=x\n")
    f.chmod(0o644)
    with pytest.raises(SystemExit) as e:
        cli.read_env(f)
    assert "value-" not in str(e.value)
    f.chmod(0o600)
    env = cli.read_env(f)
    assert env["PG_PASSWORD"] == "value-PG_PASSWORD"
    f.write_text("PG_HOST=h\n")
    f.chmod(0o600)
    with pytest.raises(SystemExit) as e:
        cli.read_env(f)
    assert "PG_PASSWORD" in str(e.value)
    flag = tmp_path / "DISABLED"
    flag.write_text("")
    monkeypatch.setattr(cli, "KILL_FLAG", flag)
    assert cli.main(["run"]) == 3
    assert "disabled" in capsys.readouterr().out


def test_launchd_plist_and_runner():
    p = plistlib.loads((DB13 / "extract" / "com.even.studio-dw-extract.plist").read_bytes())
    assert p["Label"] == "com.even.studio-dw-extract" and p["ProgramArguments"][-1] == "scheduled"
    assert p["StartCalendarInterval"]["Hour"] == 22
    sh = DB13 / "extract" / "run-extract.sh"
    assert sh.stat().st_mode & stat.S_IXUSR


# ---- fable conditions (22 Oct 14:30): pinned queries, application_name, no credentials leaking ----------------------

CATALOGUE = set("""M-AMS-01 M-AMS-02 M-AMS-03 M-AMS-04 M-AMS-05 M-DOC-01 M-IPD-01 M-IPD-02 M-IPD-03 M-IPD-04 M-LVC-01 M-LVC-02 M-LVC-03
M-OPD-01 M-OPD-02 M-OPD-03 M-OPD-04 M-OPD-05 M-OPD-06 M-OPD-07 M-OPD-08 M-OPD-09 M-OPD-10 M-OPD-11 M-OPD-12 M-OPD-13 M-OPD-14
M-OPD-15 M-OPD-16 M-OT-01 M-PRE-01 M-PRE-02 M-PRE-03 M-PRE-04 M-PRE-05 M-PRE-06 M-PRE-07 M-PRE-08 M-RDM-01 M-RDM-02 M-RDM-03
M-RDM-04 M-STAY-01""".split())


def test_every_column_has_real_catalogue_metric_ids():
    for t in TABLES:
        for c in t.cols:
            ids_ = [i for i in c.metrics.split(",") if i]
            assert set(ids_) <= CATALOGUE, (t.name, c.name, c.metrics)  # nothing but catalogue ids
            if not ids_:
                assert c.purpose.startswith("key"), (t.name, c.name)  # only technical keys may lack one
            else:
                assert c.purpose, (t.name, c.name)  # why it is there lives in purpose
    assert not {c.name for t in TABLES for c in t.cols} & {"email", "name_with_prefix"}


def test_manifest_matches_spec_and_hashes_every_query():
    import json

    committed = json.loads(manifest.MANIFEST.read_text())
    assert committed == manifest.generate()  # run `python -m extract.manifest write` after a reviewed spec change
    assert len(committed["queries"]) == len(queries.all_queries()) >= 8 * 2
    assert all(len(h) == 64 for h in committed["queries"].values())


def test_modified_query_is_refused_before_it_reaches_db13(conns, monkeypatch):
    src, dst, owner, _ = conns
    seen = []

    class Spy:
        def __init__(self, c):
            self.c = c

        def execute(self, sql, *a):
            seen.append(sql)
            return self.c.execute(sql, *a)

        def cursor(self, **k):
            raise AssertionError("cursor opened for an unpinned query")

    orig = queries.cursor_sql
    monkeypatch.setattr(queries, "cursor_sql", lambda *a, **k: orig(*a, **k) + " -- sneaky")
    x = job.Extract(Spy(src), dst, throttle=job.Throttle(clock=Clock().now, sleep=lambda s: None), log=lambda *_: None)
    with pytest.raises(job.QueryNotPinned) as e:
        x.run(allow_peak=True, mode="full", tables=["doctors"])
    assert "sneaky" not in str(e.value) and "FROM" not in str(e.value)
    assert not any("sneaky" in s for s in seen)  # never sent
    assert owner.execute("SELECT status FROM studio_dw.extract_runs").fetchone()[0] == "failed"
    assert src.info.transaction_status == psycopg.pq.TransactionStatus.IDLE


def test_manifest_missing_a_hash_refuses(conns):
    src, dst, _, _ = conns
    mk = lambda drop: job.Session(src, manifest.load() - {queries.sha(drop)}, job.Throttle(clock=Clock().now, sleep=lambda s: None))
    # a session statement that is not pinned is refused too (they go through the same check as data queries)
    x = job.Extract(mk(queries.SET_IDLE_SQL), dst, log=lambda *_: None)
    with pytest.raises(job.QueryNotPinned):
        x.run(allow_peak=True, mode="full", tables=["doctors"])
    src.execute("ROLLBACK")
    with pytest.raises(job.QueryNotPinned):
        job.verify_session(mk(queries.count_sql(BY_NAME["doctors"])), "ro_user", log=lambda *_: None)
    src.execute("ROLLBACK")


ENV = {"ADA_HOST": "ada.invalid", "SSH_USER": "u1", "SSH_KEY": "/k/id", "PG_HOST": "10.0.0.5", "PG_PORT": "5433", "PG_DB": "postgres",
       "PG_USER": "ro_user", "PG_PASSWORD": "STANDIN-pw-9f3a"}


def test_application_name_and_kwargs():
    kw = cli.db13_kwargs(ENV, 4242)
    assert kw["application_name"] == "gov-studio-extract" and kw["autocommit"] is True and kw["sslmode"] == "disable"


def test_application_name_visible_on_the_server(clusters):
    db13, _ = clusters
    kw = cli.db13_kwargs(ENV, 0)
    with psycopg.connect(url(db13, "ro_user"), application_name=kw["application_name"], autocommit=True) as c:
        assert c.execute("SHOW application_name").fetchone()[0] == "gov-studio-extract"
        assert c.execute("SELECT count(*) FROM pg_stat_activity WHERE application_name='gov-studio-extract'").fetchone()[0] >= 1


def test_tunnel_argv_and_config_carry_no_password(monkeypatch):
    argv_seen = []

    class FakeProc:
        def poll(self):
            return None

        def terminate(self):
            pass

        def wait(self, *_):
            pass

    def popen(argv, **kw):
        argv_seen.append((list(argv), dict(kw)))
        cfg = Path(argv[argv.index("-F") + 1])
        argv_seen.append(cfg.read_text())
        assert stat.S_IMODE(cfg.stat().st_mode) == 0o600
        return FakeProc()

    monkeypatch.setattr(cli.subprocess, "Popen", popen)
    monkeypatch.setattr(cli.socket, "create_connection", lambda *a, **k: type("S", (), {"close": lambda s: None})())
    with cli.tunnel(ENV):
        pass
    argv, kw = argv_seen[0]
    cfg_text = argv_seen[1]
    assert argv[:3] == ["ssh", "-N", "-F"] and "STANDIN-pw-9f3a" not in " ".join(argv)
    assert "ada.invalid" not in " ".join(argv) and "u1@" not in " ".join(argv) and "PG_PASSWORD" not in cfg_text
    assert "STANDIN-pw-9f3a" not in cfg_text and "IdentityFile /k/id" in cfg_text and "LocalForward" in cfg_text
    assert "STANDIN-pw-9f3a" not in repr(kw)  # nor in the child's environment arguments


def test_password_never_in_logs_argv_or_rows(clusters, tmp_path, monkeypatch, capsys):
    db13, gov = clusters
    pw = ENV["PG_PASSWORD"]
    env_file = tmp_path / "ada.env"
    env_file.write_text("\n".join(f"{k}={v}" for k, v in ENV.items()) + "\n")
    env_file.chmod(0o600)
    dsn = tmp_path / "writer-url"
    dsn.write_text(url(gov, "studio_dw_writer", "govdb") + "\n")
    dsn.chmod(0o600)
    state = tmp_path / "state"
    monkeypatch.setattr(cli, "ADA_ENV", env_file)
    monkeypatch.setattr(cli, "DW_DSN_FILE", dsn)
    monkeypatch.setattr(cli, "STATE", state)
    monkeypatch.setattr(cli, "LOCK", state / "run.lock")
    monkeypatch.setattr(cli, "KILL_FLAG", state / "DISABLED")
    monkeypatch.setattr(cli, "PEAK_FLAG", state / "ALLOW_PEAK")
    state.mkdir()
    (state / "ALLOW_PEAK").write_text("")
    popen_args = []
    monkeypatch.setattr(cli.subprocess, "Popen", lambda *a, **k: popen_args.append((a, k)))

    @cli.contextmanager
    def fake_tunnel(env):
        yield 0

    captured = {}

    def fake_conn(env, port):
        captured["kw"] = cli.db13_kwargs(env, port)  # the password is allowed here, in-process only
        return psycopg.connect(url(db13, "ro_user"), application_name=captured["kw"]["application_name"], autocommit=True)

    monkeypatch.setattr(cli, "tunnel", fake_tunnel)
    monkeypatch.setattr(cli, "Throttle", lambda: job.Throttle(clock=Clock().now, sleep=lambda s: None))
    monkeypatch.setattr(cli, "db13_conn", fake_conn)
    with psycopg.connect(url(gov, "gov_owner", "govdb"), autocommit=True) as o:
        o.execute("TRUNCATE " + ", ".join(f"studio_dw.{t.name}" for t in TABLES) + ", studio_dw.extract_run_tables, studio_dw.extract_runs")
        assert cli.main(["run", "--full", "--i-know-its-peak"]) == 0
        # a failing run too: only the class is printed
        with psycopg.connect(db13.get_uri(), autocommit=True) as sup:
            sup.execute("ALTER TABLE public.surgery_cases RENAME COLUMN status TO status_x")
            try:
                assert cli.main(["run", "--full", "--tables", "surgery_cases"]) == 1
            finally:
                sup.execute("ALTER TABLE public.surgery_cases RENAME COLUMN status_x TO status")
        out = capsys.readouterr()
        assert pw not in out.out and pw not in out.err
        assert "FAILED: UndefinedColumn" in out.out
        assert captured["kw"]["password"] == pw and captured["kw"]["application_name"] == "gov-studio-extract"
        dump = o.execute("SELECT string_agg(t::text, ' ') FROM studio_dw.extract_runs t").fetchone()[0]
        for tb in TABLES:
            dump += " " + (o.execute(f"SELECT coalesce(string_agg(t::text, ' '), '') FROM studio_dw.{tb.name} t").fetchone()[0])
        assert pw not in dump and "ada.invalid" not in dump and "10.0.0.5" not in dump
    assert pw not in repr(popen_args)


def test_probe_is_at_most_10_connects(monkeypatch):
    attempts = []

    class FakeProc:
        terminated = False

        def poll(self):
            return None

        def terminate(self):
            FakeProc.terminated = True

        def wait(self, *_):
            pass

    def refuse(*a, **k):
        attempts.append(1)
        raise OSError("nope")

    sleeps, cfgs = [], []
    monkeypatch.setattr(cli.subprocess, "Popen", lambda argv, **k: cfgs.append(Path(argv[argv.index("-F") + 1])) or FakeProc())
    monkeypatch.setattr(cli.socket, "create_connection", refuse)
    monkeypatch.setattr(cli.time, "sleep", sleeps.append)
    with pytest.raises(RuntimeError):
        with cli.tunnel(ENV):
            pass
    assert len(attempts) == cli.PROBE_ATTEMPTS == 10 and sleeps == sorted(sleeps) and max(sleeps) <= 4
    assert FakeProc.terminated and not cfgs[0].exists() and not cfgs[0].parent.exists()


def test_peak_override_needs_the_flag_file(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(cli, "KILL_FLAG", tmp_path / "DISABLED")
    monkeypatch.setattr(cli, "PEAK_FLAG", tmp_path / "ALLOW_PEAK")
    assert cli.main(["run", "--i-know-its-peak"]) == 6
    assert "flag file" in capsys.readouterr().out


FAKE_SSH = """#!{py}
import os, socket, sys
cfg = sys.argv[sys.argv.index("-F") + 1]
port = int([l for l in open(cfg) if "LocalForward" in l][0].split()[1].split(":")[1])
open(os.environ["FAKE_SSH_PID"], "w").write(str(os.getpid()))
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("127.0.0.1", port)); s.listen(5)
conns = []
while True:  # accept and never answer: the client hangs in its startup handshake
    conns.append(s.accept()[0])
"""


@pytest.mark.parametrize("sig", ["SIGTERM", "SIGHUP", "SIGINT"])
def test_signals_clean_up_ssh_config_and_child(tmp_path, sig):
    import os
    import signal
    import subprocess
    import time as _t

    sg = getattr(signal, sig)
    bin_dir, tmpdir, home = tmp_path / "bin", tmp_path / "tmp", tmp_path / "home"
    for d in (bin_dir, tmpdir, home):
        d.mkdir()
    ssh = bin_dir / "ssh"
    ssh.write_text(FAKE_SSH.format(py=sys.executable))
    ssh.chmod(0o755)
    env_file = tmp_path / "ada.env"
    env_file.write_text("\n".join(f"{k}={v}" for k, v in ENV.items()) + "\n")
    env_file.chmod(0o600)
    pidfile = tmp_path / "ssh.pid"
    env = {"PATH": f"{bin_dir}:{os.environ['PATH']}", "HOME": str(home), "TMPDIR": str(tmpdir), "ADA_ENV_FILE": str(env_file),
           "FAKE_SSH_PID": str(pidfile)}
    p = subprocess.Popen([sys.executable, "-m", "extract.cli", "run"], cwd=DB13, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        for _ in range(100):
            if pidfile.exists() and pidfile.read_text():
                break
            _t.sleep(0.1)
        else:
            pytest.fail("fake ssh never started")
        _t.sleep(1.5)  # the job is now connecting through the tunnel
        assert list(tmpdir.glob("gov-studio-ssh-*")), "ssh config should exist while running"
        child = int(pidfile.read_text())
        p.send_signal(sg)
        out, _ = p.communicate(timeout=30)
    finally:
        if p.poll() is None:
            p.kill()
    assert p.returncode == 128 + sg, out
    assert "KILLED" in out and ENV["PG_PASSWORD"] not in out
    assert not list(tmpdir.glob("gov-studio-ssh-*"))  # config gone
    for _ in range(50):  # no orphaned ssh
        try:
            os.kill(child, 0)
        except ProcessLookupError:
            break
        _t.sleep(0.1)
    else:
        os.kill(child, signal.SIGKILL)
        pytest.fail("ssh child still alive")


# ---- spill: fetch-only DB13 txn, then load from a 0600 file; the file never outlives the run ------------------------

def test_default_spill_root_is_under_library_caches_not_tmp():
    import importlib

    fresh = importlib.reload(job)
    try:
        assert str(fresh.SPILL_ROOT).endswith("Library/Caches/gov-studio-extract") and not str(fresh.SPILL_ROOT).startswith("/tmp")
    finally:
        importlib.reload(job)


def test_db13_txn_is_closed_before_neon_load_and_spill_is_private(conns, spill_root):
    src, dst, owner, _ = conns
    x, _ = extractor(src, dst, batch_size=2)
    seen = {}
    orig = job.Extract._load_from_spill

    def spy(self, t, path, mode):
        seen.setdefault(t.name, (src.info.transaction_status, stat.S_IMODE(path.stat().st_mode), stat.S_IMODE(path.parent.stat().st_mode),
                                 stat.S_IMODE(spill_root.stat().st_mode), path.parent.parent == spill_root))
        return orig(self, t, path, mode)

    job.Extract._load_from_spill = spy
    try:
        run_id, counts = x.run(allow_peak=True, mode="full")
    finally:
        job.Extract._load_from_spill = orig
    assert set(seen) == {t.name for t in TABLES}
    assert all(v == (psycopg.pq.TransactionStatus.IDLE, 0o600, 0o700, 0o700, True) for v in seen.values())  # DB13 txn already committed
    assert not list(spill_root.iterdir())  # success: spill deleted
    rows = owner.execute("SELECT fetch_seconds, load_seconds FROM studio_dw.extract_run_tables WHERE run_id=%s", [run_id]).fetchall()
    assert len(rows) == 8 and all(f is not None and l is not None for f, l in rows)


def test_spill_deleted_on_failure_and_on_kill_during_load(conns, spill_root, monkeypatch):
    src, dst, owner, _ = conns
    for exc, status in ((RuntimeError("boom"), "failed"), (job.Killed(15), "killed")):
        x, _ = extractor(src, dst)

        def boom(self, t, path, mode, exc=exc):
            assert path.exists() and path.stat().st_size > 0
            raise exc

        monkeypatch.setattr(job.Extract, "_load_from_spill", boom)
        with pytest.raises(type(exc)):
            x.run(allow_peak=True, mode="full", tables=["doctors"])
        assert not list(spill_root.iterdir()), status
        assert owner.execute("SELECT status FROM studio_dw.extract_runs ORDER BY started_at DESC LIMIT 1").fetchone()[0] == status
        monkeypatch.undo()


def test_timeout_during_fetch_leaves_no_spill_and_loads_nothing(conns, spill_root):
    src, dst, owner, _ = conns
    ck = Clock()
    x = job.Extract(src, dst, throttle=job.Throttle(clock=ck.now, sleep=ck.sleep), log=lambda *_: None, clock=ck.now, batch_size=1, max_txn_seconds=1.0)
    x.run(allow_peak=True, mode="full", tables=["individuals_prescriptions"])
    assert not list(spill_root.iterdir()) and count(owner, "individuals_prescriptions") == 0


def test_stale_spill_from_a_sigkilled_run_is_swept(conns, spill_root):
    src, dst, _, _ = conns
    old = spill_root / "run-dead"
    old.mkdir(parents=True)
    (old / "x.spill").write_bytes(b"x")
    x, _ = extractor(src, dst)
    x.run(allow_peak=True, mode="full", tables=["doctors"])
    assert not list(spill_root.iterdir())


DRIVER = """
import sys, time
sys.path.insert(0, {db13!r})
import psycopg
from extract import cli, job

class Slow(job.Throttle):
    def wait(self):
        time.sleep(0.4)
        super().wait()

cli.install_signal_handlers()
src = psycopg.connect({src!r}, autocommit=True)
dst = psycopg.connect({dst!r}, autocommit=True)
try:
    job.Extract(src, dst, throttle=Slow(), batch_size=1, log=lambda *_: None).run(allow_peak=True, mode="full", tables=["individuals_prescriptions"])
except job.Killed as k:
    print("KILLED")
    sys.exit(128 + k.args[0])
"""


@pytest.mark.parametrize("sig", ["SIGTERM", "SIGHUP", "SIGINT"])
def test_signal_during_fetch_deletes_the_spill(clusters, tmp_path, sig):
    import os
    import signal
    import subprocess
    import time as _t

    db13, gov = clusters
    sg = getattr(signal, sig)
    home = tmp_path / "home"
    home.mkdir()
    script = tmp_path / "driver.py"
    script.write_text(DRIVER.format(db13=str(DB13), src=url(db13, "ro_user"), dst=url(gov, "studio_dw_writer", "govdb")))
    root = home / "Library" / "Caches" / "gov-studio-extract"
    p = subprocess.Popen([sys.executable, str(script)], env={**os.environ, "HOME": str(home)}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        for _ in range(150):
            files = list(root.glob("run-*/*.spill"))
            if files:
                break
            _t.sleep(0.1)
        else:
            pytest.fail("no spill file appeared")
        assert stat.S_IMODE(files[0].stat().st_mode) == 0o600 and stat.S_IMODE(files[0].parent.stat().st_mode) == 0o700
        p.send_signal(sg)
        out, _ = p.communicate(timeout=30)
    finally:
        if p.poll() is None:
            p.kill()
    assert p.returncode == 128 + sg, out
    assert not list(root.glob("run-*")), "spill dir must be gone after the signal"
