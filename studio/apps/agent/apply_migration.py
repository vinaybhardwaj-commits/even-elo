"""Apply Studio migrations idempotently.

    uv run python apply_migration.py --dsn-env STUDIO_ADMIN_DATABASE_URL [--app-role studio_app]

--dsn-env NAMES the environment variable that holds the connection string (use the DIRECT,
non-pooled Neon URL of a role that may create tables). The value is never printed.
Steps: (1) langgraph checkpointer setup(); (2) migrations/*.sql in order, each in one transaction.
The migrating role becomes the OWNER of studio_audit and must differ from --app-role (checked): an
owner can disable the append-only trigger, the app role cannot.
Do not run this against a real database from CI or from a build step.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parent / "migrations"
IDENT = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")


def render(sql: str, app_role: str) -> str:
    if not IDENT.match(app_role):
        raise ValueError("--app-role must be a plain lower-case identifier")
    return sql.replace("{{app_role}}", f'"{app_role}"')


def apply(dsn: str, app_role: str, migrations_dir: Path = MIGRATIONS) -> list[str]:
    import psycopg
    from src.studio_pins import pinned_conninfo
    from langgraph.checkpoint.postgres import PostgresSaver

    applied: list[str] = []
    # Neon: autocommit + no prepared statements; setup() runs its own DDL.
    with psycopg.connect(pinned_conninfo(dsn), autocommit=True, prepare_threshold=None) as conn:
        me = conn.execute("SELECT current_user").fetchone()[0]
        if me == app_role:
            raise SystemExit(
                "refusing to run: the migrating role and --app-role are the same ('%s'). The table owner "
                "must be a separate role, or the app role could disable the studio_audit trigger." % me
            )
        row = conn.execute(
            "SELECT rolsuper, rolbypassrls, pg_has_role(rolname, current_user, 'MEMBER') FROM pg_roles WHERE rolname = %s",
            (app_role,),
        ).fetchone()
        if row is None:
            raise SystemExit(f"app role '{app_role}' does not exist; create it first (this script never creates roles)")
        superuser, bypass_rls, member_of_me = row
        if superuser or bypass_rls:
            raise SystemExit(f"refusing to run: app role '{app_role}' is SUPERUSER or BYPASSRLS")
        if member_of_me:
            raise SystemExit(
                f"refusing to run: app role '{app_role}' is a member of the migrating role '{me}' (it would inherit "
                "ownership and could disable the studio_audit trigger)"
            )
        owner = conn.execute(
            "SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.relname = 'studio_audit' AND c.relkind = 'r' "
            "AND pg_table_is_visible(c.oid)"
        ).fetchone()
        if owner and conn.execute("SELECT pg_has_role(%s, %s, 'MEMBER')", (app_role, owner[0])).fetchone()[0]:
            raise SystemExit(f"refusing to run: app role '{app_role}' is (a member of) the owner '{owner[0]}' of studio_audit")
        PostgresSaver(conn).setup()
        for path in sorted(migrations_dir.glob("*.sql")):
            sql = render(path.read_text(), app_role)
            with conn.transaction():
                conn.execute(sql, prepare=False)  # multi-statement file: simple protocol
            applied.append(path.stem)
    return applied


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dsn-env", required=True, help="NAME of the env var holding the connection string")
    parser.add_argument("--app-role", default="studio_app")
    args = parser.parse_args(argv)
    dsn = os.environ.get(args.dsn_env, "")
    if not dsn:
        print(f"environment variable {args.dsn_env} is not set", file=sys.stderr)
        return 2
    applied = apply(dsn, args.app_role)
    print("applied:", ", ".join(applied) if applied else "(none)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
