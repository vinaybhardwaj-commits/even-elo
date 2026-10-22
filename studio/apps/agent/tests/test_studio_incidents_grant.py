"""0009_incidents_view.sql (additive view) + 0010_incidents_revoke.sql (REVOKE): studio_gov_ro reads incidents ONLY through studio_ro.incident_register (real schema, scratch Postgres)."""

import re
import uuid

import pytest

from src import studio_tools
from tests.neon_harness import OPS, cluster, run_roles  # noqa: F401  (fixtures)
from tests.test_lc1_live_probe import INCIDENT_VIEW_COLUMNS
from tests.test_studio_views import SQL_INCIDENTS, SQL_INCIDENTS_REVOKE, SQL_VIEWS, code, ro, world  # noqa: F401  (world fixture)

psycopg = pytest.importorskip("psycopg")
SQL_ROLES = OPS / "0001_roles.sql"


def test_static_shape_and_no_code_path_reads_the_base_table():
    view, revoke = code(SQL_INCIDENTS), code(SQL_INCIDENTS_REVOKE)
    for sql in (view, revoke):
        assert not re.search(r"\bPASSWORD\b|(?<!NO)\bLOGIN\b|CREATE ROLE|ALTER ROLE", sql, re.I)
    # 0009 is additive: the view and its grants only, no REVOKE on the base table and no base-table assertion
    assert view.count("CREATE OR REPLACE VIEW studio_ro.incident_register WITH (security_barrier = true)") == 1 and "security_invoker" not in view
    assert "SELECT *" not in view[view.index("CREATE OR REPLACE VIEW"):view.index("GRANT USAGE")] and ".*" not in view
    assert re.findall(r"^GRANT (.*?) TO studio_gov_ro;", view, re.M | re.S) == ["USAGE ON SCHEMA studio_ro", "SELECT ON studio_ro.incident_register"]
    assert "REVOKE ALL ON public.incidents" not in view and "still holds a privilege on public.incidents" not in view
    # 0010 revokes and carries the full post-check, and needs 0009
    assert "REVOKE ALL ON public.incidents FROM studio_gov_ro;" in revoke and "still holds a privilege on public.incidents" in revoke
    assert "CREATE" not in revoke.replace("CREATE ROLE", "") and not re.search(r"^GRANT ", revoke, re.M) and "run 0009_incidents_view.sql first" in revoke
    assert "incidents" not in code(SQL_ROLES).split("GRANT SELECT ON")[1].split(";")[0]  # 0001 no longer grants the base table
    for name, q in studio_tools.ALL_SQL.items():
        assert not re.search(r"\b(?:FROM|JOIN)\s+(?:public\.)?incidents\b", q), name


def test_tools_read_the_view_with_exactly_the_columns_it_has():
    view_cols = set(INCIDENT_VIEW_COLUMNS["incident_register"])
    for name in ("incident_summary", "overview_counts"):
        assert "studio_ro.incident_register" in studio_tools.ALL_SQL[name]
    used = set(re.findall(r"\bi\.([a-z_]+)", studio_tools.ALL_SQL["incident_summary"]))
    assert used == view_cols


def test_role_reads_incidents_only_through_the_view(world):
    _, _, url = world
    with ro(url) as c:
        cur = c.execute("SELECT * FROM studio_ro.incident_register")
        assert tuple(d.name for d in cur.description) == INCIDENT_VIEW_COLUMNS["incident_register"]
        assert len(cur.fetchall()) == 4
        c.rollback()
        # the exact statements the two tools run
        assert dict(c.execute(studio_tools.OVERVIEW_COUNTS_SQL).fetchall())["incidents_open"] == 3
        rows = c.execute(studio_tools.INCIDENT_SUMMARY_SQL, (30, 50)).fetchall()
        assert sum(r[3] for r in rows) == 4  # submitted_at defaults to now(): all four are inside the window
        for q in ("SELECT count(*) FROM public.incidents", "SELECT narrative FROM public.incidents", "SELECT id FROM public.incidents"):
            c.rollback()
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                c.execute(q)
        c.rollback()
        assert c.execute("SELECT has_any_column_privilege('studio_gov_ro', 'public.incidents', 'SELECT')").fetchone()[0] is False


def test_0009_alone_leaves_the_old_agent_working_then_0010_revokes_table_and_column_grants(world, tmp_path):
    cluster, _, url = world
    cluster.su_exec("GRANT SELECT ON incidents TO studio_gov_ro; GRANT UPDATE (status) ON incidents TO studio_gov_ro", db="neondb")  # the pre-0010 state
    for tag in ("i1", "i2"):  # 0009 again: idempotent and additive
        r, _ = run_roles(cluster, tmp_path, sql_file=SQL_INCIDENTS, tag=tag)
        assert r.returncode == 0, r.stderr
    with ro(url) as c:  # no outage window: the previous agent's base-table read still works, and so does the view
        assert c.execute("SELECT count(*) FROM public.incidents").fetchone()[0] == 4
        assert c.execute("SELECT count(*) FROM studio_ro.incident_register").fetchone()[0] == 4
    for tag in ("r1", "r2"):
        r, _ = run_roles(cluster, tmp_path, sql_file=SQL_INCIDENTS_REVOKE, tag=tag)
        assert r.returncode == 0, r.stderr
    left = cluster.su_exec("SELECT has_any_column_privilege('studio_gov_ro', 'public.incidents', 'SELECT') OR has_any_column_privilege('studio_gov_ro', 'public.incidents', 'UPDATE')", db="neondb")[0][0]
    assert left is False
    with ro(url) as c:
        assert c.execute("SELECT count(*) FROM studio_ro.incident_register").fetchone()[0] == 4


def test_0010_refuses_without_0009_and_rolls_back_when_a_privilege_survives(cluster, tmp_path):
    assert run_roles(cluster, tmp_path, tag="roles")[0].returncode == 0
    assert run_roles(cluster, tmp_path, sql_file=SQL_VIEWS, tag="v3")[0].returncode == 0
    r, _ = run_roles(cluster, tmp_path, sql_file=SQL_INCIDENTS_REVOKE, tag="no9")
    assert r.returncode != 0 and "run 0009_incidents_view.sql first" in r.stderr
    assert run_roles(cluster, tmp_path, sql_file=SQL_INCIDENTS, tag="v9")[0].returncode == 0
    cluster.su_exec("GRANT SELECT ON incidents TO PUBLIC", db="neondb")  # a PUBLIC grant: the role's REVOKE cannot remove it
    r, _ = run_roles(cluster, tmp_path, sql_file=SQL_INCIDENTS_REVOKE, tag="pub")
    assert r.returncode != 0 and "still holds a privilege on public.incidents" in r.stderr


def test_0009_needs_0003_first_and_a_wider_view_cannot_survive(cluster, tmp_path):
    assert run_roles(cluster, tmp_path, tag="roles")[0].returncode == 0
    r, _ = run_roles(cluster, tmp_path, sql_file=SQL_INCIDENTS, tag="no3")
    assert r.returncode != 0 and "run 0003_studio_views.sql first" in r.stderr
    assert run_roles(cluster, tmp_path, sql_file=SQL_VIEWS, tag="v3")[0].returncode == 0
    bad = tmp_path / "bad9.sql"
    bad.write_text(SQL_INCIDENTS.read_text().replace("i.severity, i.submitted_at\nFROM", "i.severity, i.submitted_at, i.narrative\nFROM"))
    assert "i.narrative" in bad.read_text()
    r, _ = run_roles(cluster, tmp_path, sql_file=bad, tag="bad9")
    assert r.returncode != 0 and "not the reviewed list" in r.stderr
    exists = cluster.su_exec("SELECT to_regclass('studio_ro.incident_register') IS NOT NULL", db="neondb")[0][0]
    assert exists is False  # rolled back
