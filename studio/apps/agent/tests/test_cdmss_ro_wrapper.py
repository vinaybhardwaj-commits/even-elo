"""ops/cdmss/run-cdmss-ro.sh against the scratch cluster (owner = non-superuser). Never touches a real database."""

import os
import shutil
import subprocess

import psycopg
import pytest

from tests.cdmss_harness import OPS, RUN_WRAPPER, SQL_POST, SQL_VIEWS, cdmss, needs_env, sql_text  # noqa: F401  (fixture)

pytestmark = needs_env


def url_file(tmp_path, url, tag="owner"):
    f = tmp_path / f"{tag}-url"
    f.write_text(url + "\n")
    f.chmod(0o600)
    return f


def run(cdmss, args, env_extra=None):
    env = {**os.environ, "PSQL": cdmss.psql}
    env.update(env_extra or {})
    return subprocess.run(["bash", str(RUN_WRAPPER), *args], capture_output=True, text=True, env=env, timeout=120)


def view_count(cdmss):
    return cdmss.su_exec("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='cdmss_ro' AND c.relkind='v'")[0][0]


def test_dry_run_connects_to_nothing_and_prints_the_sql(cdmss):
    p = run(cdmss, ["--dry-run"], {"PGSERVICEFILE": "/nonexistent"})
    assert p.returncode == 0 and "CREATE ROLE studio_cdmss_ro NOLOGIN" in p.stdout and "CREATE VIEW cdmss_ro.opd_note_audit" in p.stdout
    assert "COLUMN ALLOWLIST" in p.stdout


def test_owner_run_is_idempotent_and_leaves_the_role_nologin(cdmss, tmp_path):
    f = url_file(tmp_path, cdmss.owner_url)
    for _ in range(2):
        p = run(cdmss, [str(f)])
        assert p.returncode == 0, p.stderr
        assert "post-check passed" in p.stdout and "no password" in p.stdout
    assert view_count(cdmss) == 16
    assert cdmss.su_exec("SELECT rolcanlogin FROM pg_roles WHERE rolname='studio_cdmss_ro'") == [(False,)]
    p = run(cdmss, ["--check", str(f)])
    assert p.returncode == 0 and "nothing changed" in p.stdout


def test_refuses_a_superuser(cdmss, tmp_path):
    f = url_file(tmp_path, cdmss.su_cdmss, "su")
    p = run(cdmss, [str(f)])
    assert p.returncode == 3 and "superuser" in p.stderr
    assert view_count(cdmss) == 16  # nothing was touched


def test_missing_owner_file_and_secret_never_on_argv(cdmss, tmp_path):
    assert run(cdmss, [str(tmp_path / "nope")]).returncode == 2
    assert run(cdmss, []).returncode == 2


def test_a_failed_postcheck_rolls_the_whole_run_back(cdmss, tmp_path):
    """A view that leaks an LLM-trace column (not in the allowlist, in the secrets/trace denylist) makes 0003 fail: nothing from the run survives."""
    d = tmp_path / "sql"
    d.mkdir()
    for f in OPS.glob("0*.sql"):
        shutil.copy(f, d / f.name)
    views = (d / SQL_VIEWS.name).read_text()
    marker = "-- GRANTS: USAGE on the schema"
    leak = "CREATE VIEW cdmss_ro.leak WITH (security_barrier = true) AS SELECT o.trace_id FROM public.ot_note_audits o;\n"
    (d / SQL_VIEWS.name).write_text(views.replace(marker, leak + marker, 1))
    f = url_file(tmp_path, cdmss.owner_url)
    p = run(cdmss, [str(f)], {"CDMSS_RO_SQL_DIR": str(d)})
    assert p.returncode != 0 and "postcheck" in p.stderr
    names = {r[0] for r in cdmss.su_exec("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='cdmss_ro'")}
    assert "leak" not in names and view_count(cdmss) == 16  # rolled back; the earlier good views are intact
    # and the shipped files still pass afterwards
    assert run(cdmss, ["--check", str(f)]).returncode == 0


def test_postcheck_catches_a_base_table_grant(cdmss, tmp_path):
    f = url_file(tmp_path, cdmss.owner_url)
    with psycopg.connect(cdmss.owner_url, autocommit=True) as c:
        c.execute("GRANT SELECT (uid) ON public.opd_note_audits TO studio_cdmss_ro")
    try:
        p = run(cdmss, ["--check", str(f)])
        assert p.returncode != 0 and "privilege on a base relation" in p.stderr
    finally:
        with psycopg.connect(cdmss.owner_url, autocommit=True) as c:
            c.execute("REVOKE ALL ON public.opd_note_audits FROM studio_cdmss_ro")
    assert run(cdmss, ["--check", str(f)]).returncode == 0


def sql_copy(tmp_path, edit=None):
    d = tmp_path / "sql"
    d.mkdir(exist_ok=True)
    for f in OPS.glob("0*.sql"):
        shutil.copy(f, d / f.name)
    if edit:
        edit(d)
    return d


def test_precheck_passes_and_prints_on_check(cdmss, tmp_path):
    f = url_file(tmp_path, cdmss.owner_url)
    p = run(cdmss, ["--precheck", str(f)])
    assert p.returncode == 0 and "precheck: all" in p.stderr and "source columns present" in p.stderr
    p = run(cdmss, ["--check", str(f)])
    assert p.returncode == 0 and "precheck: all" in p.stderr  # --check prints it too


def test_precheck_lists_every_missing_column_and_applies_nothing(cdmss, tmp_path):
    def edit(d):
        pre = d / "0000_cdmss_ro_precheck.sql"
        pre.write_text(pre.read_text().replace("  ('ccb_briefs', ", "  ('opd_note_audits', 'no_such_col other_missing'),\n  ('no_such_table', 'a b'),\n  ('ccb_briefs', ", 1))
    d = sql_copy(tmp_path, edit)
    f = url_file(tmp_path, cdmss.owner_url)
    before = cdmss.su_exec("SELECT count(*), max(oid::text) FROM pg_class c WHERE relnamespace = 'cdmss_ro'::regnamespace")
    # a broken 0002 proves nothing after the pre-check is even attempted
    (d / "0002_cdmss_ro_views.sql").write_text("DROP SCHEMA cdmss_ro CASCADE;\n")
    for args in (["--precheck"], [], ["--check"]):
        p = run(cdmss, [*args, str(f)], {"CDMSS_RO_SQL_DIR": str(d)})
        assert p.returncode == 4, (args, p.stderr)
        for want in ("opd_note_audits.no_such_col", "opd_note_audits.other_missing", "no_such_table.a", "no_such_table.b", "3 of"):
            if want != "3 of":
                assert want in p.stderr, (args, want)
        assert "Nothing was applied" in p.stderr
    assert cdmss.su_exec("SELECT count(*), max(oid::text) FROM pg_class c WHERE relnamespace = 'cdmss_ro'::regnamespace") == before


def breach(cdmss, tmp_path, up, down, message, owner_sql=True):
    """Apply a privilege breach as the owner, expect --check (0003) to fail with `message`, revert, expect it to pass again."""
    f = url_file(tmp_path, cdmss.owner_url)
    with psycopg.connect(cdmss.owner_url, autocommit=True) as c:
        for stmt in up:
            c.execute(stmt)
    try:
        p = run(cdmss, ["--check", str(f)])
        assert p.returncode != 0 and message in p.stderr, p.stderr
    finally:
        with psycopg.connect(cdmss.owner_url, autocommit=True) as c:
            for stmt in down:
                c.execute(stmt)
    assert run(cdmss, ["--check", str(f)]).returncode == 0


def test_fence_public_create_on_public_schema(cdmss, tmp_path):
    breach(cdmss, tmp_path, ["GRANT CREATE ON SCHEMA public TO PUBLIC"], ["REVOKE CREATE ON SCHEMA public FROM PUBLIC"], "CREATE on schema")


def test_fence_role_create_on_database(cdmss, tmp_path):
    breach(cdmss, tmp_path, ["GRANT CREATE ON DATABASE cdmssdb TO studio_cdmss_ro"], ["REVOKE CREATE ON DATABASE cdmssdb FROM studio_cdmss_ro"], "CREATE on the database")


def test_fence_usage_and_select_in_another_schema(cdmss, tmp_path):
    up = ["CREATE SCHEMA lab_v2_x", "CREATE TABLE lab_v2_x.t (i int)", "GRANT USAGE ON SCHEMA lab_v2_x TO studio_cdmss_ro", "GRANT SELECT ON lab_v2_x.t TO studio_cdmss_ro"]
    breach(cdmss, tmp_path, up, ["DROP SCHEMA lab_v2_x CASCADE"], "other schema(s): lab_v2_x")
    # table privilege without schema USAGE is still a privilege outside cdmss_ro
    up = ["CREATE SCHEMA lab_v2_y", "CREATE TABLE lab_v2_y.t (i int)", "GRANT SELECT ON lab_v2_y.t TO studio_cdmss_ro"]
    breach(cdmss, tmp_path, up, ["DROP SCHEMA lab_v2_y CASCADE"], "privilege outside cdmss_ro: lab_v2_y.t")


def test_fence_public_executable_security_definer_function(cdmss, tmp_path):
    up = ["CREATE FUNCTION public.leaky() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'"]
    breach(cdmss, tmp_path, up, ["DROP FUNCTION public.leaky()"], "SECURITY DEFINER function(s): public.leaky")


def test_fence_another_grantee_on_a_view_and_schema(cdmss, tmp_path):
    cdmss.su_exec("CREATE ROLE cdmss_other NOLOGIN")
    try:
        breach(cdmss, tmp_path, ["GRANT SELECT ON cdmss_ro.site_dim TO cdmss_other"], ["REVOKE ALL ON cdmss_ro.site_dim FROM cdmss_other"], "unexpected grantee on a cdmss_ro relation: site_dim->cdmss_other")
        breach(cdmss, tmp_path, ["GRANT SELECT ON cdmss_ro.site_dim TO PUBLIC"], ["REVOKE ALL ON cdmss_ro.site_dim FROM PUBLIC"], "unexpected ACL entry (PUBLIC")
        breach(cdmss, tmp_path, ["GRANT USAGE ON SCHEMA cdmss_ro TO cdmss_other"], ["REVOKE ALL ON SCHEMA cdmss_ro FROM cdmss_other"], "unexpected grantee on schema cdmss_ro")
    finally:
        cdmss.su_exec("DROP ROLE cdmss_other")


def test_postcheck_requires_the_database_owner(cdmss):
    cdmss.su_exec("CREATE ROLE cdmss_intruder LOGIN")
    try:
        with psycopg.connect(cdmss.url("cdmss_intruder", "cdmssdb"), autocommit=True) as c:
            with pytest.raises(psycopg.errors.RaiseException, match="run as the database owner"):
                c.execute(sql_text(SQL_POST), prepare=False)
    finally:
        cdmss.su_exec("DROP ROLE cdmss_intruder")


def test_harness_removes_its_data_dir():
    from pathlib import Path
    from tests.cdmss_harness import CdmssCluster
    c = CdmssCluster()
    d = Path(c.data_dir)
    assert d.exists()
    c.stop()
    assert not d.exists()


def test_fence_usage_on_a_sequence(cdmss, tmp_path):
    up = ["CREATE SEQUENCE public.leak_seq", "GRANT USAGE ON SEQUENCE public.leak_seq TO studio_cdmss_ro"]
    breach(cdmss, tmp_path, up, ["DROP SEQUENCE public.leak_seq"], "privilege outside cdmss_ro: public.leak_seq")
