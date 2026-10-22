"""The live probe (tests/test_lc1_live_probe.py) against a scratch cluster with 0001..0012 applied as the emulated
non-superuser Neon owner: the studio_dw views are expected (generated from ops/db13/extract/spec.py), everything else is
still asserted. Never touches Neon."""
import os
import subprocess
import sys

from tests.neon_harness import AGENT, OPS, PROBE, cluster, run_roles  # noqa: F401  (fixtures)
from tests.test_studio_views import world  # noqa: F401  (0001, 0003, 0007..0011 applied, role usable)

SQL_DW = OPS / "0012_studio_dw.sql"


def probe(url, *extra, expect_dw="1"):
    env = {**os.environ, "GOV_RO_DATABASE_URL": url, "STUDIO_EXPECT_VIEWS": "1"}
    if expect_dw:
        env["STUDIO_EXPECT_DW"] = expect_dw
    return subprocess.run([sys.executable, "-m", "pytest", str(PROBE), "-q", "-p", "no:cacheprovider", *extra], cwd=AGENT, env=env,
                          capture_output=True, text=True)


def test_probe_passes_with_0012_applied_and_covers_every_dw_view(world, tmp_path):
    cluster, _, url = world
    r, _ = run_roles(cluster, tmp_path, sql_file=SQL_DW, tag="dw")
    assert r.returncode == 0, r.stderr
    p = probe(url)
    assert "failed" not in p.stdout and "skipped" not in p.stdout and " passed" in p.stdout, p.stdout[-2500:]
    p2 = probe(url, "-k", "dw")
    assert "passed" in p2.stdout and "21 passed" in p2.stdout and "failed" not in p2.stdout, p2.stdout[-2500:]  # 10 views + 10 tables + the 'dw' schema-wide check


def test_probe_auto_expects_the_dw_views_once_the_schema_exists(world, tmp_path):
    cluster, _, url = world
    assert run_roles(cluster, tmp_path, sql_file=SQL_DW, tag="dw")[0].returncode == 0
    cluster.su_exec("DROP VIEW studio_ro.dw_doctors", db="neondb")  # schema still there: failure even without STUDIO_EXPECT_DW
    p = probe(url, expect_dw="")
    assert "failed" in p.stdout and "dw_doctors" in p.stdout


def test_probe_without_0012_passes_by_default_and_fails_when_dw_is_expected(world):
    cluster, _, url = world
    ok = probe(url, expect_dw="")
    assert "failed" not in ok.stdout and " passed" in ok.stdout, ok.stdout[-1500:]
    bad = probe(url)  # STUDIO_EXPECT_DW=1 but 0012 was not run
    assert "failed" in bad.stdout and "0012_studio_dw.sql was not run" in bad.stdout


def test_probe_catches_an_extra_column_in_a_dw_view_and_a_leaked_dw_table(world, tmp_path):
    cluster, _, url = world
    assert run_roles(cluster, tmp_path, sql_file=SQL_DW, tag="dw")[0].returncode == 0
    cluster.su_exec("ALTER VIEW studio_ro.dw_doctors RENAME TO dw_doctors_old", db="neondb")
    cluster.su_exec("CREATE VIEW studio_ro.dw_doctors WITH (security_barrier = true) AS SELECT uid, uid AS email FROM studio_dw.doctors", db="neondb")
    cluster.su_exec("GRANT SELECT ON studio_ro.dw_doctors TO studio_gov_ro", db="neondb")
    p = probe(url)
    assert "failed" in p.stdout and "dw_doctors" in p.stdout
    cluster.su_exec("DROP VIEW studio_ro.dw_doctors", db="neondb")
    cluster.su_exec("ALTER VIEW studio_ro.dw_doctors_old RENAME TO dw_doctors", db="neondb")
    cluster.su_exec("GRANT SELECT ON studio_dw.doctors TO studio_gov_ro", db="neondb")
    p = probe(url)
    assert "failed" in p.stdout and "studio_dw" in p.stdout


def test_the_expected_view_list_is_generated_from_the_extract_spec():
    from extract.spec import TABLES
    from tests.test_lc1_live_probe import DW_VIEW_COLUMNS

    assert len(DW_VIEW_COLUMNS) == 10
    for t in TABLES:
        assert DW_VIEW_COLUMNS[f"dw_{t.name}"] == tuple(c.name for c in t.cols)
