"""neon-role.sh: the HTTP status and the API's error message are logged (filtered) on a non-2xx, `role-auth` reports the API's
authentication_method, and a NOLOGIN role gets HTTP 422 from reset_password while a LOGIN role gets 200 (live Neon, 22 Oct)."""

import shutil

import pytest

from tests.neon_harness import API_KEY, BRANCH, NEON_ROLE, PROJECT, MockNeon, NeonRun, assert_nowhere, cluster, keyfile  # noqa: F401  (fixtures)

pytestmark = pytest.mark.skipif(not NEON_ROLE.exists() or shutil.which("jq") is None or shutil.which("curl") is None, reason="needs jq and curl")
ROLE = "studio_login_probe"


@pytest.fixture
def mock(cluster):
    cluster.su_exec(f"CREATE ROLE {ROLE} NOLOGIN")
    m = MockNeon(cluster)
    m.reject_reset_for_nologin = True
    yield m
    m.stop()
    cluster.su_exec(f"DROP ROLE {ROLE}")


def reset(nr, keyfile, tmp_path, name="out"):
    out = tmp_path / name
    return nr.run("reset-password", str(keyfile), PROJECT, BRANCH, ROLE, str(out)), out


def test_role_auth_reports_the_api_method_and_exit_4_when_not_visible(tmp_path, mock, keyfile):
    nr = NeonRun(tmp_path, mock.url, "auth")
    mock.visible_extra = {ROLE}
    r = nr.run("role-auth", str(keyfile), PROJECT, BRANCH, ROLE)
    assert r.returncode == 0 and r.stdout.strip() == "no_login", (r.stdout, r.stderr)
    mock.cluster.su_exec(f"ALTER ROLE {ROLE} LOGIN")
    assert nr.run("role-auth", str(keyfile), PROJECT, BRANCH, ROLE).stdout.strip() == "no_password"
    mock.passworded.add(ROLE)
    assert nr.run("role-auth", str(keyfile), PROJECT, BRANCH, ROLE).stdout.strip() == "scram-sha-256"
    mock.hidden.add(ROLE)
    r = nr.run("role-auth", str(keyfile), PROJECT, BRANCH, ROLE)
    assert r.returncode == 4 and "not visible" in r.stderr and r.stdout.strip() == ""
    assert_nowhere(nr, r, API_KEY)


def test_422_on_a_nologin_role_is_logged_with_status_and_message_and_keeps_the_failure_exit(tmp_path, mock, keyfile):
    nr = NeonRun(tmp_path, mock.url, "r422")
    mock.visible_extra = {ROLE}
    r, out = reset(nr, keyfile, tmp_path)
    assert r.returncode != 0 and not out.exists() and mock.issued == {}
    assert f"POST /projects/{PROJECT}/branches/{BRANCH}/roles/{ROLE}/reset_pw -> HTTP 422: role has no login privilege" in r.stderr
    assert not list(nr.scratch.iterdir())
    assert_nowhere(nr, r, API_KEY)


def test_once_the_role_is_login_the_same_call_succeeds(tmp_path, mock, keyfile):
    nr = NeonRun(tmp_path, mock.url, "ok")
    mock.visible_extra = {ROLE}
    mock.cluster.su_exec(f"ALTER ROLE {ROLE} LOGIN")
    r, out = reset(nr, keyfile, tmp_path)
    assert r.returncode == 0, r.stderr
    assert out.read_text() == mock.issued[ROLE] + "\n"
    assert_nowhere(nr, r, mock.issued[ROLE], API_KEY)


@pytest.mark.parametrize("message", [
    "postgres://leak:SECRETPW@h/db rejected", "the password SECRETPW was wrong", "Bearer abcdef0123", "token SECRETTOKEN expired", "secret SECRETX",
])
def test_the_error_message_is_logged_without_secrets(tmp_path, mock, keyfile, message):
    nr = NeonRun(tmp_path, mock.url, "leak")
    mock.visible_extra = {ROLE}
    mock.reset_422_message = message
    r, out = reset(nr, keyfile, tmp_path)
    assert r.returncode != 0 and "HTTP 422" in r.stderr and "message withheld" in r.stderr
    for leak in ("SECRETPW", "SECRETTOKEN", "SECRETX", "postgres://", "abcdef0123", "Bearer", "password"):
        assert leak not in r.stderr + r.stdout, leak
    assert_nowhere(nr, r, API_KEY)


def test_a_non_json_or_empty_error_body_still_exits_nonzero_with_the_status(tmp_path, mock, keyfile):
    nr = NeonRun(tmp_path, mock.url, "empty")
    mock.visible_extra = {ROLE}
    mock.reset_422_message = ""
    r, out = reset(nr, keyfile, tmp_path)
    assert r.returncode != 0 and "HTTP 422" in r.stderr and not out.exists()


def test_the_readmes_document_the_new_order_and_keep_the_rotation_sections():
    from pathlib import Path
    ops = NEON_ROLE.parent
    neon = (ops / "README.md").read_text()
    cdmss = (ops.parent / "cdmss" / "README.md").read_text()
    assert neon.index("# 2. enable LOGIN FIRST") < neon.index("# 3. Neon issues the password") < neon.index("# 3b. re-check")
    assert "## Rotation (the role is already LOGIN)" in neon and "run-roles.sh --nologin" in neon.split("## Rotation")[1]
    assert "HTTP 422" in neon and "no_login" in neon and "exit 6" in neon.split("studio_dw_writer")[-1]
    assert "HTTP 422" in cdmss and "no_login" in cdmss and "exits 6" in cdmss and "Rotation (password lost" in cdmss
    for sh in (ops.parent / "cdmss" / "run-login-mini.sh", ops / "run-dw-writer-login-mini.sh"):
        t = sh.read_text()
        assert t.index('role-auth "$NEON_KEY"') < t.index('--login "$MOUNT/owner-url"') < t.index('reset-password "$NEON_KEY"'), sh.name
