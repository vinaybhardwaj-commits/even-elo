#!/usr/bin/env bash
# Apply ops/neon/0001_roles.sql with a fresh random password for studio_gov_ro.
#
#   ops/neon/run-roles.sh OWNER_URL_FILE OUT_FILE      # OWNER_URL_FILE: 0600 file holding the OWNER's DIRECT url
#   ops/neon/run-roles.sh --dry-run                    # print the statements, password masked, connect to nothing
#
# The owner URL is read from a file (e.g. written by `vercel env pull`), never taken from argv or the
# environment. The password goes only through 0600 temp files and a psql variable; the resulting
# GOV_RO url is written only to OUT_FILE (0600). Nothing secret is printed. The output url keeps the
# owner url's host: swap in the pooled host if the app should use the pooler.
# Env: PSQL (default psql), SQL_FILE (default: 0001_roles.sql next to this script).
set -euo pipefail
umask 077

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
sql_file=${SQL_FILE:-$here/0001_roles.sql}
psql_bin=${PSQL:-psql}

if [[ ${1:-} == --dry-run ]]; then
  echo "-- dry run: nothing is connected, no password is generated"
  echo "-- would: umask 077; openssl rand -hex 24 > <0600 temp file>; PWFILE=<that file>"
  echo "-- would: $psql_bin -X -q -v ON_ERROR_STOP=1 -f $sql_file (service file from the owner url)"
  echo "-- statements:"
  sed -E "s/^(ALTER ROLE studio_gov_ro PASSWORD ).*/\1'********';/" "$sql_file"
  echo "-- would write: the studio_gov_ro url with password ******** to OUT_FILE (0600)"
  exit 0
fi

[[ $# -eq 2 ]] || { echo "usage: $0 OWNER_URL_FILE OUT_FILE | --dry-run" >&2; exit 2; }
owner_file=$1
out_file=$2
[[ -f $owner_file && -r $owner_file ]] || { echo "owner url file not readable" >&2; exit 2; }
[[ ! -e $out_file ]] || { echo "refusing to overwrite $out_file" >&2; exit 2; }

tmp=$(mktemp -d)
cleanup() {
  local f
  for f in "$tmp"/*; do
    if [[ -f $f ]]; then shred -u "$f" 2>/dev/null || rm -f "$f"; fi
  done
  rmdir "$tmp" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export PWFILE="$tmp/pw"
openssl rand -hex 24 > "$PWFILE"   # hex only: safe inside a url, no encoding needed

# Owner url -> psql service file (so no secret is ever on psql's argv).
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

PGSERVICEFILE="$tmp/svc" "$psql_bin" -X -q -v ON_ERROR_STOP=1 -f "$sql_file" "service=owner" >/dev/null

# Build the GOV_RO url with bash string operations only (no argv exposure), keep the owner's host/db/params.
raw=$(<"$owner_file"); pw=$(<"$PWFILE")
scheme=${raw%%://*}://
rest=${raw#*://}
authority=${rest%%/*}
rest=${authority##*@}${rest#"$authority"}   # drop any userinfo; host, db and params stay
( umask 077; printf '%s%s:%s@%s\n' "$scheme" studio_gov_ro "$pw" "$rest" > "$out_file" )
chmod 600 "$out_file"
echo "studio_gov_ro configured; url written to $out_file (mode 600)"
