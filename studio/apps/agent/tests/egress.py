"""Server-side egress primitives (dblink / postgres_fdw): a database role that can CREATE EXTENSION,
CREATE anything, or EXECUTE dblink_* could make the database server open connections on its own.
Shared by the live probes and the scratch-Postgres tests. Everything runs in a rolled-back transaction."""

import psycopg

EXTENSIONS = ("dblink", "postgres_fdw")


def assert_no_egress(conn: "psycopg.Connection", who: str = "role") -> None:
    def scalar(sql, params=()):
        try:
            return conn.execute(sql, params).fetchone()[0]
        finally:
            conn.rollback()

    assert scalar("SELECT has_database_privilege(current_database(), 'CREATE')") is False, f"{who}: CREATE on database"
    n = scalar(
        """SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('pg_catalog', 'information_schema')
           AND nspname NOT LIKE 'pg_%%' AND has_schema_privilege(oid, 'CREATE')"""
    )
    assert n == 0, f"{who}: CREATE on {n} schema(s)"

    for ext in EXTENSIONS:
        available = scalar("SELECT count(*) FROM pg_available_extensions WHERE name = %s", (ext,)) > 0
        try:
            # Read-only flags off first, so a read-only transaction can never mask a missing privilege.
            conn.execute("SET transaction_read_only = off")
            conn.execute(f"CREATE EXTENSION IF NOT EXISTS {ext}")
        except psycopg.errors.InsufficientPrivilege:
            pass  # the required outcome
        except psycopg.errors.FeatureNotSupported:
            # Only acceptable when the server does not ship the extension at all (e.g. a stripped scratch server).
            assert not available, f"{who}: {ext} is available but CREATE EXTENSION failed for another reason"
        else:
            raise AssertionError(f"{who}: CREATE EXTENSION {ext} SUCCEEDED")
        finally:
            conn.rollback()

    installed = scalar("SELECT count(*) FROM pg_extension WHERE extname = ANY(%s)", (list(EXTENSIONS),))
    assert installed == 0, f"{who}: dblink/postgres_fdw is installed"
    callable_fns = scalar(
        """SELECT count(*) FROM pg_proc p
           WHERE (p.proname LIKE 'dblink%%' OR p.proname LIKE 'postgres_fdw%%')
             AND has_function_privilege(p.oid, 'EXECUTE')"""
    )
    assert callable_fns == 0, f"{who}: may EXECUTE dblink/postgres_fdw functions"
    assert scalar("SELECT count(*) FROM pg_foreign_server") == 0, f"{who}: foreign servers exist"
    usable_fdw = scalar("SELECT count(*) FROM pg_foreign_data_wrapper w WHERE has_foreign_data_wrapper_privilege(w.oid, 'USAGE')")
    assert usable_fdw == 0, f"{who}: USAGE on a foreign data wrapper"
