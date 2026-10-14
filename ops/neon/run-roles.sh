#!/usr/bin/env bash
# Apply ops/neon/0001_roles.sql with a fresh random password for studio_gov_ro.
#
#   ops/neon/run-roles.sh [--allow-disk-tmp] OWNER_URL_FILE OUT_FILE
#   ops/neon/run-roles.sh [--allow-disk-tmp] --password-preset OWNER_URL_FILE
#       OWNER_URL_FILE: 0600 file holding the OWNER's DIRECT url (e.g. from `vercel env pull`)
#   ops/neon/run-roles.sh --dry-run                    # print the statements, connect to nothing
#
# The PLAINTEXT password never reaches the server through SQL: this script computes a SCRAM-SHA-256
# verifier client-side and the SQL sends only that (plaintext only in OUT_FILE, 0600, inside the GOV_RO url).
# Neon's control plane rejects verifiers, and plaintext over SQL is not allowed (it would put the password in
# server logs): on Neon create the role with the Neon API first (ops/neon/neon-role.sh), then run this with
# --password-preset. That mode never touches the password: the role must already exist (with its login
# password from the API), is switched to NOLOGIN first, gets limits/timeouts/revokes/grants, and LOGIN last,
# all in one transaction. No OUT_FILE: the DSN was written by neon-role.sh.
# The temp dir holds the owner-url service file; it lives on tmpfs ($XDG_RUNTIME_DIR, else /dev/shm);
# a disk-backed temp dir is refused unless --allow-disk-tmp.
# The output url keeps the owner url's host: swap in the pooler host if the app should use it.
# Env: PSQL (default psql), SQL_FILE (default: 0001_roles.sql next to this script),
#      STUDIO_ROLES_SHM (tmpfs fallback dir, default /dev/shm).
set -euo pipefail
umask 077

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
sql_file=${SQL_FILE:-$here/0001_roles.sql}
psql_bin=${PSQL:-psql}

if [[ ${1:-} == --dry-run ]]; then
  echo "-- dry run: nothing is connected, no password is generated"
  echo "-- would: umask 077; pick a tmpfs dir (\$XDG_RUNTIME_DIR, else /dev/shm); openssl rand -hex 24 > <0600 file>"
  echo "-- (--password-preset: no password step at all; the role must already exist, created by neon-role.sh)"
  echo "-- would: compute SCRAM-SHA-256\$4096:<salt>\$<StoredKey>:<ServerKey> from it; only the verifier is sent"
  echo "-- would: $psql_bin -X -q --single-transaction -v ON_ERROR_STOP=1 -f $sql_file (service file from the owner url)"
  echo "-- statements (the verifier is read from a file into a psql variable, never printed):"
  cat "$sql_file"
  echo "-- would write: the studio_gov_ro url with the plaintext password to OUT_FILE (0600)"
  exit 0
fi

allow_disk=0
preset=0
while [[ ${1:-} == --* ]]; do
  case $1 in
    --allow-disk-tmp) allow_disk=1 ;;
    --password-preset) preset=1 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
if [[ $preset -eq 1 ]]; then
  [[ $# -eq 1 ]] || { echo "usage: $0 [--allow-disk-tmp] --password-preset OWNER_URL_FILE" >&2; exit 2; }
  owner_file=$1
  out_file=
else
  [[ $# -eq 2 ]] || { echo "usage: $0 [--allow-disk-tmp] OWNER_URL_FILE OUT_FILE | [--allow-disk-tmp] --password-preset OWNER_URL_FILE | --dry-run" >&2; exit 2; }
  owner_file=$1
  out_file=$2
  [[ ! -e $out_file ]] || { echo "refusing to overwrite $out_file" >&2; exit 2; }
fi
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
trap 'exit 130' INT
trap 'exit 143' TERM

pwfile="$tmp/pw"
verifierfile="$tmp/verifier"
if [[ $preset -eq 1 ]]; then
  # Password already set by the Neon API: no password file, no password statement; the role must exist.
  unset ROLE_PASSWORD_FILE
  export ROLE_MUST_EXIST=1
else
  export ROLE_PASSWORD_FILE=$verifierfile
  openssl rand -hex 24 > "$pwfile"   # hex only: safe inside a url, no encoding needed
fi

# One python step (script on stdin, paths via env): owner url -> psql service file and, unless the password
# is preset, the password -> SCRAM-SHA-256 verifier (RFC 5802 / 7677, as `\password` does).
OWNER_URL_FILE=$owner_file SERVICE_FILE="$tmp/svc" PWFILE_IN=$pwfile VERIFIER_OUT=$verifierfile PRESET=$preset python3 - <<'PY'
import base64, hashlib, hmac, os, urllib.parse as u

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

if os.environ["PRESET"] != "1":
    password = open(os.environ["PWFILE_IN"]).read().strip().encode()  # hex: SASLprep is the identity
    salt = os.urandom(16)
    iterations = 4096
    salted = hashlib.pbkdf2_hmac("sha256", password, salt, iterations, 32)
    client_key = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    stored_key = hashlib.sha256(client_key).digest()
    server_key = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
    b64 = lambda b: base64.b64encode(b).decode()
    verifier = f"SCRAM-SHA-256${iterations}:{b64(salt)}${b64(stored_key)}:{b64(server_key)}"
    open(os.environ["VERIFIER_OUT"], "w").write(verifier + "\n")
PY
chmod 600 "$tmp/svc"
if [[ $preset -eq 0 ]]; then chmod 600 "$verifierfile"; fi

PGSERVICEFILE="$tmp/svc" "$psql_bin" -X -q --single-transaction -v ON_ERROR_STOP=1 -f "$sql_file" "service=owner" >/dev/null

if [[ $preset -eq 1 ]]; then
  echo "studio_gov_ro configured (password preset: untouched, no url written)"
  exit 0
fi

# Build the GOV_RO url with bash string operations only (no argv exposure), keep the owner's host/db/params.
raw=$(<"$owner_file"); pw=$(<"$pwfile")
scheme=${raw%%://*}://
rest=${raw#*://}
authority=${rest%%/*}
rest=${authority##*@}${rest#"$authority"}   # drop any userinfo; host, db and params stay
( umask 077; printf '%s%s:%s@%s\n' "$scheme" studio_gov_ro "$pw" "$rest" > "$out_file" )
chmod 600 "$out_file"
echo "studio_gov_ro configured; url written to $out_file (mode 600)"
