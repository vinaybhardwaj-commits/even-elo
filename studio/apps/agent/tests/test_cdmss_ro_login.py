"""The LOGIN step for studio_cdmss_ro, with the SAME scripts as the governance flow (parameterised, not forked):
neon-role.sh (project from an @env file, branch `auto`, endpoint discovery) + run-roles.sh --role studio_cdmss_ro --login.
Against a scratch Postgres and the local Neon API mock; never touches Neon or the Asus."""

import re
import shutil
import stat
import subprocess
from urllib.parse import quote

import psycopg
import pytest

from tests.cdmss_harness import ROLE, SQL_POST, cdmss, needs_env  # noqa: F401  (fixture)
from tests.neon_harness import (
    API_KEY, BRANCH, CDMSS_BRANCH, CDMSS_BRANCH_DEV, CDMSS_HOST, CDMSS_PROJECT, NEON_ROLE, PROJECT, RUN_ROLES, MockNeon, NeonRun,
    assert_nowhere, keyfile, owner_file, run_roles,
)  # noqa: F401  (fixtures)

pytestmark = [needs_env, pytest.mark.skipif(shutil.which("jq") is None or shutil.which("curl") is None, reason="needs jq and curl")]


@pytest.fixture
def mock(cdmss):
    m = MockNeon(cdmss)
    yield m
    m.stop()


@pytest.fixture(autouse=True)
def _nologin_after(cdmss):
    yield
    cdmss.su_exec(f"ALTER ROLE {ROLE} NOLOGIN")  # the shared session role must end NOLOGIN, whatever a test did


def env_file(tmp_path, text, mode=0o600, name="even-cdmss.env"):
    f = tmp_path / name
    f.write_text(text)
    f.chmod(mode)
    return f


def role_login(cdmss):
    return cdmss.su_exec(f"SELECT rolcanlogin FROM pg_roles WHERE rolname='{ROLE}'")[0][0]


# ---------------------------------------------------------------- neon-role.sh: second project, discovery


def test_project_from_a_vercel_env_file_and_branch_auto(tmp_path, mock, keyfile, cdmss):
    nr = NeonRun(tmp_path, mock.url, "auto")
    pf = env_file(tmp_path, f'FOO=bar\nNEON_PROJECT_ID="{CDMSS_PROJECT}"\nDATABASE_URL=postgres://user:SECRETPW@h/db\n')
    out = tmp_path / "pw"
    r = nr.run("reset-password", str(keyfile), f"@{pf}", "auto", ROLE, str(out))
    assert r.returncode == 0, r.stderr
    pw = mock.issued[ROLE]
    assert out.read_text() == pw + "\n" and stat.S_IMODE(out.stat().st_mode) == 0o600
    paths = [p for _, p, _, _ in mock.requests]
    assert f"/api/v2/projects/{CDMSS_PROJECT}/branches" in paths  # the default branch was discovered via the API
    assert f"/api/v2/projects/{CDMSS_PROJECT}/branches/{CDMSS_BRANCH}/roles/{ROLE}/reset_password" in paths
    assert not any(CDMSS_BRANCH_DEV in p for p in paths)
    assert not list(nr.scratch.iterdir())
    assert_nowhere(nr, r, pw, API_KEY, "SECRETPW")


def test_project_file_forms_and_refusals(tmp_path, mock, keyfile):
    nr = NeonRun(tmp_path, mock.url, "pf")
    bare = env_file(tmp_path, CDMSS_PROJECT + "\n", name="bare")
    r = nr.run("resolve", str(keyfile), f"@{bare}")
    assert r.returncode == 0 and f"branch\t{CDMSS_BRANCH}\tmain\tdefault" in r.stdout and f"endpoint\tep-cdmss-main-1\t{CDMSS_BRANCH}\tread_write\t{CDMSS_HOST}" in r.stdout
    assert "SECRET" not in r.stdout + r.stderr and "password" not in r.stdout
    loose = env_file(tmp_path, f"NEON_PROJECT_ID={CDMSS_PROJECT}\n", mode=0o644, name="loose")
    r = nr.run("resolve", str(keyfile), f"@{loose}")
    assert r.returncode == 2 and "mode 600" in r.stderr
    wrong = env_file(tmp_path, "NEON_API_KEY=napi_SHOULD_NOT_ECHO\nOTHER=1\n", name="wrong")
    r = nr.run("resolve", str(keyfile), f"@{wrong}")
    assert r.returncode == 2 and "SHOULD_NOT_ECHO" not in r.stdout + r.stderr
    r = nr.run("resolve", str(keyfile), f"@{tmp_path / 'missing'}")
    assert r.returncode == 2 and "not readable" in r.stderr


def test_branch_auto_and_the_governance_form_still_work(tmp_path, mock, keyfile, cdmss):
    """Parameterised, not forked: the original positional governance call is unchanged; `auto` also works on a one-branch project."""
    nr = NeonRun(tmp_path, mock.url, "gov")
    cdmss.su_exec("CREATE ROLE studio_gov_ro NOLOGIN")
    try:
        r = nr.run("reset-password", str(keyfile), PROJECT, "auto", "studio_gov_ro", str(tmp_path / "gov-pw"))  # only branch -> picked
        assert r.returncode == 0, r.stderr
        r = nr.run("reset-password", str(keyfile), PROJECT, BRANCH, "studio_gov_ro", str(tmp_path / "gov-pw2"))  # original form
        assert r.returncode == 0, r.stderr
        assert (tmp_path / "gov-pw2").read_text() == mock.issued["studio_gov_ro"] + "\n"
    finally:
        cdmss.su_exec("DROP ROLE studio_gov_ro")


def test_branch_auto_refuses_a_project_with_no_candidate(tmp_path, mock, keyfile):
    nr = NeonRun(tmp_path, mock.url, "nocand")
    r = nr.run("reset-password", str(keyfile), "proj-unknown-0000", "auto", ROLE, str(tmp_path / "o"))
    assert r.returncode == 2 and "cannot pick a branch" in r.stderr and not (tmp_path / "o").exists() and mock.posts == []


def test_dsn_host_auto_and_pooled_use_the_discovered_endpoint(tmp_path, mock, keyfile, cdmss):
    nr = NeonRun(tmp_path, mock.url, "host")
    owner = owner_file(tmp_path, "postgresql://neondb_owner:OWNERPW@ep-direct-0.ap-south-1.aws.neon.tech/cdmssdb?sslmode=require&channel_binding=require")
    pf = env_file(tmp_path, f"NEON_PROJECT_ID={CDMSS_PROJECT}\n")
    for mode, host in (("auto", CDMSS_HOST), ("pooled", CDMSS_HOST.replace("ep-cdmss-main-1.", "ep-cdmss-main-1-pooler."))):
        out = tmp_path / f"dsn-{mode}"
        r = nr.run("reset-password", str(keyfile), f"@{pf}", "auto", ROLE, str(out), "--dsn-from", str(owner), "--host", mode)
        assert r.returncode == 0, r.stderr
        pw = mock.issued[ROLE]
        assert out.read_text().strip() == f"postgresql://{ROLE}:{quote(pw, safe='')}@{host}/cdmssdb?sslmode=require&channel_binding=require"
        assert "OWNERPW" not in out.read_text() and stat.S_IMODE(out.stat().st_mode) == 0o600
        assert_nowhere(nr, r, pw, quote(pw, safe=""), API_KEY, "OWNERPW")
    r = nr.run("reset-password", str(keyfile), f"@{pf}", "auto", ROLE, str(tmp_path / "x"), "--host", "auto")
    assert r.returncode == 2 and "needs --dsn-from" in r.stderr


# ---------------------------------------------------------------- run-roles.sh --role studio_cdmss_ro


def rr(cdmss, tmp_path, *flags, tag="rr", sql_post=None):
    return run_roles(cdmss, tmp_path, "--role", ROLE, *flags, url=cdmss.owner_url, tag=tag,
                     extra_env={"CDMSS_POSTCHECK_SQL": str(sql_post)} if sql_post else None)


def test_cdmss_role_has_no_setup_step_in_run_roles(cdmss, tmp_path):
    r, _ = rr(cdmss, tmp_path)
    assert r.returncode == 2 and "run-cdmss-ro.sh" in r.stderr and not role_login(cdmss)
    r, _ = run_roles(cdmss, tmp_path, "--role", "nope", url=cdmss.owner_url, tag="bad")
    assert r.returncode == 2 and "studio_cdmss_ro" in r.stderr


def test_dry_run_login_shows_the_postcheck_too(cdmss):
    r = subprocess.run(["bash", str(RUN_ROLES), "--role", ROLE, "--login", "--dry-run"], capture_output=True, text=True)
    assert r.returncode == 0 and "ALTER ROLE :\"role\" LOGIN" in r.stdout and "0003_cdmss_ro_postcheck.sql" in r.stdout and "COLUMN ALLOWLIST" in r.stdout


def test_full_flow_password_issued_by_neon_then_login_then_the_dsn_really_works(tmp_path, mock, keyfile, cdmss):
    nr = NeonRun(tmp_path, mock.url, "flow")
    pf = env_file(tmp_path, f"NEON_PROJECT_ID={CDMSS_PROJECT}\n")
    owner = owner_file(tmp_path, cdmss.owner_url, "flowo")
    out = tmp_path / "relay-url"
    assert not role_login(cdmss)
    reset = nr.run("reset-password", str(keyfile), f"@{pf}", "auto", ROLE, str(out), "--dsn-from", str(owner))
    assert reset.returncode == 0, reset.stderr
    pw = mock.issued[ROLE]
    assert_nowhere(nr, reset, pw, quote(pw, safe=""), API_KEY)  # reset-password's own stdout/stderr and process side leak nothing (v1 gap)
    assert not role_login(cdmss)  # a password alone does not enable LOGIN
    r, _ = rr(cdmss, tmp_path, "--login", tag="login")
    assert r.returncode == 0 and "LOGIN enabled" in r.stdout, r.stderr
    assert role_login(cdmss) and not cdmss.su_exec(f"SELECT 1 FROM pg_auth_members WHERE member='{ROLE}'::regrole")
    dsn = out.read_text().strip()
    assert stat.S_IMODE(out.stat().st_mode) == 0o600 and quote(pw, safe="") in dsn and dsn.startswith(f"postgresql://{ROLE}:")
    with psycopg.connect(dsn, autocommit=True) as c:  # the issued password authenticates over scram
        assert c.execute("SELECT count(*) FROM cdmss_ro.site_dim").fetchone()[0] >= 6
        assert c.execute("SHOW default_transaction_read_only").fetchone()[0] == "on"
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute("SELECT 1 FROM public.opd_note_audits")
        with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
            c.execute("CREATE TEMP TABLE t(i int)")
    assert_nowhere(nr, r, pw, quote(pw, safe=""), API_KEY)   # run-roles --login output
    assert pw not in r.stdout + r.stderr and pw not in reset.stdout + reset.stderr
    # rotation: nologin first, reset again, login again
    r, _ = rr(cdmss, tmp_path, "--nologin", tag="nologin")
    assert r.returncode in (0, 5) and not role_login(cdmss)


def test_login_refused_and_role_stays_nologin_when_neon_adds_neon_superuser(tmp_path, mock, keyfile, cdmss):
    mock.add_superuser_on_reset = True
    nr = NeonRun(tmp_path, mock.url, "su")
    out = tmp_path / "o"
    assert nr.run("reset-password", str(keyfile), CDMSS_PROJECT, CDMSS_BRANCH, ROLE, str(out)).returncode == 0
    try:
        r, _ = rr(cdmss, tmp_path, "--login", tag="sulogin")
        assert r.returncode != 0 and not role_login(cdmss)
        assert "member of another role" in r.stderr + r.stdout or "contained" in r.stderr
    finally:
        cdmss.su_exec(f"REVOKE neon_superuser FROM {ROLE}")


def test_login_refused_when_the_fence_is_broken_and_nothing_stays_enabled(tmp_path, cdmss):
    with psycopg.connect(cdmss.owner_url, autocommit=True) as c:
        c.execute("GRANT SELECT (uid) ON public.opd_note_audits TO " + ROLE)
    try:
        r, _ = rr(cdmss, tmp_path, "--login", tag="fence")
        assert r.returncode != 0 and not role_login(cdmss) and "privilege on a base relation" in r.stderr
    finally:
        with psycopg.connect(cdmss.owner_url, autocommit=True) as c:
            c.execute("REVOKE ALL ON public.opd_note_audits FROM " + ROLE)
    r, _ = rr(cdmss, tmp_path, "--login", tag="fence-ok")
    assert r.returncode == 0 and role_login(cdmss)


def test_no_password_over_sql_or_argv_in_the_scripts():
    assert "ALTER ROLE" not in NEON_ROLE.read_text()
    login_sql = "\n".join(l for l in (RUN_ROLES.parent / "0003_login.sql").read_text().splitlines() if not l.lstrip().startswith("--"))
    assert "PASSWORD" not in login_sql.upper()  # LOGIN is enabled without a password clause
    assert "--password" not in NEON_ROLE.read_text()
