"""Apply Studio migrations idempotently.

    uv run python apply_migration.py --dsn-env STUDIO_ADMIN_DATABASE_URL [--app-role studio_app]

--dsn-env NAMES the environment variable that holds the connection string (use the DIRECT,
non-pooled Neon URL of a role that may create tables). The value is never printed.
Steps: (1) langgraph checkpointer setup(); (2) migrations/*.sql in order, each in one transaction.
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
    from langgraph.checkpoint.postgres import PostgresSaver

    applied: list[str] = []
    # Neon: autocommit + no prepared statements; setup() runs its own DDL.
    with psycopg.connect(dsn, autocommit=True, prepare_threshold=0) as conn:
        exists = conn.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (app_role,)).fetchone()
        if not exists:
            raise SystemExit(f"app role '{app_role}' does not exist; create it first (this script never creates roles)")
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
