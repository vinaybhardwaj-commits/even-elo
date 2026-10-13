"""The studio app's live role read (LIVE_STAFF_SQL in studio/apps/app/src/lib/zone/live-staff.ts) run
against a REAL Postgres built by applying the even-elo migrations in order (src/lib/migrations.ts).

This is the regression test for the R2 blocker: profiles_with_roles is `SELECT p.*` frozen at
migration 015, so it has no must_change_pin (added to profiles in 020). Mocks hid that.
Runs when STUDIO_TEST_PG_URI (superuser, scratch server) is set or `pgserver` is importable;
skips when the even-elo repo root (parents[4]) is not around or no Postgres is available.
"""

import importlib.util
import os
import re
import tempfile
import uuid
from pathlib import Path

import psycopg
import pytest
from psycopg.conninfo import make_conninfo

ROOT = Path(__file__).resolve().parents[4]
MIGRATIONS_TS = ROOT / "src" / "lib" / "migrations.ts"
LIVE_STAFF_TS = Path(__file__).resolve().parents[2] / "app" / "src" / "lib" / "zone" / "live-staff.ts"

pytestmark = pytest.mark.skipif(not MIGRATIONS_TS.exists(), reason="even-elo repo root not available")


def live_staff_sql() -> str:
    m = re.search(r"export const LIVE_STAFF_SQL = `(.*?)`;", LIVE_STAFF_TS.read_text(), re.S)
    assert m, "LIVE_STAFF_SQL not found"
    return re.sub(r"\$1\b", "%s", m.group(1))


def migrations() -> list[tuple[str, str]]:
    found = re.findall(r'id: "([0-9]{3}_[^"]+)",.*?sql:\s*`(.*?)`', MIGRATIONS_TS.read_text(), re.S)
    assert len(found) >= 40 and [i for i, _ in found] == sorted(i for i, _ in found)
    return found


@pytest.fixture(scope="module")
def uri():
    base = os.environ.get("STUDIO_TEST_PG_URI")
    server = None
    if not base:
        if importlib.util.find_spec("pgserver") is None:
            pytest.skip("no local Postgres (set STUDIO_TEST_PG_URI or install pgserver)")
        import pgserver

        server = pgserver.get_server(tempfile.mkdtemp(prefix="studio-live-staff-"))
        base = server.get_uri()
    try:
        yield base
    finally:
        if server:
            server.cleanup()


@pytest.fixture(scope="module")
def db(uri):
    name = "evenelo_" + uuid.uuid4().hex[:8]
    with psycopg.connect(uri, autocommit=True) as c:
        c.execute(f'CREATE DATABASE "{name}"')
    conn = psycopg.connect(make_conninfo(uri, dbname=name), autocommit=True)
    for mid, sql in migrations():  # exactly the order even-elo applies them
        try:
            # pgcrypto is contrib (absent from pgserver); gen_random_uuid() is built in since PG13.
            conn.execute(sql.replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", ""), prepare=False)
        except Exception as exc:  # pragma: no cover - surfaced with the failing id
            raise AssertionError(f"even-elo migration {mid} failed to apply: {type(exc).__name__}") from exc
    conn.execute("CREATE ROLE ro_live_staff NOLOGIN")
    # EXACTLY the documented grants (docs/architecture.md): COLUMN grants on the view and on profiles.
    # (The view is `SELECT p.*`, so a table-wide grant on it would expose password_hash.)
    conn.execute("GRANT SELECT (id, status, is_super_admin) ON profiles_with_roles TO ro_live_staff")
    conn.execute("GRANT SELECT (id, must_change_pin) ON profiles TO ro_live_staff")
    yield conn
    conn.close()


def add_profile(conn, pin_flag, is_super=True, status="active"):
    h = conn.execute("INSERT INTO hospitals (code, name) VALUES (%s, 'H') RETURNING id", ("H" + uuid.uuid4().hex[:6],)).fetchone()[0]
    pos = conn.execute("SELECT id FROM positions LIMIT 1").fetchone()
    if pos is None:
        pos = conn.execute("INSERT INTO positions (team, position_name) VALUES ('Staff','P') RETURNING id").fetchone()
    pid = uuid.uuid4()
    conn.execute(
        "INSERT INTO profiles (id, email, full_name, password_hash, position_id, hospital_id, status, is_super_admin, must_change_pin) "
        "VALUES (%s, %s, 'T', 'x', %s, %s, %s, %s, %s)",
        (pid, f"{pid.hex}@example.invalid", pos[0], h, status, is_super, pin_flag),
    )
    return str(pid)


def run_as_ro(conn, profile_id):
    conn.execute("SET ROLE ro_live_staff")
    try:
        return conn.execute(live_staff_sql(), (profile_id,)).fetchall()
    finally:
        conn.execute("RESET ROLE")


def test_the_view_really_lacks_must_change_pin(db):
    """Guards the premise: if even-elo ever recreates the view with the column, this test says so."""
    cols = {r[0] for r in db.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'profiles_with_roles'")}
    assert "is_super_admin" in cols and "must_change_pin" not in cols
    assert "must_change_pin" in {r[0] for r in db.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'profiles'")}


def test_the_r2_query_fails_on_the_real_schema(db):
    pid = add_profile(db, False)
    with pytest.raises(psycopg.errors.UndefinedColumn):
        db.execute("SELECT p.status, p.is_super_admin, p.must_change_pin FROM profiles_with_roles p WHERE p.id = %s::uuid", (pid,))


def test_live_staff_sql_returns_the_flag_true_false_and_no_row(db):
    t, f = add_profile(db, True), add_profile(db, False)
    assert run_as_ro(db, t) == [("active", True, True)]
    assert run_as_ro(db, f) == [("active", True, False)]
    assert run_as_ro(db, str(uuid.uuid4())) == []  # unknown profile: no row -> the app treats it as unconfirmed (401)


def test_other_roles_and_statuses_come_through(db):
    assert run_as_ro(db, add_profile(db, False, is_super=False)) == [("active", False, False)]
    assert run_as_ro(db, add_profile(db, False, status="pending_approval"))[0][0] == "pending_approval"


def as_ro_fails(conn, sql, exc):
    conn.execute("SET ROLE ro_live_staff")
    try:
        with pytest.raises(exc):
            conn.execute(sql)
    finally:
        conn.execute("RESET ROLE")


def test_the_column_grant_is_enough_and_secrets_stay_denied(db):
    add_profile(db, False)
    assert run_as_ro(db, add_profile(db, True)) [0][2] is True  # LIVE_STAFF_SQL runs fine with only the column grant
    for col in ("password_hash", "email", "full_name", "is_super_admin", "status"):
        as_ro_fails(db, f"SELECT {col} FROM profiles", psycopg.errors.InsufficientPrivilege)
    as_ro_fails(db, "SELECT * FROM profiles", psycopg.errors.InsufficientPrivilege)
    as_ro_fails(db, "SELECT password_hash FROM profiles WHERE id = id", psycopg.errors.InsufficientPrivilege)
    ok = db.execute("SELECT has_column_privilege('ro_live_staff', 'profiles', 'password_hash', 'SELECT'), has_table_privilege('ro_live_staff', 'profiles', 'SELECT')").fetchone()
    assert ok == (False, False)
    # The view is `SELECT p.*`, so it carries password_hash: only the column grant keeps it closed.
    cols = {r[0] for r in db.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'profiles_with_roles'")}
    assert "password_hash" in cols  # premise: a table-wide grant on the view WOULD leak it
    for col in ("password_hash", "email", "full_name", "is_site_medical_head"):
        as_ro_fails(db, f"SELECT {col} FROM profiles_with_roles", psycopg.errors.InsufficientPrivilege)
    as_ro_fails(db, "SELECT * FROM profiles_with_roles", psycopg.errors.InsufficientPrivilege)
    as_ro_fails(db, "SELECT password_hash FROM profiles_with_roles WHERE id = id", psycopg.errors.InsufficientPrivilege)


def test_a_table_wide_grant_on_the_view_would_leak_the_hash(db):
    db.execute("CREATE ROLE ro_wide NOLOGIN")
    db.execute("GRANT SELECT ON profiles_with_roles TO ro_wide")
    add_profile(db, False)
    db.execute("SET ROLE ro_wide")
    try:
        assert db.execute("SELECT count(password_hash) FROM profiles_with_roles").fetchone()[0] >= 1  # the hole the docs forbid
    finally:
        db.execute("RESET ROLE")


def test_the_read_only_role_needs_select_on_profiles(db):
    db.execute("CREATE ROLE ro_view_only NOLOGIN")
    db.execute("GRANT SELECT (id, status, is_super_admin) ON profiles_with_roles TO ro_view_only")
    pid = add_profile(db, False)
    db.execute("SET ROLE ro_view_only")
    try:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            db.execute(live_staff_sql(), (pid,))
    finally:
        db.execute("RESET ROLE")
