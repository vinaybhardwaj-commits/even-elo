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
