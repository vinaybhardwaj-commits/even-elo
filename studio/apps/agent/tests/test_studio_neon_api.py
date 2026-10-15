"""ops/neon/neon-role.sh (discover, reset-password) against a LOCAL mock of the Neon API v2. Never touches Neon."""

import shutil
import stat
import subprocess
from urllib.parse import quote

import pytest

from tests.neon_harness import (
    API_KEY, BRANCH, NEON_ROLE, PROJECT, MockNeon, NeonRun, assert_nowhere, cluster, keyfile, neon, owner_file, run_roles,
)  # noqa: F401  (fixtures)

pytestmark = pytest.mark.skipif(not NEON_ROLE.exists() or shutil.which("jq") is None or shutil.which("curl") is None, reason="needs jq and curl")


@pytest.fixture
def plain_neon():
    """The mock without a database behind it (static role list)."""
    m = MockNeon(None)
    yield m
    m.stop()


def test_discover_lists_ids_and_role_names_only(tmp_path, neon, keyfile, cluster):
    run_roles(cluster, tmp_path)  # so the SQL-created role exists and is listed
    nr = NeonRun(tmp_path, neon.url, "disc")
    r = nr.run("discover", str(keyfile))
    assert r.returncode == 0, r.stderr
    assert f"project {PROJECT}" in r.stdout and f"branch {BRANCH}" in r.stdout and "studio_gov_ro" in r.stdout
    for hidden in ("SECRET", "LISTED-PW", "x@y", "aws-ap-south-1", "connection_uri"):
        assert hidden not in r.stdout + r.stderr
    assert_nowhere(nr, r, API_KEY)


def test_create_subcommand_is_gone(tmp_path, plain_neon, keyfile):
    nr = NeonRun(tmp_path, plain_neon.url, "nocreate")
    out = tmp_path / "o"
    r = nr.run("create", str(keyfile), PROJECT, BRANCH, "studio_gov_ro", str(out))
    assert r.returncode == 2 and "usage" in r.stderr and not out.exists() and plain_neon.requests == []


def test_reset_password_writes_only_the_issued_password_to_a_0600_file(tmp_path, neon, keyfile, cluster):
    run_roles(cluster, tmp_path)
    nr = NeonRun(tmp_path, neon.url, "pw")
    out = tmp_path / "pw-out"
    r = nr.run("reset-password", str(keyfile), PROJECT, BRANCH, "studio_gov_ro", str(out))
    assert r.returncode == 0, r.stderr
    pw = neon.issued["studio_gov_ro"]
    assert out.read_text() == pw + "\n" and stat.S_IMODE(out.stat().st_mode) == 0o600
    assert [(m, p, a) for m, p, a, _ in neon.requests[-2:]] == [
        ("GET", f"/api/v2/projects/{PROJECT}/branches/{BRANCH}/roles", f"Bearer {API_KEY}"),
        ("POST", f"/api/v2/projects/{PROJECT}/branches/{BRANCH}/roles/studio_gov_ro/reset_password", f"Bearer {API_KEY}"),
    ]
    assert not list(nr.scratch.iterdir())
    assert_nowhere(nr, r, pw, API_KEY)


def test_reset_password_dsn_uses_the_owner_host_and_encodes_the_password(tmp_path, neon, keyfile, cluster):
    run_roles(cluster, tmp_path)
    nr = NeonRun(tmp_path, neon.url, "dsn")
    owner = owner_file(tmp_path, "postgresql://neondb_owner:OWNERPW@ep-cool-1234.ap-south-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require")
    out = tmp_path / "dsn-out"
    r = nr.run("reset-password", str(keyfile), PROJECT, BRANCH, "studio_gov_ro", str(out), "--dsn-from", str(owner))
    assert r.returncode == 0, r.stderr
    pw = neon.issued["studio_gov_ro"]
    assert out.read_text().strip() == f"postgresql://studio_gov_ro:{quote(pw, safe='')}@ep-cool-1234.ap-south-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
    assert "OWNERPW" not in out.read_text() and stat.S_IMODE(out.stat().st_mode) == 0o600
    assert_nowhere(nr, r, pw, quote(pw, safe=""), API_KEY, "OWNERPW")


def test_a_role_the_api_cannot_see_exits_4_makes_no_reset_call_and_leaves_no_output(tmp_path, neon, keyfile, cluster):
    nr = NeonRun(tmp_path, neon.url, "invisible")
    out = tmp_path / "o"
    for role in ("studio_gov_ro", "no_such_role"):  # SQL-created but unseen, and plainly absent
        neon.hidden.add(role)
        r = nr.run("reset-password", str(keyfile), PROJECT, BRANCH, role, str(out))
        assert r.returncode == 4 and "role not visible to Neon API" in r.stderr, role
        assert not out.exists() and neon.posts == [] and not list(nr.scratch.iterdir())
        assert API_KEY not in r.stdout + r.stderr


@pytest.mark.parametrize(
    "base",
    [
        "http://127.0.0.1.evil.test/api/v2",
        "http://127.0.0.1@evil.test/api/v2",
        "http://localhost.evil.test/api/v2",
        "http://localhost:80@evil.test/api/v2",
        "http://127.0.0.1:80@evil.test/api/v2",
        "http://localhost@evil.test/api/v2",
        "http://127.0.0.10/api/v2",
        "http://localhostx/api/v2",
        "http://example.com/api/v2",
        "http://127.0.0.1#@evil.test/api/v2",
        "http://127.0.0.1?x=@evil.test",
        "https://user:pw@console.neon.tech/api/v2",
        "https://console.neon.tech@evil.test/api/v2",
        "https://evil.test:443@console.neon.tech/api/v2",
        "https://console.neon.tech /api/v2",
        "ftp://console.neon.tech/api/v2",
        "javascript:alert(1)",
        "",
    ],
)
def test_api_base_url_is_parsed_strictly_and_no_request_is_ever_made(tmp_path, plain_neon, keyfile, base):
    nr = NeonRun(tmp_path, plain_neon.url, "url")
    r = nr.run("discover", str(keyfile), env={"NEON_API_BASE": base or "x"})
    assert r.returncode == 2 and "NEON_API_BASE" in r.stderr
    assert plain_neon.requests == [] and API_KEY not in r.stdout + r.stderr
    log = nr.log.read_text() if nr.log.exists() else ""
    assert "ARGV" not in log  # curl was never invoked


def test_accepted_base_urls(tmp_path, plain_neon, keyfile):
    nr = NeonRun(tmp_path, plain_neon.url, "okurl")
    assert nr.run("discover", str(keyfile)).returncode == 0  # http://127.0.0.1:PORT/api/v2
    assert nr.run("discover", str(keyfile), env={"NEON_API_BASE": plain_neon.url.replace("127.0.0.1", "localhost")}).returncode == 0


def test_refusals_and_failures_leave_nothing_behind(tmp_path, plain_neon, keyfile):
    nr = NeonRun(tmp_path, plain_neon.url, "bad")
    out = tmp_path / "out"
    out.write_text("existing")
    r = nr.run("reset-password", str(keyfile), PROJECT, BRANCH, "studio_gov_ro", str(out))
    assert r.returncode == 2 and "refusing to overwrite" in r.stderr and out.read_text() == "existing" and plain_neon.requests == []
    new = tmp_path / "new"
    for args, needle in [
        (("reset-password", str(keyfile), "proj;rm", BRANCH, "r", str(new)), "invalid project"),
        (("reset-password", str(keyfile), PROJECT, BRANCH, "Bad-Role", str(new)), "invalid role"),
        (("reset-password", str(keyfile), PROJECT, BRANCH, "r", str(new), "--dsn-from", str(tmp_path / "nope")), "owner url file"),
        (("reset-password", str(tmp_path / "nokey"), PROJECT, BRANCH, "r", str(new)), "API key file"),
    ]:
        r = nr.run(*args)
        assert r.returncode == 2 and needle in r.stderr and not new.exists(), args
    loose = tmp_path / "loose-key"
    loose.write_text(API_KEY)
    loose.chmod(0o644)
    r = nr.run("discover", str(loose))
    assert r.returncode == 2 and "mode 600" in r.stderr and API_KEY not in r.stdout + r.stderr
    wrong = tmp_path / "wrong-key"
    wrong.write_text("some-other-key\n")
    wrong.chmod(0o600)
    r = nr.run("reset-password", str(wrong), PROJECT, BRANCH, "studio_gov_ro", str(new))
    assert r.returncode != 0 and not new.exists() and not list(nr.scratch.iterdir())


def test_disk_backed_temp_is_refused_unless_allowed(tmp_path, neon, keyfile, cluster):
    run_roles(cluster, tmp_path)
    nr = NeonRun(tmp_path, neon.url, "disk")
    env = {"XDG_RUNTIME_DIR": "", "STUDIO_ROLES_SHM": str(tmp_path / "no-shm"), "TMPDIR": str(tmp_path)}
    out = tmp_path / "o1"
    r = nr.run("reset-password", str(keyfile), PROJECT, BRANCH, "studio_gov_ro", str(out), env=env)
    assert r.returncode == 2 and "tmpfs" in r.stderr and not out.exists() and neon.requests == []
    r = nr.run("--allow-disk-tmp", "reset-password", str(keyfile), PROJECT, BRANCH, "studio_gov_ro", str(out), env=env)
    assert r.returncode == 0 and out.exists() and not list(tmp_path.glob("neon-role.*"))
