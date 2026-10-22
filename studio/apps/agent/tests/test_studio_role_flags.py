"""0011_profiles_role_flags.sql: COLUMN grants on the three hospital-role flags of profiles_with_roles, nothing else
(real even-elo schema, scratch Postgres, applied as the emulated non-superuser owner)."""

import re
import uuid

import pytest

from tests.neon_harness import OPS, cluster, run_roles  # noqa: F401  (fixtures)
from tests.test_studio_views import SQL_ROLE_FLAGS, code, ro, world  # noqa: F401  (world fixture applies 0001..0011)

psycopg = pytest.importorskip("psycopg")
FLAGS = ("is_sgc_member", "is_site_medical_head", "is_hr")


def test_static_shape_grants_columns_only_and_never_credentials():
    sql = code(SQL_ROLE_FLAGS)
    assert not re.search(r"\bPASSWORD\b|(?<!NO)\bLOGIN\b|CREATE |ALTER ROLE|REVOKE", sql, re.I)
    assert re.findall(r"^GRANT (.*?) TO studio_gov_ro;", sql, re.M | re.S) == ["SELECT (is_sgc_member, is_site_medical_head, is_hr) ON public.profiles_with_roles"]


def test_role_reads_the_flags_and_nothing_else_on_the_view(world):
    cluster, _, url = world
    with ro(url) as c:
        assert c.execute("SELECT count(is_sgc_member) + count(is_site_medical_head) + count(is_hr) + count(is_super_admin) FROM profiles_with_roles").fetchone()[0] >= 0
        for q in ("SELECT password_hash FROM profiles_with_roles", "SELECT email FROM profiles_with_roles", "SELECT * FROM profiles_with_roles",
                  "SELECT email FROM profiles", "SELECT count(*) FROM profile_hospital_roles"):
            c.rollback()
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                c.execute(q)
    readable = cluster.su_exec(
        "SELECT string_agg(attname, ',' ORDER BY attname) FROM pg_attribute WHERE attrelid = 'public.profiles_with_roles'::regclass AND attnum > 0 AND NOT attisdropped "
        "AND has_column_privilege('studio_gov_ro', 'public.profiles_with_roles', attname, 'SELECT')", db="neondb")[0][0]
    assert readable == "id,is_hr,is_sgc_member,is_site_medical_head,is_super_admin,status"
    assert cluster.su_exec("SELECT has_table_privilege('studio_gov_ro', 'public.profiles_with_roles', 'SELECT')", db="neondb")[0][0] is False


def test_idempotent_and_reapplies_after_0001(world, tmp_path):
    cluster, _, _ = world
    for tag in ("f1", "f2"):
        r, _ = run_roles(cluster, tmp_path, sql_file=SQL_ROLE_FLAGS, tag=tag)
        assert r.returncode == 0, r.stderr
    # re-running 0001 starts from nothing and strips the flags; 0011 restores them
    assert run_roles(cluster, tmp_path, tag="again")[0].returncode == 0
    assert cluster.su_exec("SELECT has_column_privilege('studio_gov_ro', 'public.profiles_with_roles', 'is_hr', 'SELECT')", db="neondb")[0][0] is False
    assert run_roles(cluster, tmp_path, sql_file=SQL_ROLE_FLAGS, tag="f3")[0].returncode == 0
    assert cluster.su_exec("SELECT has_column_privilege('studio_gov_ro', 'public.profiles_with_roles', 'is_hr', 'SELECT')", db="neondb")[0][0] is True


def test_refuses_without_the_role_and_rolls_back_when_a_credential_column_is_readable(cluster, tmp_path):
    r, _ = run_roles(cluster, tmp_path, sql_file=SQL_ROLE_FLAGS, tag="norole")
    assert r.returncode != 0 and "run 0001_roles.sql first" in r.stderr
    assert run_roles(cluster, tmp_path, tag="roles")[0].returncode == 0
    for extra in ("email", "password_hash"):
        cluster.su_exec(f"GRANT SELECT ({extra}) ON public.profiles_with_roles TO studio_gov_ro", db="neondb")
        r, _ = run_roles(cluster, tmp_path, sql_file=SQL_ROLE_FLAGS, tag=f"bad-{extra}")
        assert r.returncode != 0 and "unexpected profiles_with_roles columns" in r.stderr
        assert cluster.su_exec("SELECT has_column_privilege('studio_gov_ro', 'public.profiles_with_roles', 'is_hr', 'SELECT')", db="neondb")[0][0] is False  # rolled back
        cluster.su_exec(f"REVOKE SELECT ({extra}) ON public.profiles_with_roles FROM studio_gov_ro", db="neondb")
    cluster.su_exec("GRANT SELECT ON public.profiles TO studio_gov_ro", db="neondb")
    r, _ = run_roles(cluster, tmp_path, sql_file=SQL_ROLE_FLAGS, tag="wide-profiles")
    assert r.returncode != 0 and "table-wide SELECT" in r.stderr
