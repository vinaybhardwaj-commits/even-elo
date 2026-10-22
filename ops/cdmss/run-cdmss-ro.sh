#!/usr/bin/env bash
# Create / configure the CDMSS read-only role and its column-scoped views, then verify them. NO password is ever handled
# here (not generated, not sent, not written): the password is issued later by the Neon API, and LOGIN is a separate
# step (not in this script; the role stays NOLOGIN).
#
#   run-cdmss-ro.sh [--allow-disk-tmp] OWNER_URL_FILE    0000 PRE-CHECK (read-only), then 0001 role + 0002 views + 0003 post-check in ONE transaction
#   run-cdmss-ro.sh --precheck [--allow-disk-tmp] OWNER_URL_FILE  only 0000: list every view source column missing live (G-23), exit 4 if any
#   run-cdmss-ro.sh --dry-run                            print the SQL, connect to nothing
#   run-cdmss-ro.sh --check [--allow-disk-tmp] OWNER_URL_FILE   0000 pre-check (printed) + 0003 (read-only post-check) against the live DB
#
# Refuses a superuser (checked here and again inside each SQL file). A failure anywhere rolls the whole thing back:
# the role never exists without its post-check having passed in the same transaction.
# OWNER_URL_FILE: 0600 file with the OWNER's DIRECT url of the CDMSS database. psql reads it as a service file on tmpfs
# ($XDG_RUNTIME_DIR, else /dev/shm), so nothing secret is on any command line. NEVER point it at a database you have not
# been told to change: this script is not run by builders.
# Env: PSQL (default psql), CDMSS_RO_SQL_DIR (override the SQL directory), STUDIO_ROLES_SHM (tmpfs fallback dir).
set -euo pipefail
umask 077

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
sql_dir=${CDMSS_RO_SQL_DIR:-$here}
psql_bin=${PSQL:-psql}
files=(0001_cdmss_ro_role.sql 0002_cdmss_ro_views.sql 0003_cdmss_ro_postcheck.sql)
pre=0000_cdmss_ro_precheck.sql

allow_disk=0 dry=0 check=0 precheck_only=0
while [[ ${1:-} == --* ]]; do
  case $1 in
    --allow-disk-tmp) allow_disk=1 ;;
    --dry-run) dry=1 ;;
    --check) check=1; files=(0003_cdmss_ro_postcheck.sql) ;;
    --precheck) precheck_only=1; files=() ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ $dry -eq 1 ]]; then
  echo "-- dry run: nothing is connected; no password is generated, read or sent by this script"
  echo "-- would: $psql_bin -X -q --single-transaction -v ON_ERROR_STOP=1 ${files[*]/#/-f $sql_dir/} (service file from the owner url, on tmpfs)"
  for f in "$pre" "${files[@]}"; do echo "-- ==== $f"; cat "$sql_dir/$f"; done
  exit 0
fi

[[ $# -eq 1 ]] || { echo "usage: $0 [--allow-disk-tmp] [--check|--precheck] OWNER_URL_FILE | --dry-run" >&2; exit 2; }
owner_file=$1
[[ -f $owner_file && -r $owner_file ]] || { echo "owner url file not readable" >&2; exit 2; }
for f in "$pre" "${files[@]}"; do [[ -r $sql_dir/$f ]] || { echo "missing $sql_dir/$f" >&2; exit 2; }; done

tmpbase=
for d in "${XDG_RUNTIME_DIR:-}" "${STUDIO_ROLES_SHM:-/dev/shm}"; do
  if [[ -n $d && -d $d && -w $d ]]; then tmpbase=$d; break; fi
done
if [[ -z $tmpbase ]]; then
  [[ $allow_disk -eq 1 ]] || { echo "no tmpfs temp dir (\$XDG_RUNTIME_DIR, /dev/shm); refusing to put secrets on disk. Use --allow-disk-tmp to override." >&2; exit 2; }
  tmpbase=${TMPDIR:-/tmp}
fi
tmp=$(mktemp -d "$tmpbase/cdmss-ro.XXXXXX")
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

# Refuse a superuser before running anything (the SQL files check again).
su=$(PGSERVICEFILE="$tmp/svc" "$psql_bin" -X -q -At -v ON_ERROR_STOP=1 -c "SELECT rolsuper FROM pg_roles WHERE rolname = current_user" "service=owner")
[[ $su == f ]] || { echo "connected as a superuser (or the role could not be read): refusing; use the database OWNER role" >&2; exit 3; }

# PRE-CHECK (read-only, its own call): every view source column must exist live; nothing is applied otherwise (exit 4).
if ! PGSERVICEFILE="$tmp/svc" "$psql_bin" -X -q -v ON_ERROR_STOP=1 -f "$sql_dir/$pre" "service=owner" >/dev/null; then
  echo "pre-check FAILED: the live schema lacks columns the views read (list above). Nothing was applied." >&2
  exit 4
fi
[[ $precheck_only -eq 0 ]] || { echo "studio_cdmss_ro: pre-check passed (nothing changed)"; exit 0; }

args=()
for f in "${files[@]}"; do args+=(-f "$sql_dir/$f"); done
PGSERVICEFILE="$tmp/svc" "$psql_bin" -X -q --single-transaction -v ON_ERROR_STOP=1 "${args[@]}" "service=owner" >/dev/null

if [[ $check -eq 1 ]]; then echo "studio_cdmss_ro: post-check passed (nothing changed)"
else echo "studio_cdmss_ro: role (NOLOGIN, no password) + 16 views created/refreshed and post-check passed; next: issue the password via the Neon API, then enable LOGIN"; fi
