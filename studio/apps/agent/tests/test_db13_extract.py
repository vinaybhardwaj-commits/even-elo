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
from extract import cli, job  # noqa: E402
from extract.spec import BY_NAME, TABLES  # noqa: E402

pytestmark = pytest.mark.skipif(importlib.util.find_spec("pgserver") is None, reason="needs pgserver")

K = {"individuals_prescriptions": "_id", "kx_ip_admissions": "_id", "kx_discharged_completed_patients": "_id", "kx_billing_records": "_id"}
UUIDS = [str(uuid.UUID(int=i + 1)) for i in range(5)]
EXTRA = {  # source-only columns: filter columns and sensitive columns the extract must never copy
    "individuals_prescriptions": ["free_text text", "patient_details__allergies text"],
    "dpipe_prescription_pipeline": ["name text", "mobile text", "membership_id text"],
    "kx_ip_admissions": ["modified_at timestamptz", "patient_name text", "patient_address text", "uhid text"],
    "kx_discharged_completed_patients": ["modified_at timestamptz", "patient_age text", "payer_type text"],
    "kx_billing_records": ["amount numeric", "net_amt numeric"],
    "surgery_cases": ["updated_at timestamptz", "financial__amount numeric"],
    "doctors": ["mobile text", "bank_account__number text", "uploaded_proofs__pan text", "tariffs jsonb", "karexpert_metadata__mobile text"],
}
SENSITIVE = {"free_text", "patient_details__allergies", "name", "mobile", "membership_id", "patient_name", "patient_address", "patient_age",
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
        c.execute(f"""INSERT INTO public."individuals-prescriptions" (_id,_parent_id,uid,doctor_uid,"timestamp",uploaded_at,is_draft,medications,
                        diagnosis_icd_codes,consult_types,free_text) VALUES (%s,%s,%s,'d1',{now},{now},false,%s::jsonb,%s,%s,'SECRET')""",
                  [u, f"p{i}", f"u{i}", '[{"generic":"x"}]', ["M54.5"], ["opd"]])
        c.execute(f"""INSERT INTO public.kx_ip_admissions (_id,uid,encounter_id,current_treating_doctor_id,facility_name,admission_date_time,
                        encounter_type,modified_at,patient_name,uhid) VALUES (%s,%s,%s,'t1','Even-EHRC',{now},'ip_admission',{now},'PHI','UH1')""",
                  [u, f"a{i}", f"e{i}"])
        c.execute(f"""INSERT INTO public.kx_discharged_completed_patients (_id,uid,encounter_id,uhid,facility_name,discharge_date,status,modified_at)
                        VALUES (%s,%s,%s,'UH1','Even',{now},'completed',{now})""", [u, f"a{i}", f"e{i}"])
        c.execute(f"INSERT INTO public.kx_billing_records (_id,uid,uhid,patient_type,bill_date_time,amount) VALUES (%s,%s,'UH1','IP',{now},99)", [u, f"b{i}"])
        c.execute(f"INSERT INTO public.dpipe_prescription_pipeline (presc_uid,individual_uid,age,uploaded_at,medicines,name,mobile) "
                  f"VALUES (%s,'i1',{60 + i},{now},'[]'::jsonb,'PHI','999')", [f"rx{i}"])
        c.execute("INSERT INTO public.dpipe_prescription_pipeline__diagnosis (_parent_id,diagnosis,icd_code) VALUES (%s,'LBP','M54.5'),(%s,'HA','R51')",
                  [f"rx{i}", f"rx{i}"])
        c.execute(f"INSERT INTO public.surgery_cases (uid,individual_uid,status,created_at,updated_at,planned_surgery_date,financial__amount) "
                  f"VALUES (%s,'i1','BOOKED',{now},{now},current_date,5)", [f"s{i}"])
        c.execute("INSERT INTO public.doctors (uid,email,name_with_prefix,disabled,mobile,bank_account__number,tariffs) VALUES (%s,%s,'Dr X',false,'999','123','{}')",
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


@pytest.fixture()
def conns(clusters):
    db13, gov = clusters
    src = psycopg.connect(url(db13, "ro_user"), autocommit=True)
    dst = psycopg.connect(url(gov, "studio_dw_writer", "govdb"), autocommit=True)
    owner = psycopg.connect(url(gov, "gov_owner", "govdb"), autocommit=True)
    sup = psycopg.connect(db13.get_uri(), autocommit=True)
    owner.execute("TRUNCATE " + ", ".join(f"studio_dw.{t.name}" for t in TABLES) + ", studio_dw.extract_runs")
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
    run_id, counts = x.run(mode="full")
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
        assert not any(s in row[0] for row in dump for s in ("PHI", "SECRET", "999"))


def test_incremental_watermark(conns):
    src, dst, owner, sup = conns
    x, _ = extractor(src, dst, batch_size=2)
    x.run(mode="incremental")  # no prior run: everything
    assert count(owner, "kx_ip_admissions") == 5
    sup.execute("UPDATE public.kx_ip_admissions SET facility_name='Even-EHBR', modified_at=now()+interval '1 hour' WHERE uid='a2'")
    sup.execute("INSERT INTO public.kx_ip_admissions (_id,uid,encounter_id,modified_at) VALUES (%s,'a9','e9',now()+interval '1 hour')", [str(uuid.UUID(int=99))])
    try:
        _, counts = x.run(mode="incremental")
        assert counts["kx_ip_admissions"] == 2  # only the changed + new row
        assert counts["surgery_cases"] == 0 and counts["individuals_prescriptions"] == 0
        assert counts["doctors"] == 5 and counts["dpipe_prescription_diagnosis"] == 10  # no watermark: always full
        assert owner.execute("SELECT facility_name FROM studio_dw.kx_ip_admissions WHERE uid='a2'").fetchone()[0] == "Even-EHBR"
        assert count(owner, "kx_ip_admissions") == 6
        wm = owner.execute("SELECT watermarks FROM studio_dw.extract_runs WHERE status='ok' ORDER BY started_at DESC LIMIT 1").fetchone()[0]
        assert wm["kx_ip_admissions"]["from"] and wm["kx_ip_admissions"]["to"]
    finally:
        sup.execute("DELETE FROM public.kx_ip_admissions WHERE uid='a9'")
        sup.execute("UPDATE public.kx_ip_admissions SET facility_name='Even-EHRC', modified_at=now() - interval '2 days' WHERE uid='a2'")


def test_full_refresh_drops_vanished_rows(conns):
    src, dst, owner, sup = conns
    x, _ = extractor(src, dst, batch_size=3)
    x.run(mode="full")
    sup.execute("INSERT INTO public.doctors (uid,email) VALUES ('gone','g@x')")
    x.run(mode="full")
    assert count(owner, "doctors") == 6
    sup.execute("DELETE FROM public.doctors WHERE uid='gone'")
    x.run(mode="full")
    assert count(owner, "doctors") == 5


def test_provenance_rows(conns):
    src, dst, owner, _ = conns
    x, _ = extractor(src, dst)
    run_id, counts = x.run(mode="full")
    r = owner.execute("SELECT status, mode, rows, db13_snapshot_now, db13_snapshot, queries, started_at, ended_at, error_class FROM studio_dw.extract_runs WHERE run_id=%s", [run_id]).fetchone()
    assert r[0] == "ok" and r[1] == "full" and r[2] == counts and r[3] is not None and ":" in r[4] and r[5] > 8 and r[7] >= r[6] and r[8] is None
    assert owner.execute("SELECT count(*) FROM studio_ro.dw_extract_status WHERE status='ok'").fetchone()[0] == 1


def test_failure_stops_and_records_class_only(conns):
    src, dst, owner, sup = conns
    sup.execute("ALTER TABLE public.surgery_cases RENAME COLUMN status TO status_x")
    try:
        x, _ = extractor(src, dst)
        with pytest.raises(psycopg.errors.UndefinedColumn):
            x.run(mode="full")
        r = owner.execute("SELECT status, error_class, rows FROM studio_dw.extract_runs").fetchone()
        assert r[0] == "failed" and r[1] == "UndefinedColumn" and "doctors" not in r[2]  # stopped at the first error
        assert src.info.transaction_status == psycopg.pq.TransactionStatus.IDLE  # source txn rolled back
    finally:
        sup.execute("ALTER TABLE public.surgery_cases RENAME COLUMN status_x TO status")


def test_throttle_and_batching(conns):
    src, dst, _, _ = conns
    x, ck = extractor(src, dst, batch_size=2)
    x.run(mode="full")
    calls = x.throttle.calls
    assert calls >= 30  # 5 rows / batch 2 over 8 tables
    assert ck.t >= 0.5 * (calls - 1) - 1e-6  # <= 2 queries per second
    assert min(ck.sleeps) > 0 and max(ck.sleeps) <= 0.5 + 1e-9
    with pytest.raises(ValueError):
        job.Throttle(qps=3)


def test_readonly_enforced(conns):
    src, dst, owner, _ = conns
    job.begin_read_only(src)
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
    x = job.Extract(w, dst, log=lambda *_: None)
    with pytest.raises(job.ReadOnlyRefused):
        x.run(mode="full")
    assert not any("FROM public" in s for s in w.seen)  # no data query was sent
    assert count(owner, "extract_runs") == 0  # and no run row


def test_verify_session(conns):
    src, _, _, _ = conns
    lines = []
    assert job.verify_session(src, "ro_user", log=lines.append) is True
    assert len(lines) == 6 and sum(l.startswith("PASS") for l in lines) == 5 and sum(l.startswith("INFO") for l in lines) == 1
    lines.clear()
    assert job.verify_session(src, "someone_else", log=lines.append) is False
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
