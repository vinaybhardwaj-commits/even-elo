"""ops/neon role scripts (R14: roles by SQL, password only from the Neon API) against a scratch Postgres
with an emulated Neon role layout and a NON-superuser owner. Never touches Neon."""

import os
import re
import subprocess
import sys
import threading

import psycopg
import pytest

from src import studio_tools
from tests.neon_harness import (
    AGENT, APP_PROBE, BRANCH, OPS, PROBE, PROJECT, RUN_ROLES, SQL_APP, SQL_GOV, SQL_LOGIN, assert_nowhere,
    cluster, full_flow, keyfile, memberships, needs_pg, neon, non_comment_sql, owner_file, role_row, run_roles,
)  # noqa: F401  (fixtures)

pytestmark = pytest.mark.skipif(not OPS.exists(), reason="ops/neon not available")  # DB tests skip via the cluster fixture


# ---------------------------------------------------------------- static checks


def test_grant_list_agrees_across_sql_tools_and_probe():
    sql = SQL_GOV.read_text()
    granted = tuple(t.strip() for t in re.search(r"GRANT SELECT ON ([a-z_, ]+) TO studio_gov_ro;", sql).group(1).split(","))
    used = set()
    for q in studio_tools.ALL_SQL.values():
        used |= set(re.findall(r"\b(?:FROM|JOIN)\s+([a-z_]+)\b", q))
    used -= {"jsonb_array_elements", "generate_series"}
    probe = re.search(r"GOV_TABLES = \(([^)]*)\)", PROBE.read_text()).group(1)
    probe_tables = tuple(t.strip().strip('"') for t in probe.split(",") if t.strip())
    assert set(granted) == set(studio_tools.GOVERNANCE_TABLES) == set(probe_tables) == used and len(granted) == 6
    assert re.findall(r"GRANT SELECT \(([a-z_, ]+)\) ON ([a-z_]+) TO studio_gov_ro;", sql) == [
        ("id, status, is_super_admin", "profiles_with_roles"),
        ("id, must_change_pin", "profiles"),
    ]
    assert len(re.findall(r"^GRANT ", sql, re.M)) == 4


def test_no_sql_file_has_a_password_clause_and_logins_only_in_the_login_file():
    for f in (SQL_GOV, SQL_APP, SQL_LOGIN):
        code = non_comment_sql(f)
        assert not re.search(r"\bPASSWORD\b|\bpassword\b|rolepw|verifier|\\set\s+\w*pw", code, re.I), f.name
    for f in (SQL_GOV, SQL_APP):
        code = non_comment_sql(f)
        assert "NOLOGIN" in code and not re.search(r"(?<!NO)LOGIN\b", code), f"{f.name} must never enable LOGIN"
    login = non_comment_sql(SQL_LOGIN)
    assert len(re.findall(r'ALTER ROLE :"role" LOGIN;', login)) == 1
    assert "pg_auth_members" in login and login.index("ALTER ROLE") < login.rindex("pg_auth_members")
    scripts = (RUN_ROLES.read_text() + (OPS / "neon-role.sh").read_text())
    for gone in ("--password-preset", "neon-plaintext-password", "SCRAM-SHA-256", "openssl rand", "verifier"):
        assert gone not in scripts, gone
    assert "create)" not in (OPS / "neon-role.sh").read_text()


def test_membership_preflight_and_postcheck_are_in_the_setup_files():
    for f in (SQL_GOV, SQL_APP):
        code = non_comment_sql(f)
        assert code.count("pg_auth_members") == 2, f.name  # preflight + post-check
        assert code.index("pg_auth_members") < code.index("CREATE ROLE") < code.rindex("pg_auth_members")


def test_dry_run_prints_the_chosen_step_and_connects_nowhere(tmp_path):
    for flags, needle in (([], "CREATE ROLE studio_gov_ro"), (["--role", "studio_app"], "CREATE ROLE studio_app"), (["--login"], 'ALTER ROLE :"role" LOGIN')):
        r = subprocess.run(["bash", str(RUN_ROLES), "--dry-run", *flags], capture_output=True, text=True, env={"PATH": os.environ["PATH"], "PSQL": "/nonexistent/psql"})
        assert r.returncode == 0 and needle in r.stdout, flags


def test_argument_validation_and_removed_flags(tmp_path):
    def run(*a):
        return subprocess.run(["bash", str(RUN_ROLES), *a], capture_output=True, text=True, env={"PATH": os.environ["PATH"]})

    assert run().returncode == 2
    assert run("--role", "someone_else", str(tmp_path / "x")).returncode == 2
    for old in ("--password-preset", "--neon-plaintext-password"):
        r = run(old, str(tmp_path / "x"))
        assert r.returncode == 2 and "unknown option" in r.stderr, old
    r = run(str(tmp_path / "missing"))
    assert r.returncode == 2 and "not readable" in r.stderr


# ---------------------------------------------------------------- setup as the emulated non-superuser owner


def test_setup_creates_a_nologin_role_with_grants_and_no_membership(cluster, tmp_path):
    mark = cluster.log_mark()
    stop, saw_login = threading.Event(), []

    def poll():
        with psycopg.connect(cluster.su, autocommit=True) as c:
            while not stop.is_set():
                row = c.execute("SELECT rolcanlogin FROM pg_roles WHERE rolname = 'studio_gov_ro'").fetchone()
                if row and row[0]:
                    saw_login.append(True)

    t = threading.Thread(target=poll, daemon=True)
    t.start()
    r, scratch = run_roles(cluster, tmp_path)
    stop.set()
    t.join(2)
    assert r.returncode == 0, r.stderr
    assert not saw_login and not list(scratch.iterdir())  # never LOGIN-able at any sampled moment; temp shredded
    assert role_row(cluster, "studio_gov_ro")[:8] == (False, False, False, False, False, False, False, 5)
    assert memberships(cluster, "studio_gov_ro") == []
    with psycopg.connect(cluster.owner_url) as c:
        assert c.execute("SELECT has_table_privilege('studio_gov_ro','physicians','SELECT'), has_table_privilege('studio_gov_ro','physicians','INSERT')").fetchone() == (True, False)
    log = cluster.log_since(mark)
    assert "PASSWORD" not in log.upper().replace("PASSWORD_ENCRYPTION", "")  # no password statement of any kind
    assert re.search(r"CREATE ROLE studio_gov_ro NOLOGIN", log)


def test_setup_is_idempotent_and_does_not_change_the_login_state(cluster, tmp_path):
    assert run_roles(cluster, tmp_path, tag="a")[0].returncode == 0
    cluster.owner_exec("ALTER ROLE studio_gov_ro LOGIN")  # as the final step would have done
    before = (role_row(cluster, "studio_gov_ro"), cluster.acl("physicians"))
    r, _ = run_roles(cluster, tmp_path, tag="b")
    assert r.returncode == 0, r.stderr
    after = (role_row(cluster, "studio_gov_ro"), cluster.acl("physicians"))
    assert after == before and after[0][0] is True  # an already-enabled role stays enabled, atomically re-granted


@pytest.mark.parametrize("granted", ["neon_superuser", "pg_monitor"])
def test_preflight_refuses_a_role_that_is_a_member_of_anything(cluster, tmp_path, granted):
    # What Neon's API leaves behind: the role exists with neon_superuser (here also a second case: any other role).
    cluster.su_exec("CREATE ROLE studio_gov_ro LOGIN")
    cluster.su_exec(f"GRANT {granted} TO studio_gov_ro")
    before = role_row(cluster, "studio_gov_ro")
    r, scratch = run_roles(cluster, tmp_path)
    assert r.returncode != 0 and "already a member of another role" in r.stderr and not list(scratch.iterdir())
    assert role_row(cluster, "studio_gov_ro") == before  # rolled back: untouched
    assert cluster.acl("physicians") and "studio_gov_ro" not in cluster.acl("physicians")[0][0]  # no grant was applied


def test_postcheck_fires_and_rolls_everything_back(cluster, tmp_path):
    injected = tmp_path / "inject.sql"
    injected.write_text(SQL_GOV.read_text().replace("-- POST-CHECK", "CREATE ROLE grp_x NOLOGIN;\nGRANT grp_x TO studio_gov_ro;\n-- POST-CHECK"))
    assert "GRANT grp_x" in injected.read_text()
    r, _ = run_roles(cluster, tmp_path, sql_file=injected)
    assert r.returncode != 0 and "ended up a member of another role" in r.stderr
    assert role_row(cluster, "studio_gov_ro") is None and role_row(cluster, "grp_x") is None  # nothing left, not even the roles


def test_injected_failure_leaves_no_role_and_a_failing_rerun_leaves_the_previous_state(cluster, tmp_path):
    failing = tmp_path / "fail.sql"
    failing.write_text(SQL_GOV.read_text().replace("GRANT SELECT (id, must_change_pin) ON profiles", "GRANT SELECT (id, no_such_column) ON profiles"))
    r, scratch = run_roles(cluster, tmp_path, sql_file=failing, tag="f1")
    assert r.returncode != 0 and role_row(cluster, "studio_gov_ro") is None and not list(scratch.iterdir())
    assert run_roles(cluster, tmp_path, tag="ok")[0].returncode == 0
    before = (role_row(cluster, "studio_gov_ro"), cluster.acl("physicians"))
    assert run_roles(cluster, tmp_path, sql_file=failing, tag="f2")[0].returncode != 0
    assert (role_row(cluster, "studio_gov_ro"), cluster.acl("physicians")) == before


# ---------------------------------------------------------------- the login step


def test_login_refuses_a_missing_role_missing_grants_and_membership(cluster, tmp_path):
    r, _ = run_roles(cluster, tmp_path, "--login", tag="l0")
    assert r.returncode != 0 and "does not exist" in r.stderr
    cluster.owner_exec("CREATE ROLE studio_gov_ro NOLOGIN")  # exists (owner administers it), but no grants
    r, _ = run_roles(cluster, tmp_path, "--login", tag="l1")
    assert r.returncode != 0 and "lacks its grants" in r.stderr and role_row(cluster, "studio_gov_ro")[0] is False
    assert run_roles(cluster, tmp_path, tag="l2")[0].returncode == 0
    cluster.su_exec("GRANT neon_superuser TO studio_gov_ro")  # the API added it on reset
    r, _ = run_roles(cluster, tmp_path, "--login", tag="l3")
    assert r.returncode != 0 and "member of another role" in r.stderr and role_row(cluster, "studio_gov_ro")[0] is False
    cluster.su_exec("REVOKE neon_superuser FROM studio_gov_ro")
    r, _ = run_roles(cluster, tmp_path, "--login", tag="l4")
    assert r.returncode == 0, r.stderr
    assert role_row(cluster, "studio_gov_ro")[0] is True and "LOGIN enabled" in r.stdout


# ---------------------------------------------------------------- the whole flow, with the mock Neon API


def _probe(url, file=PROBE, var="GOV_RO_DATABASE_URL"):
    return subprocess.run([sys.executable, "-m", "pytest", str(file), "-q", "-p", "no:cacheprovider"], cwd=AGENT, env={**os.environ, var: url}, capture_output=True, text=True)


def test_full_flow_gov_ro_setup_reset_login_probe_and_no_secret_anywhere(cluster, neon, keyfile, tmp_path):
    mark = cluster.log_mark()
    s, r, nr, out = full_flow(cluster, neon, tmp_path, keyfile)
    assert s.returncode == 0 and r.returncode == 0, (s.stderr, r.stderr)
    pw = neon.issued["studio_gov_ro"]
    assert role_row(cluster, "studio_gov_ro")[0] is False  # still NOLOGIN after the reset
    l, _ = run_roles(cluster, tmp_path, "--login", tag="login")
    assert l.returncode == 0, l.stderr
    assert role_row(cluster, "studio_gov_ro")[0] is True and memberships(cluster, "studio_gov_ro") == []
    dsn = out.read_text().strip()
    assert dsn.startswith("postgresql://studio_gov_ro:") and "@/neondb?host=" in dsn
    probe = _probe(dsn)
    assert probe.returncode == 0 and "skipped" not in probe.stdout and "failed" not in probe.stdout, probe.stdout[-2500:]
    log = cluster.log_since(mark)
    # Server log: the ALTER ... PASSWORD in it is the MOCK API's own server-side call (Neon's side), never ours;
    # our scripts issued none, and the issued password never appears in anything they produced.
    ours = [l for l in log.splitlines() if "statement:" in l and "PASSWORD" in l.upper() and "studio_gov_ro" in l and "pg_authid" not in l]
    assert len(ours) == 1 and "Is5ued" in ours[0]  # exactly the emulated Neon-side set, nothing from run-roles.sh
    assert_nowhere(nr, r, pw, API_KEY_FOR_SCAN)
    assert pw not in s.stdout + s.stderr + l.stdout + l.stderr


API_KEY_FOR_SCAN = "napi_KEY_do_not_leak_0123456789abcdef"


def test_membership_added_by_the_api_on_reset_blocks_login(cluster, neon, keyfile, tmp_path):
    neon.add_superuser_on_reset = True  # Neon manages the role it just reset: grants neon_superuser
    s, r, nr, out = full_flow(cluster, neon, tmp_path, keyfile)
    assert s.returncode == 0 and r.returncode == 0
    assert memberships(cluster, "studio_gov_ro") == ["neon_superuser"]
    l, _ = run_roles(cluster, tmp_path, "--login", tag="blocked")
    assert l.returncode != 0 and "member of another role" in l.stderr
    assert role_row(cluster, "studio_gov_ro")[0] is False  # never LOGIN-able: neon_superuser membership + password issued
    # Cleanup path (SQL-created role: the owner has ADMIN on it) then login succeeds.
    r2, _ = run_roles(cluster, tmp_path, tag="redo")
    assert r2.returncode != 0 and "already a member" in r2.stderr  # setup also refuses it, by design


def test_api_cannot_see_the_sql_created_role_exits_4_and_changes_nothing(cluster, neon, keyfile, tmp_path):
    neon.hidden.add("studio_gov_ro")
    s, r, nr, out = full_flow(cluster, neon, tmp_path, keyfile)
    assert s.returncode == 0
    assert r.returncode == 4 and "role not visible to Neon API" in r.stderr
    assert not out.exists() and neon.posts == [] and "studio_gov_ro" not in neon.issued  # no reset call at all
    assert role_row(cluster, "studio_gov_ro")[0] is False


def test_studio_app_flow_setup_migrate_reset_login_probe(cluster, neon, keyfile, tmp_path):
    sys.path.insert(0, str(AGENT))
    import apply_migration

    s, _ = run_roles(cluster, tmp_path, "--role", "studio_app", url=cluster.studio_owner_url, tag="app")
    assert s.returncode == 0, s.stderr
    assert role_row(cluster, "studio_app")[0] is False and memberships(cluster, "studio_app") == []
    l, _ = run_roles(cluster, tmp_path, "--login", "--role", "studio_app", url=cluster.studio_owner_url, tag="applogin0")
    assert l.returncode != 0 and "lacks its grants" in l.stderr  # migration not applied yet
    assert apply_migration.apply(cluster.studio_owner_url, "studio_app") == ["0001_studio"]
    _, r, nr, out = full_flow(cluster, neon, tmp_path, keyfile, role="studio_app", db="studiodb", tag="app2")
    assert r.returncode == 0, r.stderr
    l, _ = run_roles(cluster, tmp_path, "--login", "--role", "studio_app", url=cluster.studio_owner_url, tag="applogin")
    assert l.returncode == 0, l.stderr
    dsn = out.read_text().strip()
    assert "studio_app:" in dsn and "@/studiodb?host=" in dsn
    probe = _probe(dsn, APP_PROBE, "STUDIO_DATABASE_URL")
    assert probe.returncode == 0 and "skipped" not in probe.stdout and "failed" not in probe.stdout, probe.stdout[-2500:]


# ---------------------------------------------------------------- tmpfs discipline


def test_disk_backed_temp_is_refused_unless_allowed(cluster, tmp_path):
    f = owner_file(tmp_path, cluster.owner_url)
    env = {"PATH": os.environ["PATH"], "PSQL": cluster.psql, "STUDIO_ROLES_SHM": str(tmp_path / "no-shm"), "TMPDIR": str(tmp_path)}
    r = subprocess.run(["bash", str(RUN_ROLES), str(f)], capture_output=True, text=True, env=env)
    assert r.returncode == 2 and "tmpfs" in r.stderr and not list(tmp_path.glob("studio-roles.*"))
    r = subprocess.run(["bash", str(RUN_ROLES), "--allow-disk-tmp", str(f)], capture_output=True, text=True, env=env)
    assert r.returncode == 0 and not list(tmp_path.glob("studio-roles.*"))
