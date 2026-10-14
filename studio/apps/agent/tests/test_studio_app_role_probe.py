"""Live probe for the studio APP role (STUDIO_DATABASE_URL): same server-side egress checks as the
GOV_RO probe, plus its own boundaries. Skips unless STUDIO_DATABASE_URL is set; run once at the ops
step against the real role. Everything is rolled back; the DSN is captured at import and never printed."""

import os

import pytest

psycopg = pytest.importorskip("psycopg")
DSN = os.environ.get("STUDIO_DATABASE_URL", "")
pytestmark = pytest.mark.skipif(not DSN, reason="STUDIO_DATABASE_URL not set (live studio-app probe)")


def test_no_server_side_egress_primitives_dblink_postgres_fdw():
    from tests.egress import assert_no_egress

    with psycopg.connect(DSN, autocommit=False, prepare_threshold=None) as conn:
        assert_no_egress(conn, "studio_app")


def test_role_is_not_a_superuser_and_cannot_alter_the_append_only_audit():
    with psycopg.connect(DSN, autocommit=False, prepare_threshold=None) as conn:
        try:
            assert conn.execute("SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls FROM pg_roles WHERE rolname = current_user").fetchone()[0] is False
            for sql in ("UPDATE studio_audit SET tool = tool WHERE false", "DELETE FROM studio_audit WHERE false", "TRUNCATE studio_audit"):
                with pytest.raises(psycopg.errors.InsufficientPrivilege):
                    conn.execute(sql)
                conn.rollback()
        finally:
            conn.rollback()
