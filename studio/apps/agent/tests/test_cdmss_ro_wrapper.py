"""ops/cdmss/run-cdmss-ro.sh against the scratch cluster (owner = non-superuser). Never touches a real database."""

import os
import shutil
import subprocess

import psycopg
import pytest

from tests.cdmss_harness import OPS, RUN_WRAPPER, SQL_VIEWS, cdmss, needs_env  # noqa: F401  (fixture)

pytestmark = needs_env


def url_file(tmp_path, url, tag="owner"):
    f = tmp_path / f"{tag}-url"
    f.write_text(url + "\n")
    f.chmod(0o600)
    return f


def run(cdmss, args, env_extra=None):
    env = {**os.environ, "PSQL": cdmss.psql}
    env.update(env_extra or {})
    return subprocess.run(["bash", str(RUN_WRAPPER), *args], capture_output=True, text=True, env=env, timeout=120)


def view_count(cdmss):
    return cdmss.su_exec("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='cdmss_ro' AND c.relkind='v'")[0][0]


def test_dry_run_connects_to_nothing_and_prints_the_sql(cdmss):
    p = run(cdmss, ["--dry-run"], {"PGSERVICEFILE": "/nonexistent"})
    assert p.returncode == 0 and "CREATE ROLE studio_cdmss_ro NOLOGIN" in p.stdout and "CREATE VIEW cdmss_ro.opd_note_audit" in p.stdout
    assert "COLUMN ALLOWLIST" in p.stdout


def test_owner_run_is_idempotent_and_leaves_the_role_nologin(cdmss, tmp_path):
    f = url_file(tmp_path, cdmss.owner_url)
    for _ in range(2):
        p = run(cdmss, [str(f)])
        assert p.returncode == 0, p.stderr
        assert "post-check passed" in p.stdout and "no password" in p.stdout
    assert view_count(cdmss) == 17
    assert cdmss.su_exec("SELECT rolcanlogin FROM pg_roles WHERE rolname='studio_cdmss_ro'") == [(False,)]
    p = run(cdmss, ["--check", str(f)])
    assert p.returncode == 0 and "nothing changed" in p.stdout


def test_refuses_a_superuser(cdmss, tmp_path):
    f = url_file(tmp_path, cdmss.su_cdmss, "su")
    p = run(cdmss, [str(f)])
    assert p.returncode == 3 and "superuser" in p.stderr
    assert view_count(cdmss) == 17  # nothing was touched


def test_missing_owner_file_and_secret_never_on_argv(cdmss, tmp_path):
    assert run(cdmss, [str(tmp_path / "nope")]).returncode == 2
    assert run(cdmss, []).returncode == 2


def test_a_failed_postcheck_rolls_the_whole_run_back(cdmss, tmp_path):
    """A view that leaks a PHI column (not in the allowlist, in the denylist) makes 0003 fail: nothing from the run survives."""
    d = tmp_path / "sql"
    d.mkdir()
    for f in OPS.glob("0*.sql"):
        shutil.copy(f, d / f.name)
    views = (d / SQL_VIEWS.name).read_text()
    marker = "-- GRANTS: USAGE on the schema"
    leak = "CREATE VIEW cdmss_ro.leak WITH (security_barrier = true) AS SELECT o.uhid FROM public.ot_note_audits o;\n"
    (d / SQL_VIEWS.name).write_text(views.replace(marker, leak + marker, 1))
    f = url_file(tmp_path, cdmss.owner_url)
    p = run(cdmss, [str(f)], {"CDMSS_RO_SQL_DIR": str(d)})
    assert p.returncode != 0 and "postcheck" in p.stderr
    names = {r[0] for r in cdmss.su_exec("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='cdmss_ro'")}
    assert "leak" not in names and view_count(cdmss) == 17  # rolled back; the earlier good views are intact
    # and the shipped files still pass afterwards
    assert run(cdmss, ["--check", str(f)]).returncode == 0


def test_postcheck_catches_a_base_table_grant(cdmss, tmp_path):
    f = url_file(tmp_path, cdmss.owner_url)
    with psycopg.connect(cdmss.owner_url, autocommit=True) as c:
        c.execute("GRANT SELECT (uid) ON public.opd_note_audits TO studio_cdmss_ro")
    try:
        p = run(cdmss, ["--check", str(f)])
        assert p.returncode != 0 and "privilege on a base relation" in p.stderr
    finally:
        with psycopg.connect(cdmss.owner_url, autocommit=True) as c:
            c.execute("REVOKE ALL ON public.opd_note_audits FROM studio_cdmss_ro")
    assert run(cdmss, ["--check", str(f)]).returncode == 0
