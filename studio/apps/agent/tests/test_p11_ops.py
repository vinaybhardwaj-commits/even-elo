"""Phase 1.1 ops: 0013 (DW indexes) over a scratch cluster with 0001..0012 applied, and the relay pool 2 -> 4 render diff. Never touches Neon."""
import difflib
import re
import subprocess

import pytest

from tests.neon_harness import cluster, run_roles, REPO  # noqa: F401  (fixtures)
from tests.test_probe_0012 import SQL_DW, probe  # noqa: F401
from tests.test_studio_views import world  # noqa: F401  (0001, 0003, 0007..0011 applied, role usable)

OPS_NEON = REPO / "ops" / "neon"
SQL_IDX = OPS_NEON / "0013_studio_dw_indexes.sql"
INDEXES = ["individuals_prescriptions_uid_idx", "individuals_prescriptions_timestamp_idx", "extract_runs_started_at_idx", "extract_run_tables_name_started_idx"]


def indexes(cluster):
    rows = cluster.su_exec("SELECT indexname FROM pg_indexes WHERE schemaname = 'studio_dw' ORDER BY indexname", db="neondb")
    return {r[0] for r in rows}


def test_0013_creates_the_indexes_keeps_the_probe_green_and_is_idempotent(world, tmp_path):
    cluster, _, url = world
    assert run_roles(cluster, tmp_path, sql_file=SQL_DW, tag="dw")[0].returncode == 0
    before = indexes(cluster)
    assert not set(INDEXES) & before
    r, _ = run_roles(cluster, tmp_path, sql_file=SQL_IDX, tag="idx")
    assert r.returncode == 0, r.stderr
    after = indexes(cluster)
    assert set(INDEXES) <= after
    assert "individuals_prescriptions_pkey" in after and "doctors_pkey" in after  # keys untouched; doctors(uid) is its PK, no duplicate index
    # a second run changes nothing (IF NOT EXISTS, same names)
    r2, _ = run_roles(cluster, tmp_path, sql_file=SQL_IDX, tag="idx2")
    assert r2.returncode == 0, r2.stderr
    assert indexes(cluster) == after
    # the live probe is unchanged: studio_gov_ro still reads only the studio_ro views and nothing in studio_dw
    p = probe(url)
    assert "failed" not in p.stdout and "skipped" not in p.stdout and " passed" in p.stdout, p.stdout[-2000:]


def test_0013_refuses_to_run_before_0012_and_adds_no_grant(world, tmp_path):
    cluster, _, url = world
    r, _ = run_roles(cluster, tmp_path, sql_file=SQL_IDX, tag="idx-early")
    assert r.returncode != 0 and "0012_studio_dw.sql first" in r.stderr
    assert run_roles(cluster, tmp_path, sql_file=SQL_DW, tag="dw")[0].returncode == 0
    acl_before = cluster.su_exec("SELECT c.relname, coalesce(c.relacl::text,'') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('studio_dw','studio_ro') AND c.relkind IN ('r','v') ORDER BY 1", db="neondb")
    assert run_roles(cluster, tmp_path, sql_file=SQL_IDX, tag="idx")[0].returncode == 0
    acl_after = cluster.su_exec("SELECT c.relname, coalesce(c.relacl::text,'') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('studio_dw','studio_ro') AND c.relkind IN ('r','v') ORDER BY 1", db="neondb")
    assert acl_before == acl_after  # no grant moved


def test_the_extract_upsert_still_works_with_the_new_indexes(world, tmp_path):
    cluster, _, url = world
    assert run_roles(cluster, tmp_path, sql_file=SQL_DW, tag="dw")[0].returncode == 0
    assert run_roles(cluster, tmp_path, sql_file=SQL_IDX, tag="idx")[0].returncode == 0
    cols = cluster.su_exec("SELECT column_name FROM information_schema.columns WHERE table_schema='studio_dw' AND table_name='individuals_prescriptions' ORDER BY ordinal_position", db="neondb")
    names = [c[0] for c in cols]
    assert "uid" in names and "_id" in names
    ins = 'INSERT INTO studio_dw.individuals_prescriptions ("_id", uid, "timestamp", _run_id) VALUES (\'{k}\', \'U{i}\', now(), \'{run}\') ON CONFLICT ("_id") DO UPDATE SET uid = EXCLUDED.uid, _run_id = EXCLUDED._run_id'
    run = "00000000-0000-0000-0000-000000000001"
    cluster.su_exec("INSERT INTO studio_dw.extract_runs (run_id, mode, started_at, status) VALUES ('%s', 'full', now(), 'running')" % run, db="neondb")
    for i in range(3):  # the same keys twice: the second pass is the ON CONFLICT path
        for k in ("a", "b"):
            cluster.su_exec(ins.format(k=k, i=i, run=run), db="neondb")
    rows = cluster.su_exec("SELECT count(*) FROM studio_dw.individuals_prescriptions", db="neondb")
    assert rows[0][0] == 2


# ----------------------------------------------------------------------------------------------------------- relay render
def _render_with(src: str, tmp_path):
    from tests.test_cdmss_relay_install import HOST, LOCAL_ENV0, NEON_ENV0, URL
    import json, os, sys

    py = re.search(r"python3 - <<'PY'\n(.*?)\nPY\n", src, re.S).group(1)
    run = tmp_path / "run"
    run.mkdir()
    (tmp_path / "neon.env").write_text(NEON_ENV0 + f"CDMSS_NEON_URL={URL}\n")
    (tmp_path / "local.env").write_text(LOCAL_ENV0 + "AGENT_CDMSS_PW=" + "c" * 48 + "\n")
    (tmp_path / "pins.json").write_text(json.dumps({"gov.example.neon.tech": ["192.0.2.10"], HOST: ["192.0.2.20"]}))
    env = {**os.environ, "NEON_ENV": str(tmp_path / "neon.env"), "LOCAL_ENV": str(tmp_path / "local.env"), "PINS": str(tmp_path / "pins.json"),
           "RUN": str(run), "HOSTS": str(tmp_path / "relay-hosts"), "HOSTS_ONLY": "0", "SVC": __import__("pwd").getpwuid(os.getuid()).pw_name}
    r = subprocess.run([sys.executable, "-I", "-c", py], env=env, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return (run / "pgbouncer.ini").read_text(), (run / "userlist.txt").read_text()


def test_relay_render_diff_is_only_the_pool_size_of_the_gov_and_cdmss_lines(tmp_path):
    base = subprocess.run(["git", "show", "ae81227:ops/asus/studio-pgrelay-render.sh"], cwd=REPO, capture_output=True, text=True)
    if base.returncode != 0:
        pytest.skip("base commit ae81227 not available")
    (tmp_path / "old").mkdir()
    (tmp_path / "new").mkdir()
    old_ini, old_users = _render_with(base.stdout, tmp_path / "old")
    new_ini, new_users = _render_with((REPO / "ops/asus/studio-pgrelay-render.sh").read_text(), tmp_path / "new")
    assert old_users == new_users
    changed = [(a, b) for a, b in zip(old_ini.splitlines(), new_ini.splitlines()) if a != b and not a.startswith("auth_file = ")]  # auth_file is the per-run temp path
    assert len(old_ini.splitlines()) == len(new_ini.splitlines())
    assert len(changed) == 2  # gov and cdmss, nothing else (studio stays at 5; max_client_conn, max_db_connections, TLS untouched)
    for a, b in changed:
        assert a.split(" = ")[0] == b.split(" = ")[0] in ("gov", "cdmss")
        assert a.replace("pool_size=2", "pool_size=4") == b
    studio = [l for l in new_ini.splitlines() if l.startswith("studio = ")][0]
    assert "pool_size=5" in studio
    assert "max_client_conn = 50" in new_ini and "max_db_connections = 8" in new_ini


def test_pool_of_4_fits_the_role_connection_limits():
    gov = (OPS_NEON / "0001_roles.sql").read_text()
    cd = (REPO / "ops/cdmss/0001_cdmss_ro_role.sql").read_text()
    lim = lambda t: int(re.search(r"CONNECTION LIMIT (\d+)", t).group(1))  # noqa: E731
    assert lim(gov) == 20 and lim(cd) == 5
    assert 4 < lim(cd) and 4 <= lim(gov) // 2  # 4 server connections per alias, leaving the role room for owner/verify logins and the Vercel app


def test_the_dw_rx_read_uses_the_uid_index(world, tmp_path):
    cluster, _, url = world
    assert run_roles(cluster, tmp_path, sql_file=SQL_DW, tag="dw")[0].returncode == 0
    run = "00000000-0000-0000-0000-000000000002"
    cluster.su_exec(f"INSERT INTO studio_dw.extract_runs (run_id, mode, started_at, status) VALUES ('{run}', 'full', now(), 'running')", db="neondb")
    cluster.su_exec(f"""INSERT INTO studio_dw.individuals_prescriptions ("_id", uid, "timestamp", _run_id)
                        SELECT 'id' || g, 'U' || (g % 40000), now() - (g || ' minutes')::interval, '{run}' FROM generate_series(1, 60000) g""", db="neondb")
    plan = lambda: " ".join(r[0] for r in cluster.su_exec("EXPLAIN SELECT uid FROM studio_dw.individuals_prescriptions WHERE uid = ANY(ARRAY['U1','U2','U3'])", db="neondb"))  # noqa: E731
    cluster.su_exec("ANALYZE studio_dw.individuals_prescriptions", db="neondb")
    assert "Seq Scan" in plan() and "Index" not in plan()  # before: the whole table, per call
    assert run_roles(cluster, tmp_path, sql_file=SQL_IDX, tag="idx")[0].returncode == 0
    cluster.su_exec("ANALYZE studio_dw.individuals_prescriptions", db="neondb")
    assert "individuals_prescriptions_uid_idx" in plan()
