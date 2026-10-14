"""The live L-C1 probe must CATCH each over-privilege (scratch Postgres only). Each case grants one extra
privilege to studio_gov_ro, runs the whole probe as that role, expects a failure in the named test, then
reverts and expects the baseline to pass again."""

import os
import re
import subprocess
import sys
from pathlib import Path

import psycopg
import pytest

from tests.test_studio_roles import AGENT, PROBE, evenelo, pg, run_wrapper  # noqa: F401  (fixtures)


def run_probe(url):
    r = subprocess.run(
        [sys.executable, "-m", "pytest", str(PROBE), "-q", "-p", "no:cacheprovider", "--tb=no"],
        cwd=AGENT, env={**os.environ, "GOV_RO_DATABASE_URL": url}, capture_output=True, text=True,
    )
    return r.returncode, r.stdout


CASES = {
    "column-level UPDATE": (
        "GRANT UPDATE (status) ON incidents TO studio_gov_ro",
        "REVOKE UPDATE (status) ON incidents FROM studio_gov_ro",
        "test_no_write_privilege_on_any_table_in_any_schema",
    ),
    "column-level INSERT": (
        "GRANT INSERT (status) ON incidents TO studio_gov_ro",
        "REVOKE INSERT (status) ON incidents FROM studio_gov_ro",
        "test_no_write_privilege_on_any_table_in_any_schema",
    ),
    "table-level DELETE": (
        "GRANT DELETE ON hospitals TO studio_gov_ro",
        "REVOKE DELETE ON hospitals FROM studio_gov_ro",
        "test_no_write_privilege_on_any_table_in_any_schema",
    ),
    "sequence USAGE (nextval)": (
        "GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO studio_gov_ro",
        "REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM studio_gov_ro",
        "test_no_usage_or_update_on_any_sequence_in_any_schema",
    ),
    "SELECT in another schema": (
        "CREATE SCHEMA extra; CREATE TABLE extra.secrets (x int); GRANT USAGE ON SCHEMA extra TO studio_gov_ro; GRANT SELECT ON extra.secrets TO studio_gov_ro",
        "DROP SCHEMA extra CASCADE",
        "test_every_relation_in_every_schema_outside_the_grant_list_is_denied",
    ),
    "PUBLIC-executable SECURITY DEFINER function that writes": (
        "CREATE FUNCTION public.studio_probe_sd() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ UPDATE hospitals SET name = name $$",
        "DROP FUNCTION public.studio_probe_sd()",
        "test_no_executable_security_definer_function_outside_system_schemas",
    ),
}


def test_probe_catches_each_over_privilege_and_recovers(pg, evenelo, tmp_path):  # noqa: F811
    _, owner_uri = evenelo
    r, out_file, _ = run_wrapper(pg, owner_uri, tmp_path, "sens")
    assert r.returncode == 0, r.stderr
    url = out_file.read_text().strip()
    rc, out = run_probe(url)
    assert rc == 0 and "failed" not in out, out[-2000:]  # baseline

    with psycopg.connect(owner_uri, autocommit=True) as c:
        for label, (grant, revoke, expected) in CASES.items():
            c.execute(grant, prepare=False)
            try:
                rc, out = run_probe(url)
                assert rc != 0, f"probe did NOT catch: {label}"
                assert f"FAILED tests/test_lc1_live_probe.py::{expected}" in out, f"{label}: wrong test failed\n{out[-1500:]}"
            finally:
                c.execute(revoke, prepare=False)
            rc, out = run_probe(url)
            assert rc == 0, f"baseline did not recover after {label}\n{out[-1500:]}"
