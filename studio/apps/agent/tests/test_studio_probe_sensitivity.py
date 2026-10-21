"""The live L-C1 probe must CATCH each over-privilege (scratch Postgres only). Each case grants one extra
privilege to studio_gov_ro (created by the R14 flow: SQL setup, mock-API password, login), runs the whole probe
as that role, expects a failure in the named test, reverts, and expects the baseline to pass again."""

import os
import subprocess
import sys

import pytest

from tests.neon_harness import OPS, PROBE, AGENT, cluster, full_flow, keyfile, neon, run_roles  # noqa: F401



def run_probe(url):
    r = subprocess.run(
        [sys.executable, "-m", "pytest", str(PROBE), "-q", "-p", "no:cacheprovider", "--tb=no"],
        cwd=AGENT, env={**os.environ, "GOV_RO_DATABASE_URL": url, "STUDIO_EXPECT_VIEWS": "1"}, capture_output=True, text=True,
    )
    return r.returncode, r.stdout


WRITE = "test_no_write_privilege_on_any_table_in_any_schema"
CASES = {
    "column-level UPDATE": ("GRANT UPDATE (status) ON incidents TO studio_gov_ro", "REVOKE UPDATE (status) ON incidents FROM studio_gov_ro", WRITE),
    "column-level INSERT": ("GRANT INSERT (status) ON incidents TO studio_gov_ro", "REVOKE INSERT (status) ON incidents FROM studio_gov_ro", WRITE),
    "table-level DELETE": ("GRANT DELETE ON hospitals TO studio_gov_ro", "REVOKE DELETE ON hospitals FROM studio_gov_ro", WRITE),
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
    "CREATE on schema public (extension / object creation path)": (
        "GRANT CREATE ON SCHEMA public TO studio_gov_ro",
        "REVOKE CREATE ON SCHEMA public FROM studio_gov_ro",
        "test_no_server_side_egress_primitives_dblink_postgres_fdw",
    ),
    "membership in a privileged role (what the Neon API adds)": (
        "GRANT neon_superuser TO studio_gov_ro",
        "REVOKE neon_superuser FROM studio_gov_ro",
        "test_role_has_no_memberships",
    ),
    "PUBLIC-executable SECURITY DEFINER function that writes": (
        "CREATE FUNCTION public.studio_probe_sd() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ UPDATE hospitals SET name = name $$",
        "DROP FUNCTION public.studio_probe_sd()",
        "test_no_executable_security_definer_function_outside_system_schemas",
    ),
}


def test_probe_catches_each_over_privilege_and_recovers(cluster, neon, keyfile, tmp_path):
    s, r, _, out = full_flow(cluster, neon, tmp_path, keyfile)
    assert s.returncode == 0 and r.returncode == 0
    assert run_roles(cluster, tmp_path, sql_file=OPS / "0003_studio_views.sql", tag="sens-views")[0].returncode == 0
    assert run_roles(cluster, tmp_path, sql_file=OPS / "0007_docaudits_views.sql", tag="sens-docaudit")[0].returncode == 0
    assert run_roles(cluster, tmp_path, sql_file=OPS / "0008_ungate_views.sql", tag="sens-ungate")[0].returncode == 0
    assert run_roles(cluster, tmp_path, "--login", tag="sens-login")[0].returncode == 0
    url = out.read_text().strip()
    rc, text = run_probe(url)
    assert rc == 0 and "failed" not in text and "skipped" not in text, text[-2000:]  # baseline

    for label, (grant, revoke, expected) in CASES.items():
        cluster.su_exec(grant, db="neondb")
        try:
            rc, text = run_probe(url)
            assert rc != 0, f"probe did NOT catch: {label}"
            assert f"FAILED tests/test_lc1_live_probe.py::{expected}" in text, f"{label}: wrong test failed\n{text[-1500:]}"
        finally:
            cluster.su_exec(revoke, db="neondb")
        rc, text = run_probe(url)
        assert rc == 0, f"baseline did not recover after {label}\n{text[-1500:]}"
