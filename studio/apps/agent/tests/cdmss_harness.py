"""Scratch Postgres with a Neon-like owner layout and the CDMSS schema built from Even-CDMSS/migrations (G-23: there is
no migration ledger, so the files are applied in filename order and every failure is recorded, not hidden).
Nothing here touches a real database. The CDMSS repo is read-only; its path is $CDMSS_REPO (default ~/wt/Even-CDMSS)."""

import atexit
import importlib.util
import os
import shutil
import tempfile
from pathlib import Path

import psycopg
import pytest

REPO = Path(__file__).resolve().parents[4]
OPS = REPO / "ops" / "cdmss"
SQL_ROLE = OPS / "0001_cdmss_ro_role.sql"
SQL_VIEWS = OPS / "0002_cdmss_ro_views.sql"
SQL_POST = OPS / "0003_cdmss_ro_postcheck.sql"
SQL_SETTINGS = OPS / "0004_role_settings.sql"
SQL_PRE = OPS / "0000_cdmss_ro_precheck.sql"
RUN_WRAPPER = OPS / "run-cdmss-ro.sh"
RUNTIME_DDL = Path(__file__).parent / "fixtures" / "cdmss_runtime_ddl.sql"
CDMSS_REPO = Path(os.environ.get("CDMSS_REPO", "~/wt/Even-CDMSS")).expanduser()
ROLE = "studio_cdmss_ro"

HAVE_PG = importlib.util.find_spec("pgserver") is not None
needs_env = pytest.mark.skipif(
    not (HAVE_PG and OPS.exists() and (CDMSS_REPO / "migrations").is_dir()),
    reason="needs pgserver, ops/cdmss and the Even-CDMSS checkout (CDMSS_REPO)",
)


def sql_text(path: Path) -> str:
    """The file without its psql meta-commands (\\set ...), for driving it through psycopg."""
    return "\n".join(l for l in path.read_text().splitlines() if not l.startswith("\\"))


class CdmssCluster:
    def __init__(self):
        import pgserver

        self.data_dir = tempfile.mkdtemp(prefix="cdmss-emu-")
        atexit.register(shutil.rmtree, self.data_dir, ignore_errors=True)  # backstop if stop() is never reached
        self.server = pgserver.get_server(self.data_dir)
        self.su = self.server.get_uri()
        self.sock = self.su.split("host=")[1]
        self.psql = str(Path(pgserver.__file__).parent / "pginstall" / "bin" / "psql")
        with psycopg.connect(self.su, autocommit=True) as c:
            c.execute("CREATE ROLE neon_superuser NOLOGIN CREATEDB CREATEROLE BYPASSRLS")
            c.execute("CREATE ROLE neondb_owner LOGIN CREATEDB CREATEROLE BYPASSRLS")
            c.execute("GRANT neon_superuser TO neondb_owner")
            c.execute("CREATE DATABASE cdmssdb OWNER neondb_owner")
            # password logins for the CDMSS role must really authenticate (scram), as on Neon
            hba = Path(c.execute("SHOW hba_file").fetchone()[0])
            c.execute("ALTER SYSTEM SET password_encryption = 'scram-sha-256'")
            c.execute("ALTER SYSTEM SET log_statement = 'all'")      # so tests can find (and scan for) the throwaway password seeded over SQL
            hba.write_text("local all studio_cdmss_ro scram-sha-256\n" + hba.read_text())
            c.execute("SELECT pg_reload_conf()")
        with psycopg.connect(self.su, autocommit=True) as c:
            self.log = Path(c.execute("SHOW data_directory").fetchone()[0]) / "log"
        self.owner_url = self.url("neondb_owner", "cdmssdb")
        self.su_cdmss = self.su.replace("@/postgres?", "@/cdmssdb?")
        self.first_pass_failures: list[tuple[str, str]] = []
        self.second_pass_failures: list[tuple[str, str]] = []
        self.applied: list[str] = []
        self._build_schema()

    def url(self, user, db):
        return f"postgresql://{user}:@/{db}?host={self.sock}"

    def owner(self):
        return psycopg.connect(self.owner_url, autocommit=True)

    def _try(self, conn, f: Path):
        try:
            conn.execute(f.read_text(), prepare=False)
            return None
        except Exception as e:  # recorded, never swallowed silently
            return str(e).strip().splitlines()[0]

    def _build_schema(self):
        files = sorted((CDMSS_REPO / "migrations").glob("*.sql"))
        with self.owner() as conn:
            pending = []
            for f in files:
                err = self._try(conn, f)
                if err:
                    pending.append(f)
                    self.first_pass_failures.append((f.name, err))
                else:
                    self.applied.append(f.name)
            # the app creates some tables/columns at runtime (route handlers), not in migrations: transcribed fixture
            conn.execute(RUNTIME_DDL.read_text(), prepare=False)
            for f in pending:  # second pass: which failures were only ordering / runtime-DDL dependencies
                err = self._try(conn, f)
                if err:
                    self.second_pass_failures.append((f.name, err))
                else:
                    self.applied.append(f.name)

    def owner_exec_file(self, path: Path):
        with self.owner() as conn:
            conn.execute(sql_text(path), prepare=False)

    def su_exec(self, sql, params=None):
        with psycopg.connect(self.su_cdmss, autocommit=True) as c:
            cur = c.execute(sql, params)
            return cur.fetchall() if cur.description else None

    def as_role(self, sql, params=None):
        """Run SQL with the privileges of studio_cdmss_ro (SET ROLE from the harness superuser)."""
        with psycopg.connect(self.su_cdmss, autocommit=True) as c:
            c.execute(f"SET ROLE {ROLE}")
            cur = c.execute(sql, params)
            return cur.fetchall() if cur.description else None

    def stop(self):
        """Stop postgres AND delete the data dir (pgserver's cleanup() only stops the server; the dir leaked)."""
        try:
            self.server.cleanup()
        finally:
            shutil.rmtree(self.data_dir, ignore_errors=True)


@pytest.fixture(scope="session")
def cdmss():
    """Session-wide scratch cluster: CDMSS schema built, then 0001 + 0002 applied by the owner."""
    if not HAVE_PG:
        pytest.skip("pgserver not installed (uv run --python 3.12 --with pgserver python -m pytest)")
    if not (CDMSS_REPO / "migrations").is_dir() or not OPS.exists():
        pytest.skip("Even-CDMSS checkout (CDMSS_REPO) or ops/cdmss not available")
    c = CdmssCluster()
    c.owner_exec_file(SQL_ROLE)
    c.owner_exec_file(SQL_VIEWS)
    yield c
    c.stop()
