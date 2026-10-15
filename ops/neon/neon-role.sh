#!/usr/bin/env bash
# Neon API v2 helper for the Studio roles. The roles themselves are created BY SQL (run-roles.sh): roles
# created through the API get neon_superuser, which a non-superuser owner cannot revoke. The API is used
# only to list ids (`discover`) and to have NEON issue the password (`reset-password`): the password is
# generated server-side, returned once, and goes straight from curl through jq into a 0600 file. It is
# never printed, never on argv, never in the environment.
#
#   neon-role.sh discover       API_KEY_FILE
#   neon-role.sh reset-password API_KEY_FILE PROJECT_ID BRANCH_ID ROLE OUT_FILE [--dsn-from OWNER_URL_FILE]
#   (--allow-disk-tmp may precede the subcommand)
#
# reset-password first lists the branch's roles: if ROLE is not visible to the API the script exits 4
# ("role not visible to Neon API") and changes NOTHING (no reset call is made).
# API_KEY_FILE: 0600 file holding the Neon API key (never pass the key itself). It reaches curl only as a
# `header = ...` line in a 0600 curl config on tmpfs ($XDG_RUNTIME_DIR, else /dev/shm; a disk-backed temp dir
# is refused unless --allow-disk-tmp). OUT_FILE (0600, must not exist) holds ONLY the password, or with
# --dsn-from the full DSN: the owner url's scheme/host/database/params with the role and the new password.
# `discover` prints project ids/names, branch ids/names and role names only: nothing else, no secrets.
# Env: NEON_API_BASE (default https://console.neon.tech/api/v2; http only for exactly 127.0.0.1 or localhost),
#      STUDIO_ROLES_SHM (tmpfs fallback dir, default /dev/shm).
set -euo pipefail
umask 077

usage() { echo "usage: $0 [--allow-disk-tmp] discover KEYFILE | reset-password KEYFILE PROJECT BRANCH ROLE OUT [--dsn-from OWNER_URL_FILE]" >&2; exit 2; }

allow_disk=0
if [[ ${1:-} == --allow-disk-tmp ]]; then allow_disk=1; shift; fi
cmd=${1:-}; [[ -n $cmd ]] || usage
shift

api_base=${NEON_API_BASE:-https://console.neon.tech/api/v2}
# Strict parse (no prefix globs): https with a plain host, or http ONLY for exactly 127.0.0.1 / localhost
# (optional :port); no userinfo, no '@', no extra host characters, no query or fragment.
path_re='(/[A-Za-z0-9._~/-]*)?'
if [[ $api_base =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?${path_re}$ ]]; then :
elif [[ $api_base =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?${path_re}$ ]]; then :
else echo "NEON_API_BASE must be https://host[:port][/path], or http only for exactly 127.0.0.1 or localhost (no userinfo)" >&2; exit 2
fi
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 2; }

key_file=${1:-}
[[ -n $key_file && -f $key_file && -r $key_file ]] || { echo "API key file not readable" >&2; exit 2; }
shift
mode=$(stat -c '%a' "$key_file")
[[ $mode == 600 || $mode == 400 ]] || { echo "API key file must be mode 600 (is $mode)" >&2; exit 2; }

tmpbase=
for d in "${XDG_RUNTIME_DIR:-}" "${STUDIO_ROLES_SHM:-/dev/shm}"; do
  if [[ -n $d && -d $d && -w $d ]]; then tmpbase=$d; break; fi
done
if [[ -z $tmpbase ]]; then
  [[ $allow_disk -eq 1 ]] || { echo "no tmpfs temp dir; refusing to put secrets on disk (use --allow-disk-tmp to override)" >&2; exit 2; }
  tmpbase=${TMPDIR:-/tmp}
fi
tmp=$(mktemp -d "$tmpbase/neon-role.XXXXXX")
out_created=
cleanup() {
  local rc=$?
  local f
  for f in "$tmp"/*; do
    if [[ -f $f ]]; then shred -u "$f" 2>/dev/null || rm -f "$f"; fi
  done
  rmdir "$tmp" 2>/dev/null || true
  # A failed or interrupted run must not leave an (empty or partial) output behind. If the reset call was
  # already made, the password was rotated server-side and is lost: the runbook says reset again.
  if [[ $rc -ne 0 && -n $out_created && -f $out_created ]]; then shred -u "$out_created" 2>/dev/null || rm -f "$out_created"; fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# curl config: the Authorization header lives only here (0600, tmpfs), never on argv.
cfg="$tmp/curl.cfg"
{ printf 'header = "Authorization: Bearer '; tr -d '\r\n' < "$key_file"; printf '"\n'; } > "$cfg"
chmod 600 "$cfg"
api() { # api METHOD PATH [JSON_BODY]  -> response body on stdout; non-2xx fails (curl --fail), body not shown
  local method=$1 path=$2 body=${3:-}
  if [[ -n $body ]]; then
    curl -sS --fail --config "$cfg" -H 'Accept: application/json' -H 'Content-Type: application/json' -X "$method" --data "$body" "$api_base$path"
  else
    curl -sS --fail --config "$cfg" -H 'Accept: application/json' -X "$method" "$api_base$path"
  fi
}

valid_id() { [[ $1 =~ ^[A-Za-z0-9._-]{1,128}$ ]]; }
valid_role() { [[ $1 =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; }

case $cmd in
  discover)
    [[ $# -eq 0 ]] || usage
    # Ids, names and role names only.
    projects=$(api GET /projects | jq -r '.projects[]? | [.id, .name] | @tsv')
    [[ -n $projects ]] || { echo "no projects visible to this key" >&2; exit 1; }
    while IFS=$'\t' read -r pid pname; do
      valid_id "$pid" || continue
      echo "project $pid  ${pname//[^A-Za-z0-9 ._-]/?}"
      api GET "/projects/$pid/branches" | jq -r '.branches[]? | [.id, .name] | @tsv' | while IFS=$'\t' read -r bid bname; do
        valid_id "$bid" || continue
        echo "  branch $bid  ${bname//[^A-Za-z0-9 ._\/-]/?}"
        echo "    roles: $(api GET "/projects/$pid/branches/$bid/roles" | jq -r '[.roles[]?.name] | join(", ")')"
      done
    done <<< "$projects"
    ;;
  reset-password)
    [[ $# -ge 4 ]] || usage
    project=$1; branch=$2; role=$3; out_file=$4; shift 4
    dsn_from=
    if [[ ${1:-} == --dsn-from ]]; then dsn_from=${2:-}; shift 2 || usage; fi
    [[ $# -eq 0 ]] || usage
    if ! valid_id "$project" || ! valid_id "$branch"; then echo "invalid project or branch id" >&2; exit 2; fi
    valid_role "$role" || { echo "invalid role name" >&2; exit 2; }
    [[ ! -e $out_file ]] || { echo "refusing to overwrite $out_file" >&2; exit 2; }
    if [[ -n $dsn_from ]]; then [[ -f $dsn_from && -r $dsn_from ]] || { echo "owner url file not readable" >&2; exit 2; }; fi
    out_created=$out_file
    : > "$out_file"; chmod 600 "$out_file"
    # Visibility first: a role the API cannot see is left alone (no reset call), exit 4.
    visible=$(api GET "/projects/$project/branches/$branch/roles" | jq -r --arg r "$role" '[.roles[]? | select(.name == $r)] | length')
    if [[ $visible != 1 ]]; then
      echo "role not visible to Neon API: $role (nothing changed)" >&2
      exit 4
    fi
    resp_cmd=(api POST "/projects/$project/branches/$branch/roles/$role/reset_password")
    if [[ -z $dsn_from ]]; then
      "${resp_cmd[@]}" | jq -r '.role.password // empty' > "$out_file"
    else
      # Full DSN: owner url's scheme, host, db and params with the new role + (uri-encoded) password.
      raw=$(<"$dsn_from")
      scheme=${raw%%://*}://
      rest=${raw#*://}
      authority=${rest%%/*}
      rest=${authority##*@}${rest#"$authority"}
      "${resp_cmd[@]}" | jq -r --arg s "$scheme" --arg r "$role" --arg rest "$rest" \
        'select(.role.password) | $s + $r + ":" + (.role.password | @uri) + "@" + $rest' > "$out_file"
    fi
    [[ -s $out_file ]] || { echo "the API response held no password" >&2; exit 1; }
    out_created=
    echo "reset-password ok for role $role; secret written to $out_file (mode 600)"
    ;;
  *) usage ;;
esac
