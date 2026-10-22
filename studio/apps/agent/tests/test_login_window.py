"""The no-password LOGIN window (fable's GO condition for the LOGIN -> reset -> re-check order): between `run-roles --login` and the
password issue, the role is LOGIN but holds no password. With a password-based pg_hba (scram-sha-256, like Neon) it must reject every
connection attempt: no password, an empty password, a guessed password. Real setup SQL (ops/cdmss 0001/0002), the real run-roles.sh
--login step, a real server. After the mock reset path issues a password, the right one works and a wrong one is still rejected."""

import psycopg
import pytest

from tests.cdmss_harness import ROLE, cdmss, needs_env  # noqa: F401  (fixture)
from tests.neon_harness import MockNeon, run_roles

pytestmark = needs_env

AUTH_ERRORS = ("password authentication failed", "no password supplied", "authentication failed")


def attempt(cdmss, password):
    """One connection attempt as the role over the scram-protected socket. Returns the error text, or None if it connected."""
    kwargs = {"host": cdmss.sock, "user": ROLE, "dbname": "cdmssdb", "connect_timeout": 10}
    if password is not None:
        kwargs["password"] = password
    try:
        with psycopg.connect(**kwargs) as c:
            c.execute("SELECT 1")
        return None
    except psycopg.OperationalError as e:
        return str(e)


@pytest.fixture(autouse=True)
def _no_ambient_password(monkeypatch, tmp_path):
    for v in ("PGPASSWORD", "PGPASSFILE", "PGSERVICE", "PGSERVICEFILE", "PGHOST", "PGUSER"):
        monkeypatch.delenv(v, raising=False)
    monkeypatch.setenv("PGPASSFILE", str(tmp_path / "no-such-pgpass"))
    monkeypatch.setenv("HOME", str(tmp_path))


@pytest.fixture
def window(cdmss, tmp_path):
    """The role as it is between step (a) and step (b): created by the real SQL, LOGIN enabled by the real run-roles step, no password."""
    cdmss.su_exec(f"ALTER ROLE {ROLE} NOLOGIN")
    r, _ = run_roles(cdmss, tmp_path, "--role", ROLE, "--login", url=cdmss.owner_url, tag="window")
    assert r.returncode == 0, r.stderr
    assert cdmss.su_exec(f"SELECT rolcanlogin FROM pg_roles WHERE rolname='{ROLE}'")[0][0] is True
    # genuinely password-less: pg_authid is the only place that says so (harness superuser)
    assert cdmss.su_exec(f"SELECT rolpassword IS NULL FROM pg_authid WHERE rolname='{ROLE}'")[0][0] is True
    yield cdmss
    cdmss.su_exec(f"ALTER ROLE {ROLE} NOLOGIN")
    cdmss.su_exec(f"ALTER ROLE {ROLE} PASSWORD NULL")


def test_pg_hba_really_is_password_based_for_the_role(window):
    hba = window.su_exec("SELECT line_number, type, user_name::text, auth_method FROM pg_hba_file_rules ORDER BY line_number")
    mine = [h for h in hba if h[2] and ROLE in h[2]]
    assert mine and mine[0][3] == "scram-sha-256", mine         # the first rule that applies to the role is scram, not trust


@pytest.mark.parametrize("label,password", [("no password", None), ("empty password", ""), ("guessed password", "guess-1234"),
                                             ("role name as password", ROLE), ("common password", "password")])
def test_a_login_role_with_no_password_rejects_every_attempt(window, label, password):
    err = attempt(window, password)
    assert err is not None, f"connected as {ROLE} with {label}"
    assert any(m in err for m in AUTH_ERRORS), err


def test_after_the_reset_the_issued_password_works_and_wrong_ones_still_fail(window, tmp_path, keyfile_for_window):
    # the mock reset path: Neon sets the password server-side (as MockNeon does with ALTER ROLE ... PASSWORD)
    mock = MockNeon(window)
    try:
        from tests.neon_harness import CDMSS_BRANCH, CDMSS_PROJECT, NeonRun
        mock.reject_reset_for_nologin = True                      # live behaviour: the role is LOGIN now, so the reset is accepted
        nr = NeonRun(tmp_path, mock.url, "window")
        out = tmp_path / "pw"
        r = nr.run("reset-password", str(keyfile_for_window), CDMSS_PROJECT, CDMSS_BRANCH, ROLE, str(out))
        assert r.returncode == 0, r.stderr
        pw = mock.issued[ROLE]
        assert attempt(window, pw) is None                          # the one password that was issued
        for wrong in (None, "", "guess-1234", pw + "x", pw[:-1]):
            err = attempt(window, wrong)
            assert err is not None and any(m in err for m in AUTH_ERRORS), (wrong, err)
    finally:
        mock.stop()


@pytest.fixture
def keyfile_for_window(tmp_path):
    from tests.neon_harness import API_KEY
    f = tmp_path / "api-key"
    f.write_text(API_KEY + "\n")
    f.chmod(0o600)
    return f


# ---------------------------------------------------------------- the throwaway seed (run-roles.sh --seed-password), real PG


def seed(cdmss, tmp_path, tag="seed", role=ROLE, extra=()):
    return run_roles(cdmss, tmp_path, "--role", role, "--seed-password", *extra, url=cdmss.owner_url, tag=tag)[0]


@pytest.fixture
def nologin_role(cdmss):
    cdmss.su_exec(f"ALTER ROLE {ROLE} NOLOGIN")
    cdmss.su_exec(f"ALTER ROLE {ROLE} PASSWORD NULL")
    mark = cdmss.log.stat().st_size
    yield cdmss, mark
    cdmss.su_exec(f"ALTER ROLE {ROLE} NOLOGIN")
    cdmss.su_exec(f"ALTER ROLE {ROLE} PASSWORD NULL")


def test_a_seeded_role_cannot_log_in_while_it_is_nologin_even_with_the_right_password(nologin_role, tmp_path):
    from tests.neon_harness import seeded_tokens
    cdmss, mark = nologin_role
    r = seed(cdmss, tmp_path)
    assert r.returncode == 0, r.stderr
    assert cdmss.su_exec(f"SELECT rolpassword IS NOT NULL, rolcanlogin FROM pg_authid WHERE rolname='{ROLE}'") == [(True, False)]
    (tok,) = seeded_tokens(cdmss.log, ROLE, since=mark)
    assert len(tok) >= 43                                              # 48 random bytes, urlsafe base64
    err = attempt(cdmss, tok)
    assert err is not None and ("not permitted to log in" in err or "authentication failed" in err), err   # the CORRECT password, NOLOGIN role
    assert tok not in r.stdout + r.stderr                               # nothing of ours prints it
    # why the order matters: had LOGIN come before the Neon reset replaced this password, it WOULD work
    cdmss.su_exec(f"ALTER ROLE {ROLE} LOGIN")
    assert attempt(cdmss, tok) is None


def test_every_seed_is_a_fresh_random_value(nologin_role, tmp_path):
    from tests.neon_harness import seeded_tokens
    cdmss, mark = nologin_role
    for i in range(3):
        assert seed(cdmss, tmp_path, tag=f"seed{i}").returncode == 0
    toks = seeded_tokens(cdmss.log, ROLE, since=mark)
    assert len(toks) == 3 and len(set(toks)) == 3 and all(len(t) >= 43 for t in toks)


def test_the_seed_refuses_a_login_role_a_member_and_roles_it_is_not_for(nologin_role, tmp_path):
    from tests.neon_harness import seeded_tokens
    cdmss, mark = nologin_role
    cdmss.su_exec(f"ALTER ROLE {ROLE} LOGIN")
    r = seed(cdmss, tmp_path, tag="login")
    assert r.returncode == 1 and "FAILED" in r.stderr and "must exist and be NOLOGIN" in r.stderr
    cdmss.su_exec(f"ALTER ROLE {ROLE} NOLOGIN")
    cdmss.su_exec(f"GRANT pg_read_all_data TO {ROLE}")
    try:
        r = seed(cdmss, tmp_path, tag="member")
        assert r.returncode == 1 and "member of another role" in r.stderr
    finally:
        cdmss.su_exec(f"REVOKE pg_read_all_data FROM {ROLE}")
    for role in ("studio_gov_ro", "studio_app", "neondb_owner"):
        r = seed(cdmss, tmp_path, tag=role, role=role)
        assert r.returncode == 2, role
    assert seeded_tokens(cdmss.log, ROLE, since=mark) == []          # not one of the refusals set a password
    assert cdmss.su_exec(f"SELECT rolpassword IS NULL FROM pg_authid WHERE rolname='{ROLE}'") == [(True,)]


def test_the_seed_is_exclusive_with_login_and_nologin_and_dry_run_prints_no_password(nologin_role, tmp_path):
    import subprocess
    from tests.neon_harness import RUN_ROLES
    cdmss, mark = nologin_role
    assert seed(cdmss, tmp_path, tag="x1", extra=("--login",)).returncode == 2
    d = subprocess.run(["bash", str(RUN_ROLES), "--role", ROLE, "--seed-password", "--dry-run"], capture_output=True, text=True)
    assert d.returncode == 0 and "THROWAWAY" in d.stdout and "PASSWORD '" not in d.stdout
    from tests.neon_harness import seeded_tokens
    assert seeded_tokens(cdmss.log, ROLE, since=mark) == []


def test_the_seed_code_has_no_password_on_any_command_line_or_in_any_file():
    import re
    from tests.neon_harness import RUN_ROLES
    t = RUN_ROLES.read_text()
    block = t[t.index("if [[ $seed -eq 1 ]]; then\n  seed_err"):t.index("psql_run() {")]
    assert "secrets.token_urlsafe(48)" in block and "-f -" in block and "ROLE_NAME=$role python3" in block
    assert not re.search(r"PGPASSWORD|--password|-W\b|echo .*tok|printf .*tok|> *\"?\$tmp/seed\.sql", block)
    assert "tok" not in block.split("seed_py=")[0] and "$tok" not in block
