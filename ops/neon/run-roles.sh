#!/usr/bin/env bash
# Create / configure / enable the Studio database roles. NO password is ever handled here (not generated,
# not sent, not written): passwords are issued by the Neon API (neon-role.sh reset-password).
#
#   Runbook order (O1):
#     1. run-roles.sh [--role R] OWNER_URL_FILE            create R NOLOGIN by SQL + grants (one transaction)
#     2. neon-role.sh reset-password KEY PROJECT BRANCH R OUT --dsn-from OWNER_URL_FILE   (Neon issues the password)
#     3. run-roles.sh --login [--role R] OWNER_URL_FILE    memberships re-checked, then ALTER ROLE R LOGIN
#     4. probe (tests/test_lc1_live_probe.py, tests/test_studio_app_role_probe.py)
#   ROTATION (the role is already LOGIN): run-roles.sh --nologin FIRST (own committed statement), then step 2, then
#   step 3. A FAILED --login also issues the NOLOGIN statement itself before exiting non-zero (contain, not
#   just detect): a role the API made a member of neon_superuser must not stay LOGIN-able. Both also terminate
#   the role's live sessions (NOLOGIN only stops new connections); if that is denied the exit code is 5.
#
#   --role studio_gov_ro (default, governance DB: 0001_roles.sql) | studio_app (studio DB: 0002_studio_app_role.sql;
#   its table grants come from apply_migration.py, run before step 3)
#   --nologin                          set the role NOLOGIN in its own committed statement, then END its live
#                                      sessions (pg_terminate_backend); exit 5 + a warning naming the role and the
#                                      sessions left if the owner may not signal them (never silent)
#   --dry-run                          print the SQL for the chosen step, connect to nothing
#   --allow-disk-tmp                   allow a disk-backed temp dir (default: tmpfs only)
#
# Roles are created BY SQL because roles created through the Neon API/Console are granted neon_superuser,
# which a non-superuser owner cannot revoke. Setup runs a membership PREFLIGHT and POST-CHECK inside its
# transaction: a role that is a member of anything (neon_superuser or any other role) aborts and rolls back.
# OWNER_URL_FILE: 0600 file with the OWNER's DIRECT url. psql reads it as a service file on tmpfs
# ($XDG_RUNTIME_DIR, else /dev/shm), so nothing secret is on any command line.
# Env: PSQL (default psql), SQL_FILE (override the SQL file), STUDIO_ROLES_SHM (tmpfs fallback dir).
set -euo pipefail
umask 077

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
psql_bin=${PSQL:-psql}

allow_disk=0 login=0 nologin=0 dry=0 role=studio_gov_ro
while [[ ${1:-} == --* ]]; do
  case $1 in
    --allow-disk-tmp) allow_disk=1 ;;
    --login) login=1 ;;
    --nologin) nologin=1 ;;
    --dry-run) dry=1 ;;
    --role) role=${2:-}; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
case $role in
  studio_gov_ro) setup_sql=0001_roles.sql; probe_table=physicians; probe_priv=SELECT ;;
  studio_app) setup_sql=0002_studio_app_role.sql; probe_table=studio_audit; probe_priv=INSERT ;;
  *) echo "--role must be studio_gov_ro or studio_app" >&2; exit 2 ;;
esac
if [[ $login -eq 1 && $nologin -eq 1 ]]; then echo "--login and --nologin are exclusive" >&2; exit 2; fi
if [[ $nologin -eq 1 ]]; then sql_file=${SQL_FILE:-$here/0004_nologin.sql}
elif [[ $login -eq 1 ]]; then sql_file=${SQL_FILE:-$here/0003_login.sql}
else sql_file=${SQL_FILE:-$here/$setup_sql}; fi
nologin_sql=$here/0004_nologin.sql
terminate_sql=$here/0005_terminate.sql
sessions_sql=$here/0006_sessions.sql

if [[ $dry -eq 1 ]]; then
  echo "-- dry run: nothing is connected; no password is generated, read or sent by this script"
  echo "-- would: $psql_bin -X -q --single-transaction -v ON_ERROR_STOP=1 -v role=$role -v probe_table=$probe_table -v probe_priv=$probe_priv -f $sql_file (service file from the owner url, on tmpfs)"
  cat "$sql_file"
  exit 0
fi

[[ $# -eq 1 ]] || { echo "usage: $0 [--allow-disk-tmp] [--login|--nologin] [--role studio_gov_ro|studio_app] OWNER_URL_FILE | --dry-run" >&2; exit 2; }
owner_file=$1
[[ -f $owner_file && -r $owner_file ]] || { echo "owner url file not readable" >&2; exit 2; }

tmpbase=
for d in "${XDG_RUNTIME_DIR:-}" "${STUDIO_ROLES_SHM:-/dev/shm}"; do
  if [[ -n $d && -d $d && -w $d ]]; then tmpbase=$d; break; fi
done
if [[ -z $tmpbase ]]; then
  [[ $allow_disk -eq 1 ]] || { echo "no tmpfs temp dir (\$XDG_RUNTIME_DIR, /dev/shm); refusing to put secrets on disk. Use --allow-disk-tmp to override." >&2; exit 2; }
  tmpbase=${TMPDIR:-/tmp}
fi
tmp=$(mktemp -d "$tmpbase/studio-roles.XXXXXX")
cleanup() {
  local f
  for f in "$tmp"/*; do
    if [[ -f $f ]]; then shred -u "$f" 2>/dev/null || rm -f "$f"; fi
  done
  rmdir "$tmp" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Owner url -> psql service file (script on stdin, paths via env).
OWNER_URL_FILE=$owner_file SERVICE_FILE="$tmp/svc" python3 - <<'PY'
import os, urllib.parse as u

raw = open(os.environ["OWNER_URL_FILE"]).read().strip()
p = u.urlsplit(raw)
q = dict(u.parse_qsl(p.query))
lines = ["[owner]"]
host = q.pop("host", None) or p.hostname
if host: lines.append(f"host={host}")
if p.port: lines.append(f"port={p.port}")
if p.username: lines.append(f"user={u.unquote(p.username)}")
if p.password: lines.append(f"password={u.unquote(p.password)}")
db = p.path.lstrip("/")
if db: lines.append(f"dbname={u.unquote(db)}")
for k, v in q.items():
    if k in ("sslmode", "channel_binding", "options", "sslrootcert"): lines.append(f"{k}={v}")
open(os.environ["SERVICE_FILE"], "w").write("\n".join(lines) + "\n")
PY
chmod 600 "$tmp/svc"

psql_run() { # psql_run SQL_FILE [--single-transaction]: stdout discarded, errors on stderr
  local file=$1; shift
  PGSERVICEFILE="$tmp/svc" "$psql_bin" -X -q "$@" -v ON_ERROR_STOP=1 \
    -v "role=$role" -v "probe_table=$probe_table" -v "probe_priv=$probe_priv" \
    -f "$file" "service=owner" >/dev/null
}
psql_count() { # psql_count SQL_FILE: prints the single number the file selects
  PGSERVICEFILE="$tmp/svc" "$psql_bin" -X -q -At -v ON_ERROR_STOP=1 -v "role=$role" -f "$1" "service=owner"
}

# End the role's live sessions. 0 = done (count printed); 5 = denied: warn loudly with the sessions left.
terminate_sessions() {
  local n left
  if n=$(psql_count "$terminate_sql" 2>/dev/null); then
    echo "$role: $n live session(s) terminated"
    return 0
  fi
  left=$(psql_count "$sessions_sql" 2>/dev/null || echo "unknown")
  echo "WARNING: $role is NOLOGIN but $left live session(s) could NOT be terminated (the owner may not signal them: needs pg_signal_backend). End them manually (pg_terminate_backend) before trusting the rotation." >&2
  return 5
}

if [[ $nologin -eq 1 ]]; then
  psql_run "$sql_file"   # a single statement: committed on its own
  echo "$role: NOLOGIN (no password was touched)"
  terminate_sessions || exit 5
  exit 0
fi

rc=0
psql_run "$sql_file" --single-transaction || rc=$?

if [[ $rc -ne 0 && $login -eq 1 ]]; then
  # Contain, not just detect: whatever made the checks fail, the role must not stay LOGIN-able
  # (a rotation runs on a role that is already LOGIN, and the API may just have added neon_superuser).
  if psql_run "$nologin_sql" 2>/dev/null; then
    echo "$role: login checks FAILED; role set NOLOGIN (contained). Fix the cause, then run --login again." >&2
    terminate_sessions >&2 || exit 5   # exit 5 outranks the original code: live sessions remain
  else
    echo "$role: login checks FAILED and NOLOGIN could not be confirmed: run --nologin immediately." >&2
  fi
  exit "$rc"
fi
[[ $rc -eq 0 ]] || exit "$rc"

if [[ $login -eq 1 ]]; then echo "$role: LOGIN enabled (memberships and grants verified)"; else echo "$role: created/configured NOLOGIN (no password; next: neon-role.sh reset-password, then --login)"; fi
