"""ops/cdmss static contract: no password anywhere, NOLOGIN only, role limits, view shape, allowlist file in step with the
views, and the CDMSS migrations that do / do not apply on a scratch Postgres (G-23: no ledger, so this is recorded)."""

import re

import pytest

from tests.cdmss_harness import (
    OPS, ROLE, RUN_WRAPPER, SQL_POST, SQL_ROLE, SQL_VIEWS, cdmss, needs_env, sql_text,
)  # noqa: F401  (fixture)

pytestmark = pytest.mark.skipif(not OPS.exists(), reason="ops/cdmss not available")

# Even-CDMSS @ bccf852 migrations that fail on a scratch database BEFORE the runtime-DDL fixture is applied (first pass),
# and the ones that still fail after it (second pass). A change here means the CDMSS repo or the fixture moved.
FIRST_PASS_FAILS = {
    "0001_app_source.sql", "0002_literature_engine.sql", "0003_topics_expansion.sql", "0012_reasoning_fingerprint.sql",
    "0018_even_lvc_assertions.sql", "0019_even_ground.sql", "0023_lvc_proposals_and_provenance.sql",
    "0031_vertex_outage_exclusions.sql", "0045_readmission_ask_turns.sql", "0059_triage_queue_disposition.sql",
    "0060_triage_note_class.sql", "0062_newcat_ro_role.sql",
}
SECOND_PASS_FAILS = FIRST_PASS_FAILS - {"0018_even_lvc_assertions.sql", "0031_vertex_outage_exclusions.sql", "0045_readmission_ask_turns.sql"}


def code(path):
    return "\n".join(l for l in path.read_text().splitlines() if not l.lstrip().startswith("--"))


def test_no_password_and_never_login():
    for f in (SQL_ROLE, SQL_VIEWS, SQL_POST):
        c = code(f)
        assert not re.search(r"\bPASSWORD\b|\bpassword\b|rolepw|verifier", c, re.I), f.name
        assert not re.search(r"(?<!NO)LOGIN\b", c), f"{f.name} must never enable LOGIN"
    assert "NOLOGIN" in code(SQL_ROLE)
    wrapper = RUN_WRAPPER.read_text()
    for gone in ("openssl rand", "SCRAM-SHA-256", "ALTER ROLE"):
        assert gone not in wrapper, gone


def test_role_file_asserts_the_limits():
    c = code(SQL_ROLE)
    assert c.count("CONNECTION LIMIT 5") >= 2
    assert "ALTER ROLE studio_cdmss_ro SET default_transaction_read_only = on;" in c
    assert "ALTER ROLE studio_cdmss_ro SET statement_timeout = '20s';" in c
    assert "rolsuper" in c and "refusing" in c and "pg_auth_members" in c
    assert not re.search(r"\bGRANT\b", c), "0001 grants nothing; grants live in 0002"
    assert "DEFAULT PRIVILEGES" not in c


def test_views_file_shape():
    c = code(SQL_VIEWS)
    views = re.findall(r"CREATE VIEW (cdmss_ro\.[a-z_]+) WITH \(security_barrier = true\) AS", c)
    assert len(views) == 17 == len(re.findall(r"\bCREATE VIEW\b", c)) == len(set(views))
    assert len(re.findall(r"^DROP VIEW IF EXISTS", c, re.M)) == 17
    assert "security_invoker" not in c
    assert not re.search(r"SELECT\s+\*\s+FROM|\b[a-z]\.\*", c), "no SELECT * / alias.*: columns are listed"
    assert not re.search(r"^\s*(INSERT INTO|UPDATE |DELETE FROM|TRUNCATE |ALTER TABLE|CREATE TABLE)", c, re.M)
    grants = re.findall(r"^\s*(?:EXECUTE )?.*GRANT [A-Z]+.*$", c, re.M)
    assert all("studio_cdmss_ro" in g for g in grants if "GRANT" in g)
    assert "WITH GRANT OPTION" not in c and "TO PUBLIC" not in c


def test_wrapper_refuses_superuser_and_is_single_transaction():
    w = RUN_WRAPPER.read_text()
    assert "--single-transaction" in w and "rolsuper" in w and "exit 3" in w
    assert "0001_cdmss_ro_role.sql 0002_cdmss_ro_views.sql 0003_cdmss_ro_postcheck.sql" in w
    assert "shred" in w and "/dev/shm" in w


@needs_env
def test_migration_failures_are_the_documented_ones(cdmss):
    got1 = {n for n, _ in cdmss.first_pass_failures}
    got2 = {n for n, _ in cdmss.second_pass_failures}
    assert got1 == FIRST_PASS_FAILS, got1 ^ FIRST_PASS_FAILS
    assert got2 == SECOND_PASS_FAILS, got2 ^ SECOND_PASS_FAILS
    # every table the views read exists after the build
    rows = cdmss.su_exec("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname='cdmss_ro' AND c.relkind='v'")
    assert rows[0][0] == 17
