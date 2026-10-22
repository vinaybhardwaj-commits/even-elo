"""ops/neon/0003_studio_views.sql (studio_ro column-scoped views) and the six agent tools over them, run
against a scratch Postgres built from the REAL even-elo schema (src/lib/migrations.ts) with the emulated Neon
role layout (tests/neon_harness.py). Never touches Neon. DB tests skip without `pgserver`
(uv run --with pgserver pytest)."""

import asyncio
import json
import os
import re
import subprocess
import sys
import uuid

import psycopg
import pytest

from src import studio_audit, studio_tools
from tests.neon_harness import AGENT, OPS, PROBE, cluster, role_row, run_roles  # noqa: F401  (fixtures)
from tests.test_lc1_live_probe import (
    ALL_VIEW_COLUMNS, BASE_VIEW_COLUMNS, DOCAUDIT_BASE_TABLES, DOCAUDIT_VIEW_COLUMNS, FREE_TEXT_COLUMNS, UNGATE_APPENDED, VIEW_BASE_TABLES, VIEW_COLUMNS,
)

SQL_VIEWS = OPS / "0003_studio_views.sql"
SQL_DOCAUDIT = OPS / "0007_docaudits_views.sql"
SQL_UNGATE = OPS / "0008_ungate_views.sql"
SQL_INCIDENTS = OPS / "0009_incidents_view.sql"
SQL_INCIDENTS_REVOKE = OPS / "0010_incidents_revoke.sql"
STAFF = "11111111-1111-4111-8111-111111111111"
CFG = {"configurable": {studio_tools.STAFF_KEY: STAFF}}
VIEW_TOOLS = {
    "physician_privileges": "physician_privileges",
    "physician_oppe": "physician_oppe",
    "physician_metrics": "physician_metrics",
    "physician_qualifications": "physician_qualifications",
    "capture_gaps": "capture_gaps",
    "feedback_by_physician": "physician_feedback",
}


def code(path):
    return "\n".join(l for l in path.read_text().splitlines() if not l.lstrip().startswith("--"))


# ---------------------------------------------------------------- static (no database)


def test_migration_file_shape():
    sql = code(SQL_VIEWS)
    assert not re.search(r"\bPASSWORD\b|(?<!NO)\bLOGIN\b|CREATE ROLE|ALTER ROLE", sql, re.I)
    assert sql.count("security_barrier = true") == len(VIEW_COLUMNS) == len(re.findall(r"CREATE VIEW studio_ro\.", sql))
    views_sql = sql[sql.index("CREATE VIEW"):sql.index("GRANT USAGE ON SCHEMA studio_ro")]
    assert "security_invoker" not in sql and "SELECT *" not in views_sql and ".*" not in views_sql
    # Every GRANT is to studio_gov_ro and only USAGE on studio_ro / SELECT on studio_ro views.
    grants = re.findall(r"GRANT (.*?) TO studio_gov_ro;", sql, re.S)
    assert len(grants) == 2 and grants[0] == "USAGE ON SCHEMA studio_ro"
    names = re.findall(r"studio_ro\.([a-z_]+)", grants[1])
    assert sorted(names) == sorted(VIEW_COLUMNS)
    assert not re.search(r"GRANT .* ON (public\.)?(privileges|oppe_reviews|clinical_metrics_monthly|qualifications|gov_capture_gaps|incident_replies|incidents)\b", sql)
    assert "rolsuper" in sql and "studio_gov_ro does not exist" in sql


def test_view_sql_selects_no_free_text_column():
    """Text-level guard; the exact exposed columns are asserted against the real views below and in the probe.
    replied_by_physician_id / target_physician_id are used only to derive a boolean / the physician id."""
    sql = code(SQL_VIEWS)
    allowed = {"replied_by_physician_id", "target_physician_id"}
    views = re.findall(r"CREATE VIEW studio_ro\.[a-z_]+ WITH \(security_barrier = true\) AS(.*?);", sql, re.S)
    assert len(views) == len(VIEW_COLUMNS)
    for view_sql in views:
        for banned in set(FREE_TEXT_COLUMNS) - allowed:
            assert not re.search(rf"\b[a-z]\.{banned}\b", view_sql), banned


def test_view_tools_read_only_studio_ro_views_and_no_base_table():
    for tool_name, view in VIEW_TOOLS.items():
        sql = studio_tools.ALL_SQL[tool_name]
        studio_tools.assert_read_only(sql)
        tables = set(re.findall(r"\b(?:FROM|JOIN)\s+([a-z_.]+)", sql))
        assert tables == {f"studio_ro.{view}"}, tool_name
        for banned in FREE_TEXT_COLUMNS:
            assert not re.search(rf"\b{banned}\b", sql), (tool_name, banned)
    assert studio_tools.VIEW_TOOL_NAMES == tuple(VIEW_TOOLS)


# ---------------------------------------------------------------- real-schema database


def ids():
    return {k: str(uuid.uuid4()) for k in ("p1", "p2", "h1", "h2")}


@pytest.fixture
def world(cluster, tmp_path):
    """Role + views installed as the emulated non-superuser owner, real schema seeded, role usable (LOGIN+password)."""
    r, _ = run_roles(cluster, tmp_path, tag="roles")
    assert r.returncode == 0, r.stderr
    v, _ = run_roles(cluster, tmp_path, sql_file=SQL_VIEWS, tag="views")
    assert v.returncode == 0, v.stderr
    d, _ = run_roles(cluster, tmp_path, sql_file=SQL_DOCAUDIT, tag="docaudit-views")  # the probe (EXPECT_VIEWS=1) wants both files
    assert d.returncode == 0, d.stderr
    u, _ = run_roles(cluster, tmp_path, sql_file=SQL_UNGATE, tag="ungate-views")  # appends the text columns (after 0003)
    assert u.returncode == 0, u.stderr
    n, _ = run_roles(cluster, tmp_path, sql_file=SQL_INCIDENTS, tag="incidents-grant")  # incident_register view + REVOKE on incidents
    assert n.returncode == 0, n.stderr
    n10, _ = run_roles(cluster, tmp_path, sql_file=SQL_INCIDENTS_REVOKE, tag="incidents-revoke")  # after the agent deploy
    assert n10.returncode == 0, n10.stderr
    i = ids()
    s = lambda q, *a: cluster.su_exec(q % a if a else q, db="neondb")
    s(f"INSERT INTO hospitals (id, code, name) VALUES ('{i['h1']}', 'T1', 'Hosp One'), ('{i['h2']}', 'T2', 'Hosp Two')")
    s(f"INSERT INTO physicians (id, full_name) VALUES ('{i['p1']}', 'Dr Sample One'), ('{i['p2']}', 'Dr Sample Two')")
    s(f"""INSERT INTO privileges (physician_id, hospital_id, procedure_or_specialty, granted_date, withdrawn_reason, basis, is_core, expires_at)
          VALUES ('{i['p1']}', '{i['h1']}', 'Cataract surgery', '2026-01-05', 'SECRET-WITHDRAWAL-TEXT', 'initial', false, '2027-01-05')""")
    s(f"""INSERT INTO oppe_reviews (physician_id, hospital_id, period_start, period_end, due_at, status, decision_notes, packet_jsonb)
          VALUES ('{i['p1']}', '{i['h1']}', '2026-01-01', '2026-06-30', '2026-07-15', 'satisfactory', 'SECRET-DECISION-NOTE', '{{"k":"SECRET-PACKET"}}')""")
    s(f"""INSERT INTO clinical_metrics_monthly (physician_id, hospital_id, year, month, opd_count, ipd_admissions, ot_cases, revenue_inr, source_file)
          VALUES ('{i['p1']}', '{i['h1']}', 2026, 8, 120, 10, 6, 250000.50, 'SECRET-FILE.xlsx')""")
    s(f"""INSERT INTO qualifications (physician_id, degree, institution, institution_tier, year_completed, country, file_data)
          VALUES ('{i['p1']}', 'MS Ophthalmology', 'SECRET-INSTITUTION', 'A', 2010, 'IN', '{{"b64":"SECRET-CERT"}}')""")
    s(f"""UPDATE gov_capture_gaps SET note = 'SECRET-GAP-NOTE' WHERE title LIKE 'Assessment%'""")
    # Feedback: two negative patient, one positive patient, one peer; one open, one closed.
    inc = {}
    for key, source, pol, sev, status in (
        ("a", "patient", "negative", "high", "open"),
        ("b", "patient", "negative", "high", "open"),
        ("c", "patient", "positive", None, "closed"),
        ("d", "peer", "negative", "low", "open"),
    ):
        inc[key] = str(uuid.uuid4())
        s(f"""INSERT INTO incidents (id, target_physician_id, submitter_position_at_time, severity, narrative, status, polarity, source,
                                       submitter_physician_id, category, reporter_name, patient_ref, hospital_id)
              VALUES ('{inc[key]}', '{i['p1']}', 'x', {('NULL' if sev is None else repr(sev))}, 'SECRET-NARRATIVE', '{status}', '{pol}', '{source}',
                      '{i['p2']}', 'clinical', 'SECRET-REPORTER', 'SECRET-PATIENT-REF', '{i['h1']}')""")
    s(f"""INSERT INTO incident_replies (incident_id, reply_text, replied_by_physician_id)
          VALUES ('{inc['a']}', 'SECRET-REPLY-TEXT', '{i['p1']}')""")
    cluster.su_exec("ALTER ROLE studio_gov_ro LOGIN PASSWORD 'ro-test-pw'")
    url = cluster.url("studio_gov_ro", "neondb", "ro-test-pw")
    return cluster, i, url


def ro(url):
    return psycopg.connect(url, autocommit=False, prepare_threshold=None)


@pytest.mark.parametrize("view", sorted(VIEW_COLUMNS))
def test_role_selects_each_view_with_exactly_the_reviewed_columns(world, view):
    _, _, url = world
    with ro(url) as c:
        cur = c.execute(f"SELECT * FROM studio_ro.{view}")
        assert tuple(d.name for d in cur.description) == VIEW_COLUMNS[view]
        assert cur.fetchall() or view == "incident_reply_status"  # every other view has seeded rows


@pytest.mark.parametrize("table", VIEW_BASE_TABLES)
def test_role_cannot_read_the_base_tables(world, table):
    _, _, url = world
    with ro(url) as c:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute(f"SELECT * FROM public.{table}")
        c.rollback()
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute(f"SELECT count(*) FROM public.{table}")


def test_source_page_text_comes_through_the_views_and_payloads_and_files_stay_out(world):
    _, _, url = world
    with ro(url) as c:
        blob = ""
        for view in VIEW_COLUMNS:
            blob += json.dumps(c.execute(f"SELECT * FROM studio_ro.{view}").fetchall(), default=str)
    for shown in ("SECRET-WITHDRAWAL-TEXT", "SECRET-DECISION-NOTE", "SECRET-INSTITUTION", "SECRET-GAP-NOTE", "SECRET-REPLY-TEXT"):
        assert shown in blob, shown
    for hidden in ("SECRET-PACKET", "SECRET-FILE", "SECRET-CERT", "SECRET-NARRATIVE", "SECRET-REPORTER", "SECRET-PATIENT-REF"):
        assert hidden not in blob, hidden


def test_ungate_appends_columns_at_the_end_and_keeps_every_grant(world, tmp_path):
    cluster, _, url = world
    for view, extra in UNGATE_APPENDED.items():
        assert VIEW_COLUMNS[view][: len(BASE_VIEW_COLUMNS[view])] == BASE_VIEW_COLUMNS[view]
        assert VIEW_COLUMNS[view][len(BASE_VIEW_COLUMNS[view]):] == extra
    before = cluster.su_exec(ACL_SQL, db="neondb")[0][0]
    r, _ = run_roles(cluster, tmp_path, sql_file=SQL_UNGATE, tag="ungate2")  # idempotent
    assert r.returncode == 0, r.stderr
    assert cluster.su_exec(ACL_SQL, db="neondb")[0][0] == before
    sql = code(SQL_UNGATE)
    assert sql.count("CREATE OR REPLACE VIEW studio_ro.") == len(UNGATE_APPENDED) and "DROP VIEW" not in sql
    views_sql = sql[sql.index("CREATE OR REPLACE VIEW"):]
    assert sql.count("security_barrier = true") == len(UNGATE_APPENDED) and "security_invoker" not in sql and "SELECT *" not in views_sql
    assert not re.search(r"\bGRANT\b", sql)


def test_ungate_needs_0003_first_and_rolls_back_an_unreviewed_free_text_column(cluster, tmp_path):
    assert run_roles(cluster, tmp_path, tag="roles")[0].returncode == 0
    r, _ = run_roles(cluster, tmp_path, sql_file=SQL_UNGATE, tag="no3")
    assert r.returncode != 0 and "run 0003_studio_views.sql first" in r.stderr
    assert run_roles(cluster, tmp_path, sql_file=SQL_VIEWS, tag="v3")[0].returncode == 0
    bad = tmp_path / "bad8.sql"
    bad.write_text(SQL_UNGATE.read_text().replace("q.institution\nFROM public.qualifications q;", "q.institution, q.file_data\nFROM public.qualifications q;"))
    assert "q.file_data\nFROM" in bad.read_text()
    r, _ = run_roles(cluster, tmp_path, sql_file=bad, tag="bad8")
    assert r.returncode != 0 and "outside the reviewed list" in r.stderr
    cols = cluster.su_exec("SELECT string_agg(attname, ',') FROM pg_attribute WHERE attrelid = 'studio_ro.physician_qualifications'::regclass AND attnum > 0", db="neondb")[0][0]
    assert "institution" not in cols.split(",")  # rolled back: the 0003 view is untouched


def test_rerunning_0003_drops_the_appended_columns_and_0008_restores_them(world, tmp_path):
    cluster, _, url = world
    assert run_roles(cluster, tmp_path, sql_file=SQL_VIEWS, tag="re3")[0].returncode == 0
    with ro(url) as c:
        assert tuple(d.name for d in c.execute("SELECT * FROM studio_ro.capture_gaps WHERE false").description) == BASE_VIEW_COLUMNS["capture_gaps"]
    assert run_roles(cluster, tmp_path, sql_file=SQL_UNGATE, tag="re8")[0].returncode == 0
    with ro(url) as c:
        assert tuple(d.name for d in c.execute("SELECT * FROM studio_ro.capture_gaps WHERE false").description) == VIEW_COLUMNS["capture_gaps"]


def test_feedback_view_counts_by_physician_source_polarity_severity_status(world):
    _, i, url = world
    with ro(url) as c:
        rows = c.execute(
            "SELECT source, polarity, severity, status, incidents FROM studio_ro.physician_feedback WHERE physician_id = %s ORDER BY 1,2,3,4", (i["p1"],)
        ).fetchall()
        none = c.execute("SELECT count(*) FROM studio_ro.physician_feedback WHERE physician_id = %s", (i["p2"],)).fetchone()[0]
    assert rows == [("patient", "negative", "high", "open", 2), ("patient", "positive", "n/a", "closed", 1), ("peer", "negative", "low", "open", 1)]
    assert none == 0


def test_reply_status_has_counts_status_and_timestamps_only(world):
    _, i, url = world
    with ro(url) as c:
        rows = c.execute("SELECT physician_id::text, incident_status, replied_by_physician FROM studio_ro.incident_reply_status").fetchall()
    assert rows == [(i["p1"], "open", True)]


def test_role_is_read_only_on_the_views_and_cannot_create_in_the_schema(world):
    _, _, url = world
    with ro(url) as c:
        c.execute("SET transaction_read_only = off")
        for stmt in ("DELETE FROM studio_ro.capture_gaps", "UPDATE studio_ro.capture_gaps SET title = 'x'", "CREATE VIEW studio_ro.evil AS SELECT 1"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                c.execute(stmt)
            c.rollback()
            c.execute("SET transaction_read_only = off")


def test_rerun_is_idempotent_and_keeps_grants(world, tmp_path):
    cluster, _, url = world
    before = cluster.su_exec("SELECT string_agg(coalesce(relacl::text, ''), ';' ORDER BY relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'studio_ro'", db="neondb")
    r, _ = run_roles(cluster, tmp_path, sql_file=SQL_VIEWS, tag="views2")
    assert r.returncode == 0, r.stderr
    after = cluster.su_exec("SELECT string_agg(coalesce(relacl::text, ''), ';' ORDER BY relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'studio_ro'", db="neondb")
    assert before == after
    with ro(url) as c:
        assert c.execute("SELECT count(*) FROM studio_ro.physician_privileges").fetchone()[0] == 1


# ---------------------------------------------------------------- 0003 and 0007 compose in either order

ACL_SQL = "SELECT string_agg(relname || '=' || coalesce(relacl::text, ''), ';' ORDER BY relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'studio_ro' AND relkind = 'v'"


def _assert_all_views_readable_and_base_tables_denied(cluster, url):
    cluster.su_exec("ALTER ROLE studio_gov_ro LOGIN PASSWORD 'ro-test-pw'")
    with ro(url) as c:
        for view, cols in {**BASE_VIEW_COLUMNS, **DOCAUDIT_VIEW_COLUMNS}.items():  # 0003 and 0007 only: no 0008 columns
            assert tuple(d.name for d in c.execute(f"SELECT * FROM studio_ro.{view} WHERE false").description) == cols
        for table in (*VIEW_BASE_TABLES, *DOCAUDIT_BASE_TABLES):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                c.execute(f"SELECT * FROM public.{table}")
            c.rollback()


@pytest.mark.parametrize("order", [("a", "b"), ("b", "a"), ("a", "b", "a"), ("b", "a", "b", "a")])
def test_0003_and_0007_compose_in_any_order_and_reruns_keep_every_grant(cluster, tmp_path, order):
    files = {"a": SQL_VIEWS, "b": SQL_DOCAUDIT}
    assert run_roles(cluster, tmp_path, tag="roles")[0].returncode == 0
    for n, key in enumerate(order):
        r, _ = run_roles(cluster, tmp_path, sql_file=files[key], tag=f"c{n}")
        assert r.returncode == 0, r.stderr
    after_all = cluster.su_exec(ACL_SQL, db="neondb")[0][0]
    # a further 0003 re-run (the case that used to strip the doc-audit grants) changes nothing
    r, _ = run_roles(cluster, tmp_path, sql_file=SQL_VIEWS, tag="rerun3")
    assert r.returncode == 0, r.stderr
    assert cluster.su_exec(ACL_SQL, db="neondb")[0][0] == after_all
    for v in DOCAUDIT_VIEW_COLUMNS:
        assert f"{v}=" in after_all and "studio_gov_ro=r/" in after_all.split(f"{v}=")[1].split(";")[0], v
    cluster.su_exec("ALTER ROLE studio_gov_ro LOGIN PASSWORD 'ro-test-pw'")
    _assert_all_views_readable_and_base_tables_denied(cluster, cluster.url("studio_gov_ro", "neondb", "ro-test-pw"))


def test_0007_rerun_after_0003_does_not_touch_the_m1_grants(cluster, tmp_path):
    assert run_roles(cluster, tmp_path, tag="roles")[0].returncode == 0
    assert run_roles(cluster, tmp_path, sql_file=SQL_VIEWS, tag="v")[0].returncode == 0
    m1_acl = cluster.su_exec("SELECT string_agg(relname || '=' || relacl::text, ';' ORDER BY relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'studio_ro' AND relkind = 'v'", db="neondb")[0][0]
    for n in range(2):
        assert run_roles(cluster, tmp_path, sql_file=SQL_DOCAUDIT, tag=f"d{n}")[0].returncode == 0
    for part in m1_acl.split(";"):
        assert part in cluster.su_exec(ACL_SQL, db="neondb")[0][0]


def test_0007_revokes_a_stray_grant_on_its_views_but_a_stray_column_grant_rolls_back(cluster, tmp_path):
    assert run_roles(cluster, tmp_path, tag="roles")[0].returncode == 0
    assert run_roles(cluster, tmp_path, sql_file=SQL_VIEWS, tag="v")[0].returncode == 0
    assert run_roles(cluster, tmp_path, sql_file=SQL_DOCAUDIT, tag="d")[0].returncode == 0
    cluster.su_exec("GRANT SELECT ON studio_ro.document_audit_list TO PUBLIC", db="neondb")
    assert run_roles(cluster, tmp_path, sql_file=SQL_DOCAUDIT, tag="d2")[0].returncode == 0
    assert cluster.su_exec("SELECT count(*) FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'studio_ro.document_audit_list'::regclass AND a.grantee = 0", db="neondb")[0][0] == 0
    cluster.su_exec("GRANT SELECT (physician_id) ON public.document_audits TO studio_gov_ro", db="neondb")
    r, _ = run_roles(cluster, tmp_path, sql_file=SQL_DOCAUDIT, tag="d3")
    assert r.returncode != 0 and "can read base table document_audits" in r.stderr


@pytest.mark.parametrize("old,new", [
    ("d.source, d.created_at\nFROM public.document_audits d;", "d.source, d.created_at, d.external_ref AS code\nFROM public.document_audits d;"),
    ("d.doc_type, d.note_date AS doc_day", "d.doc_type"),
])
def test_0007_allowlist_rolls_back_an_added_or_missing_column(cluster, tmp_path, old, new):
    assert run_roles(cluster, tmp_path, tag="roles")[0].returncode == 0
    text = SQL_DOCAUDIT.read_text()
    assert old in text
    bad = tmp_path / "bad7.sql"
    bad.write_text(text.replace(old, new))
    r, _ = run_roles(cluster, tmp_path, sql_file=bad, tag="bad7")
    assert r.returncode != 0 and "differ from the reviewed allowlist" in r.stderr
    assert cluster.su_exec("SELECT count(*) FROM pg_namespace WHERE nspname = 'studio_ro'", db="neondb")[0][0] == 0


def test_migration_refuses_without_the_read_role_and_as_a_superuser(cluster, tmp_path):
    r, _ = run_roles(cluster, tmp_path, sql_file=SQL_VIEWS, tag="norole")
    assert r.returncode != 0 and "run 0001_roles.sql first" in r.stderr
    assert cluster.su_exec("SELECT count(*) FROM pg_namespace WHERE nspname = 'studio_ro'", db="neondb")[0][0] == 0
    assert run_roles(cluster, tmp_path, tag="roles")[0].returncode == 0
    r, _ = run_roles(cluster, tmp_path, sql_file=SQL_VIEWS, url=cluster.su.replace("/postgres?", "/neondb?"), tag="su")
    assert r.returncode != 0 and "not a superuser" in r.stderr
    assert cluster.su_exec("SELECT count(*) FROM pg_namespace WHERE nspname = 'studio_ro'", db="neondb")[0][0] == 0


def test_migration_refuses_a_schema_owned_by_someone_else(cluster, tmp_path):
    assert run_roles(cluster, tmp_path, tag="roles")[0].returncode == 0
    cluster.su_exec("CREATE SCHEMA studio_ro", db="neondb")  # owned by the superuser
    r, _ = run_roles(cluster, tmp_path, sql_file=SQL_VIEWS, tag="foreign")
    assert r.returncode != 0 and "owned by another role" in r.stderr


def test_postcheck_rolls_back_a_free_text_looking_column(cluster, tmp_path):
    assert run_roles(cluster, tmp_path, tag="roles")[0].returncode == 0
    bad = tmp_path / "bad.sql"
    bad.write_text(SQL_VIEWS.read_text().replace("q.created_at\nFROM public.qualifications q;", "q.created_at, q.file_data\nFROM public.qualifications q;"))
    assert "q.file_data\nFROM" in bad.read_text()
    r, _ = run_roles(cluster, tmp_path, sql_file=bad, tag="bad")
    assert r.returncode != 0 and "free text" in r.stderr
    assert cluster.su_exec("SELECT count(*) FROM pg_namespace WHERE nspname = 'studio_ro'", db="neondb")[0][0] == 0  # nothing left behind


def test_the_live_probe_passes_with_the_views_installed_and_requires_them(world, cluster, tmp_path):
    cluster, _, url = world
    env = {**os.environ, "GOV_RO_DATABASE_URL": url, "STUDIO_EXPECT_VIEWS": "1"}
    p = subprocess.run([sys.executable, "-m", "pytest", str(PROBE), "-q", "-p", "no:cacheprovider"], cwd=AGENT, env=env, capture_output=True, text=True)
    assert "failed" not in p.stdout and "skipped" not in p.stdout and " passed" in p.stdout, p.stdout[-2500:]


def test_the_live_probe_fails_loudly_when_views_are_expected_but_missing(cluster, tmp_path):
    assert run_roles(cluster, tmp_path, tag="roles")[0].returncode == 0
    cluster.su_exec("ALTER ROLE studio_gov_ro LOGIN PASSWORD 'ro-test-pw'")
    url = cluster.url("studio_gov_ro", "neondb", "ro-test-pw")
    env = {**os.environ, "GOV_RO_DATABASE_URL": url, "STUDIO_EXPECT_VIEWS": "1"}
    p = subprocess.run([sys.executable, "-m", "pytest", str(PROBE), "-q", "-p", "no:cacheprovider", "-k", "view"], cwd=AGENT, env=env, capture_output=True, text=True)
    assert "failed" in p.stdout and "not installed" in p.stdout


@pytest.mark.parametrize("tool_name", sorted(VIEW_TOOLS))
def test_every_view_tool_sql_runs_as_the_read_role_against_the_real_schema(world, tool_name):
    _, i, url = world
    args = {
        "physician_privileges": (i["p1"], 50),
        "physician_oppe": (i["p1"], 50),
        "physician_metrics": (i["p1"], 12, 50),
        "physician_qualifications": (i["p1"], 50),
        "capture_gaps": (50,),
        "feedback_by_physician": (i["p1"], 365, None, None, 50),
    }[tool_name]
    sql = studio_tools.ALL_SQL[tool_name]
    assert sql.count("%s") == len(args)
    with ro(url) as c:
        cols = [d.name for d in c.execute(sql, args).description]
        rows = c.execute(sql, args).fetchall()
    assert rows, tool_name
    assert not set(cols) & set(FREE_TEXT_COLUMNS)
    if tool_name == "feedback_by_physician":
        assert sorted((r[0], r[1], r[2], r[3], r[4]) for r in rows) == [
            ("patient", "negative", "high", "open", 2),
            ("patient", "positive", "n/a", "closed", 1),
            ("peer", "negative", "low", "open", 1),
        ]


@pytest.mark.parametrize("tool_name", sorted(VIEW_TOOLS))
def test_live_and_fixture_columns_agree_for_each_view_tool(world, tool_name, monkeypatch):
    """Live/fixture parity: the fixture has exactly the columns the live SQL returns."""
    _, i, url = world
    args = {
        "physician_privileges": (i["p1"], 50),
        "physician_oppe": (i["p1"], 50),
        "physician_metrics": (i["p1"], 12, 50),
        "physician_qualifications": (i["p1"], 50),
        "capture_gaps": (50,),
        "feedback_by_physician": (i["p1"], 365, None, None, 50),
    }[tool_name]
    with ro(url) as c:
        live_cols = [d.name for d in c.execute(studio_tools.ALL_SQL[tool_name], args).description]
    fixture = json.loads((studio_tools.FIXTURE_DIR / f"{tool_name}.json").read_text())
    assert fixture["columns"] == live_cols
    assert all(list(r) == live_cols for r in fixture["rows"])


def test_tool_end_to_end_through_the_real_driver_path(world, monkeypatch):
    """run_read_tool with the real fetch path replaced only by a connection as the read role."""
    _, i, url = world
    audits = []

    async def audit(row):
        audits.append(row)

    async def fetch(sql, params):
        studio_tools.assert_read_only(sql)
        async with await psycopg.AsyncConnection.connect(url, autocommit=False, prepare_threshold=None, row_factory=psycopg.rows.dict_row) as c:
            return await (await c.execute(sql, params)).fetchall()

    monkeypatch.setattr(studio_audit, "audit_sink", audit)
    monkeypatch.setattr(studio_tools, "fetch_rows", fetch)
    tool = next(t for t in studio_tools.VIEW_TOOLS if t.name == "feedback_by_physician")
    out = json.loads(asyncio.run(tool.ainvoke({"physician_id": i["p1"]}, config=CFG)))
    assert out["mode"] == "live" and out["row_count"] == 3 and "SECRET" not in json.dumps(out)
    assert [(a.tool, a.row_count, a.outcome) for a in audits] == [("feedback_by_physician", 3, "ok")]


def test_default_privileges_to_another_role_do_not_survive_the_migration(cluster, tmp_path):
    r, _ = run_roles(cluster, tmp_path, tag="roles-dp")
    assert r.returncode == 0, r.stderr
    cluster.su_exec("CREATE ROLE other_reader NOLOGIN; ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner GRANT SELECT ON TABLES TO other_reader", db="neondb")
    v, _ = run_roles(cluster, tmp_path, sql_file=SQL_VIEWS, tag="views-dp")
    assert v.returncode == 0, v.stderr
    with psycopg.connect(cluster.owner_url, autocommit=True) as c:
        n = c.execute("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a "
                      "WHERE n.nspname = 'studio_ro' AND a.grantee = 'other_reader'::regrole").fetchone()[0]
    assert n == 0
