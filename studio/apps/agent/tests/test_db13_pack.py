"""DB13 access pack: runs ops/db13/0001_gov_studio_ro.sql on a throwaway Postgres
with stand-in tables and proves the role, views and VERIFY.sql behave as documented."""
from __future__ import annotations

import re
from pathlib import Path

import psycopg
import pytest

PACK = Path(__file__).resolve().parents[4] / "ops" / "db13"

# Stand-in DB13 tables: real column names (subset used by the views + sensitive extras
# that must NOT reach the views). Quoted identifiers where DB13 uses hyphens.
STANDINS = """
CREATE TABLE public."individuals-prescriptions" (
  _id text, _parent_id text, uid text, consult_uid text, kx_encounter_id text, doctor_uid text,
  "timestamp" timestamptz, uploaded_at timestamptz, is_draft boolean,
  type_of_prescription text, consult_type text, consult_types text[],
  medications jsonb, diagnosis_icd_codes text[], impression_icd_codes text[],
  further_investigation jsonb, free_text text, patient_details__allergies text);
CREATE TABLE public.dpipe_prescription_pipeline (
  uid text, individual_uid text, membership_id text, name text, mobile text, age int,
  "timestamp" timestamptz, presc_uid text, presc_is_draft boolean, uploaded_at timestamptz,
  consult_type text, diagnosis jsonb, medicines jsonb, further_investigation jsonb);
CREATE TABLE public.dpipe_prescription_pipeline__diagnosis (
  _parent_id text, diagnosis text, duration text, icd_code text);
CREATE TABLE public.kx_ip_admissions (
  uid text, uhid text, encounter_id text, encounter_type text, admission_date_time timestamptz,
  current_treating_doctor_id text, facility_name text, patient_name text, patient_address text);
CREATE TABLE public.kx_discharged_completed_patients (
  uid text, uhid text, encounter_id text, encounter_type text, status text, admission_date_time timestamptz,
  discharge_date timestamptz, discharge_type_value text, treating_sub_department_name text,
  facility_name text, patient_age text, payer_type text);
CREATE TABLE public.kx_billing_records (
  uid text, bill_date_time timestamptz, uhid text, patient_type text, amount numeric, net_amt numeric);
CREATE TABLE public.surgery_cases (
  uid text, individual_uid text, status text, created_at timestamptz, prescribed_at timestamptz,
  planned_surgery_date date, hospital_info__hospital_uid text, financial__amount numeric);
CREATE TABLE public.doctors (
  uid text, email text, name_with_prefix text, type text, disabled boolean, mobile text,
  bank_account__number text, uploaded_proofs__pan text, tariffs jsonb,
  karexpert_metadata__uid text, karexpert_metadata__practitioner_id text,
  karexpert_metadata__practitioner_id_by_hospital jsonb, karexpert_metadata__mobile text);
CREATE TABLE public.other_table (x int);
INSERT INTO public.doctors (uid, email, mobile, bank_account__number) VALUES ('d1','a@x','999','123');
INSERT INTO public."individuals-prescriptions" (uid, free_text) VALUES ('u1','secret');
"""

VIEWS = {
    "v_individuals_prescriptions": 15,
    "v_dpipe_prescription_pipeline": 10,
    "v_dpipe_prescription_diagnosis": 3,
    "v_kx_ip_admissions": 6,
    "v_kx_discharged_completed_patients": 10,
    "v_kx_billing_records": 4,
    "v_surgery_cases": 7,
    "v_doctors": 8,
}
FORBIDDEN_COLS = {"mobile", "bank_account__number", "uploaded_proofs__pan", "tariffs", "name", "patient_name",
                  "patient_address", "free_text", "amount", "net_amt", "financial__amount", "membership_id"}


@pytest.fixture(scope="module")
def pg():
    pgserver = pytest.importorskip("pgserver")
    import tempfile
    d = tempfile.mkdtemp(prefix="db13pack-")
    srv = pgserver.get_server(d, cleanup_mode="stop")
    uri = srv.get_uri()
    with psycopg.connect(uri, autocommit=True) as c:
        c.execute(STANDINS)
        c.execute((PACK / "0001_gov_studio_ro.sql").read_text())
    yield uri
    srv.cleanup()


@pytest.fixture()
def role(pg):
    # unix-socket trust auth in pgserver: connect directly as the role
    c = psycopg.connect(pg, user="gov_studio_ro", autocommit=True)
    yield c
    c.close()


def test_sql_has_no_password_or_plaintext():
    t = (PACK / "0001_gov_studio_ro.sql").read_text()
    assert not re.search(r"PASSWORD\s+'", t, re.I)
    assert "\\password" in t


def test_settings_applied(role):
    assert role.execute("SHOW default_transaction_read_only").fetchone()[0] == "on"
    assert role.execute("SHOW statement_timeout").fetchone()[0] == "1min"
    assert role.execute("SHOW idle_in_transaction_session_timeout").fetchone()[0] == "30s"
    assert role.execute("SELECT current_user").fetchone()[0] == "gov_studio_ro"


def test_role_attributes(pg):
    with psycopg.connect(pg, autocommit=True) as c:
        row = c.execute("SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconnlimit,rolcanlogin "
                        "FROM pg_roles WHERE rolname='gov_studio_ro'").fetchone()
        assert row == (False, False, False, False, False, 3, True)
        assert c.execute("SELECT rolpassword FROM pg_authid WHERE rolname='gov_studio_ro'").fetchone()[0] is None


@pytest.mark.parametrize("view,ncols", VIEWS.items())
def test_views_readable_and_column_counts(role, pg, view, ncols):
    role.execute(f"SELECT * FROM gov_studio.{view} LIMIT 1").fetchall()
    with psycopg.connect(pg, autocommit=True) as c:
        cols = {r[0] for r in c.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_schema='gov_studio' AND table_name=%s", (view,))}
    assert len(cols) == ncols
    assert not (cols & FORBIDDEN_COLS)


def test_view_returns_data_without_hidden_columns(role):
    assert role.execute("SELECT count(*) FROM gov_studio.v_doctors").fetchone()[0] == 1
    with pytest.raises(psycopg.errors.UndefinedColumn):
        role.execute("SELECT mobile FROM gov_studio.v_doctors")


@pytest.mark.parametrize("t", ["doctors", '"individuals-prescriptions"', "other_table", "kx_billing_records"])
def test_public_tables_denied(role, t):
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        role.execute(f"SELECT * FROM public.{t}")


def test_writes_refused(role):
    for sql in ["CREATE TABLE gov_studio.t (a int)", "INSERT INTO gov_studio.v_doctors (uid) VALUES ('x')",
                "DELETE FROM gov_studio.v_doctors", "CREATE TEMP TABLE t (a int)"]:
        with pytest.raises(psycopg.errors.Error) as e:
            role.execute(sql)
        assert isinstance(e.value, (psycopg.errors.ReadOnlySqlTransaction, psycopg.errors.InsufficientPrivilege))


def test_connection_limit(pg):
    conns = [psycopg.connect(pg, user="gov_studio_ro", autocommit=True) for _ in range(3)]
    try:
        with pytest.raises(psycopg.OperationalError, match="too many connections"):
            psycopg.connect(pg, user="gov_studio_ro")
    finally:
        for c in conns:
            c.close()


def test_idempotent_rerun(pg):
    with psycopg.connect(pg, autocommit=True) as c:
        c.execute((PACK / "0001_gov_studio_ro.sql").read_text())


def _run_expect_fail(c, match):
    with pytest.raises(psycopg.errors.Error, match=match):
        c.execute((PACK / "0001_gov_studio_ro.sql").read_text())
    c.execute("ROLLBACK")  # the file's BEGIN is left open by the failed post-check


def test_postcheck_raises_on_leak(pg):
    with psycopg.connect(pg, autocommit=True) as c:
        c.execute("GRANT SELECT ON public.other_table TO PUBLIC")
        try:
            _run_expect_fail(c, "can read")
            # whole file rolled back; leak still visible
            assert c.execute("SELECT has_table_privilege('gov_studio_ro','public.other_table','SELECT')").fetchone()[0]
        finally:
            c.execute("REVOKE ALL ON public.other_table FROM PUBLIC")
        c.execute("GRANT pg_read_all_data TO gov_studio_ro")
        try:
            _run_expect_fail(c, "member of")
        finally:
            c.execute("REVOKE pg_read_all_data FROM gov_studio_ro")
        c.execute("GRANT UPDATE ON public.other_table TO PUBLIC")
        try:
            _run_expect_fail(c, "write privilege")
        finally:
            c.execute("REVOKE UPDATE ON public.other_table FROM PUBLIC")


def _statements(path):
    body = "\n".join(l for l in path.read_text().splitlines() if not l.strip().startswith("--"))
    return [s.strip() for s in body.split(";") if s.strip()]


def test_verify_sql_as_documented(role):
    stmts = _statements(PACK / "VERIFY.sql")
    assert len(stmts) == 6
    assert role.execute(stmts[0]).fetchone()[0] == "on"
    assert role.execute(stmts[1]).fetchone()[0] == "gov_studio_ro"
    assert role.execute(stmts[2]).fetchone()[0] == "1min"
    assert 1 <= role.execute(stmts[3]).fetchone()[0] <= 3
    assert role.execute(stmts[4]).fetchone()[0] == 1
    with pytest.raises(psycopg.errors.ReadOnlySqlTransaction,
                       match=r"cannot execute CREATE TABLE in a read-only transaction"):
        role.execute(stmts[5])


def test_other_databases_check_query_runs(pg):
    t = (PACK / "0001_gov_studio_ro.sql").read_text()
    assert "other_database_with_connect" in t
    with psycopg.connect(pg, autocommit=True) as c:
        q = t[t.index("SELECT d.datname"):t.index("-- 8b.")]
        c.execute(q.strip().rstrip(";")).fetchall()


def test_direct_grants_to_role_are_stripped_on_rerun(pg):
    with psycopg.connect(pg, autocommit=True) as c:
        c.execute("GRANT SELECT ON public.other_table TO gov_studio_ro")
        c.execute("GRANT UPDATE ON gov_studio.v_doctors TO gov_studio_ro")
        c.execute((PACK / "0001_gov_studio_ro.sql").read_text())
        assert not c.execute("SELECT has_table_privilege('gov_studio_ro','public.other_table','SELECT')").fetchone()[0]
        assert not c.execute("SELECT has_table_privilege('gov_studio_ro','gov_studio.v_doctors','UPDATE')").fetchone()[0]
