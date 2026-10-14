"""R15: rotation containment. Same emulated Neon harness (non-superuser owner, neon_superuser, mock API that can
add neon_superuser on reset), role polled for LOGIN throughout. Never touches Neon."""

import os
import signal
import stat
import subprocess
import threading
import time

import psycopg
import pytest

from tests.neon_harness import (
    API_KEY, BRANCH, NEON_ROLE, OPS, PROJECT, RUN_ROLES, NeonRun, assert_nowhere, cluster, full_flow, keyfile,
    memberships, neon, owner_file, role_row, run_roles,
)  # noqa: F401  (fixtures)

pytestmark = pytest.mark.skipif(not OPS.exists(), reason="ops/neon not available")


class LoginPoller:
    """Samples (rolcanlogin, member-of-anything) for a role; records every moment it was LOGIN-able AND a member."""

    def __init__(self, cluster, role="studio_gov_ro"):
        self.cluster, self.role, self.stop, self.samples = cluster, role, threading.Event(), []
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        with psycopg.connect(self.cluster.su, autocommit=True) as c:
            while not self.stop.is_set():
                row = c.execute(
                    "SELECT r.rolcanlogin, EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) FROM pg_roles r WHERE r.rolname = %s",
                    (self.role,),
                ).fetchone()
                if row:
                    self.samples.append(row)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *a):
        self.stop.set()
        self.thread.join(3)

    @property
    def ever_login(self):
        return any(s[0] for s in self.samples)

    @property
    def ever_login_and_member(self):
        return any(s[0] and s[1] for s in self.samples)


def provision(cluster, neon, keyfile, tmp_path):
    """First-time provisioning to a LOGIN-enabled role (mock does not add neon_superuser)."""
    s, r, nr, out = full_flow(cluster, neon, tmp_path, keyfile, tag="first")
    assert s.returncode == 0 and r.returncode == 0
    l, _ = run_roles(cluster, tmp_path, "--login", tag="first-login")
    assert l.returncode == 0, l.stderr
    assert role_row(cluster, "studio_gov_ro")[0] is True
    return out


def reset(cluster, neon, keyfile, tmp_path, tag):
    nr = NeonRun(tmp_path, neon.url, tag)
    out = tmp_path / f"dsn-{tag}"
    of = owner_file(tmp_path, cluster.owner_url, f"{tag}-owner")
    return nr, out, nr.run("reset-password", str(keyfile), PROJECT, BRANCH, "studio_gov_ro", str(out), "--dsn-from", str(of))


def test_runbook_rotation_with_a_membership_adding_api_is_never_loginable(cluster, neon, keyfile, tmp_path):
    provision(cluster, neon, keyfile, tmp_path)
    neon.add_superuser_on_reset = True  # the open question (b): the API adds neon_superuser on reset
    with LoginPoller(cluster) as poller:
        n, _ = run_roles(cluster, tmp_path, "--nologin", tag="rot0")  # rotation step 0
        assert n.returncode == 0, n.stderr
        poller.samples.clear()  # from here on the role must stay NOLOGIN at every sample
        nr, out, r = reset(cluster, neon, keyfile, tmp_path, "rot")
        assert r.returncode == 0, r.stderr
        l, _ = run_roles(cluster, tmp_path, "--login", tag="rot3")
    assert poller.samples, "poller never sampled"
    assert not poller.ever_login  # NOLOGIN at every polled moment, member or not
    assert l.returncode != 0 and "member of another role" in l.stderr and "NOLOGIN (contained)" in l.stderr
    assert role_row(cluster, "studio_gov_ro")[0] is False and memberships(cluster, "studio_gov_ro") == ["neon_superuser"]
    assert_nowhere(nr, r, neon.issued["studio_gov_ro"], API_KEY, extra=[("login stderr", l.stderr)])


def test_without_step_zero_the_naive_rotation_is_exposed_but_a_failed_login_still_contains(cluster, neon, keyfile, tmp_path):
    """Documents the hazard the runbook's step 0 removes, and shows the automatic containment."""
    provision(cluster, neon, keyfile, tmp_path)
    neon.add_superuser_on_reset = True
    with LoginPoller(cluster) as poller:
        nr, out, r = reset(cluster, neon, keyfile, tmp_path, "naive")  # role still LOGIN
        assert r.returncode == 0
        time.sleep(0.05)
    assert poller.ever_login_and_member  # LOGIN + neon_superuser between the reset and --login: the exposure
    l, _ = run_roles(cluster, tmp_path, "--login", tag="naive-login")
    assert l.returncode != 0 and "contained" in l.stderr
    assert role_row(cluster, "studio_gov_ro")[0] is False  # --login failure alone now contains it


def test_a_failed_login_leaves_nologin_for_every_failure_cause(cluster, tmp_path):
    # (a) member of another role while LOGIN
    assert run_roles(cluster, tmp_path, tag="s")[0].returncode == 0
    cluster.owner_exec("ALTER ROLE studio_gov_ro LOGIN")
    cluster.su_exec("GRANT pg_monitor TO studio_gov_ro")
    r, _ = run_roles(cluster, tmp_path, "--login", tag="a")
    assert r.returncode != 0 and role_row(cluster, "studio_gov_ro")[0] is False and "contained" in r.stderr
    cluster.su_exec("REVOKE pg_monitor FROM studio_gov_ro")
    # (b) lacks its grants while LOGIN
    cluster.owner_exec("ALTER ROLE studio_gov_ro LOGIN")
    cluster.owner_exec("REVOKE SELECT ON physicians FROM studio_gov_ro")
    r, _ = run_roles(cluster, tmp_path, "--login", tag="b")
    assert r.returncode != 0 and "lacks its grants" in r.stderr and role_row(cluster, "studio_gov_ro")[0] is False
    # (c) the role does not exist: containment cannot apply, the failure is still reported and nothing is created
    cluster.su_exec("DROP OWNED BY studio_gov_ro", db="neondb")
    cluster.su_exec("DROP ROLE studio_gov_ro")
    r, _ = run_roles(cluster, tmp_path, "--login", tag="c")
    assert r.returncode != 0 and "does not exist" in r.stderr and role_row(cluster, "studio_gov_ro") is None
    # (d) success path is unchanged
    assert run_roles(cluster, tmp_path, tag="d1")[0].returncode == 0
    r, _ = run_roles(cluster, tmp_path, "--login", tag="d2")
    assert r.returncode == 0 and role_row(cluster, "studio_gov_ro")[0] is True


def test_nologin_subcommand(cluster, tmp_path):
    assert run_roles(cluster, tmp_path, tag="s")[0].returncode == 0
    cluster.owner_exec("ALTER ROLE studio_gov_ro LOGIN")
    for tag in ("n1", "n2"):  # idempotent
        r, scratch = run_roles(cluster, tmp_path, "--nologin", tag=tag)
        assert r.returncode == 0 and "NOLOGIN" in r.stdout and not list(scratch.iterdir())
        assert role_row(cluster, "studio_gov_ro")[0] is False
    # studio_app too, and it is its own committed statement (no BEGIN around it in the server log)
    assert run_roles(cluster, tmp_path, "--role", "studio_app", url=cluster.studio_owner_url, tag="app")[0].returncode == 0
    cluster.owner_exec("ALTER ROLE studio_app LOGIN", db="studiodb")
    mark = cluster.log_mark()
    r, _ = run_roles(cluster, tmp_path, "--nologin", "--role", "studio_app", url=cluster.studio_owner_url, tag="app2")
    assert r.returncode == 0 and role_row(cluster, "studio_app")[0] is False
    log = cluster.log_since(mark)
    assert 'ALTER ROLE "studio_app" NOLOGIN' in log or "ALTER ROLE studio_app NOLOGIN" in log and "BEGIN" not in log
    r, _ = run_roles(cluster, tmp_path, "--login", "--nologin", tag="x")
    assert r.returncode == 2 and "exclusive" in r.stderr
    d = subprocess.run(["bash", str(RUN_ROLES), "--dry-run", "--nologin"], capture_output=True, text=True, env={"PATH": os.environ["PATH"]})
    assert d.returncode == 0 and 'NOLOGIN' in d.stdout


def _start_reset(cluster, neon, keyfile, tmp_path, tag, delay):
    neon.reset_delay = delay
    nr = NeonRun(tmp_path, neon.url, tag)
    out = tmp_path / f"dsn-{tag}"
    of = owner_file(tmp_path, cluster.owner_url, f"{tag}-owner")
    proc = subprocess.Popen(
        ["bash", str(NEON_ROLE), "reset-password", str(keyfile), PROJECT, BRANCH, "studio_gov_ro", str(out), "--dsn-from", str(of)],
        env=nr.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True,
    )
    for _ in range(200):  # wait until the reset reached the server (rotation happened) and curl is waiting
        if "studio_gov_ro" in neon.issued:
            break
        time.sleep(0.02)
    assert "studio_gov_ro" in neon.issued and out.exists()
    return nr, out, proc


def test_kill_minus_9_mid_reset_documented_recovery(cluster, neon, keyfile, tmp_path):
    assert run_roles(cluster, tmp_path, tag="s")[0].returncode == 0
    nr, out, proc = _start_reset(cluster, neon, keyfile, tmp_path, "k9", delay=3.0)
    first_pw = neon.issued["studio_gov_ro"]
    os.killpg(proc.pid, signal.SIGKILL)  # no trap can run
    proc.communicate()
    # The documented leftovers: an EMPTY 0600 OUT (password rotated server-side, lost) and the curl config with the key.
    assert out.exists() and out.stat().st_size == 0 and stat.S_IMODE(out.stat().st_mode) == 0o600
    left = [f for f in nr.scratch.rglob("*") if f.is_file()]
    assert any(f.name == "curl.cfg" for f in left)
    # A rerun refuses to overwrite the stale OUT (so it cannot silently keep an empty file) ...
    neon.reset_delay = 0
    r = subprocess.run(["bash", str(NEON_ROLE), "reset-password", str(keyfile), PROJECT, BRANCH, "studio_gov_ro", str(out)], capture_output=True, text=True, env=nr.env)
    assert r.returncode == 2 and "refusing to overwrite" in r.stderr
    # ... recovery per the README: delete OUT, shred the leftovers, reset again.
    out.unlink()
    for f in left:
        subprocess.run(["shred", "-u", str(f)], check=True)
    for d in list(nr.scratch.glob("neon-role.*")):
        d.rmdir()
    nr2, out2, r2 = reset(cluster, neon, keyfile, tmp_path, "k9b")
    assert r2.returncode == 0, r2.stderr
    assert neon.issued["studio_gov_ro"] != first_pw and out2.read_text().count(neon.issued["studio_gov_ro"].replace("/", "%2F").replace("+", "%2B").replace("@", "%40")) == 1
    assert run_roles(cluster, tmp_path, "--login", tag="k9login")[0].returncode == 0
    assert_nowhere(nr2, r2, neon.issued["studio_gov_ro"], API_KEY)


@pytest.mark.parametrize("sig", [signal.SIGTERM, signal.SIGINT, signal.SIGHUP])
def test_catchable_signals_mid_reset_remove_the_output_and_the_curl_config(cluster, neon, keyfile, tmp_path, sig):
    assert run_roles(cluster, tmp_path, tag="s")[0].returncode == 0
    nr, out, proc = _start_reset(cluster, neon, keyfile, tmp_path, f"sig{int(sig)}", delay=3.0)
    os.killpg(proc.pid, sig)  # curl and bash both get it; bash's trap runs
    o, e = proc.communicate(timeout=10)
    assert proc.returncode != 0
    assert not out.exists()  # no empty or partial OUT left behind
    assert not list(nr.scratch.iterdir())  # curl.cfg (API key) and the temp dir are gone
    assert API_KEY not in o + e


def test_a_failed_reset_after_the_call_removes_the_output(cluster, neon, keyfile, tmp_path):
    assert run_roles(cluster, tmp_path, tag="s")[0].returncode == 0
    nr = NeonRun(tmp_path, neon.url, "bad401")
    wrong = tmp_path / "wrong-key"
    wrong.write_text("another-key\n")
    wrong.chmod(0o600)
    out = tmp_path / "o"
    r = nr.run("reset-password", str(wrong), PROJECT, BRANCH, "studio_gov_ro", str(out))
    assert r.returncode != 0 and not out.exists() and not list(nr.scratch.iterdir())


def test_readme_rotation_section_and_recovery_text():
    text = (OPS / "README.md").read_text()
    assert "## Rotation" in text
    rot = text.split("## Rotation", 1)[1].split("\n## ", 1)[0]
    assert rot.index("--nologin") < rot.index("reset-password") < rot.index("--login")
    low = rot.lower()
    assert "if the out file is empty" in low and "delete the empty out" in low and "reset again" in low
    assert "Rotate later with step 2 + 3" not in text
