#!/usr/bin/env bash
# Neon API v2 helper for the Studio roles. The roles themselves are created BY SQL (run-roles.sh): roles
# created through the API get neon_superuser, which a non-superuser owner cannot revoke. The API is used
# only to list ids (`discover`) and to have NEON issue the password (`reset-password`): the password is
# generated server-side, returned once, and goes straight from curl through jq into a 0600 file. It is
# never printed, never on argv, never in the environment.
#
#   neon-role.sh discover       API_KEY_FILE
#   neon-role.sh resolve        API_KEY_FILE PROJECT                      branch ids/names + endpoint ids/hosts of one project (no secrets)
#   neon-role.sh role-auth      API_KEY_FILE PROJECT BRANCH ROLE          prints the role's authentication_method as the API reports it
#                                                                         (`no_login` = NOLOGIN, no password yet); exit 4 if the role is not visible
#   neon-role.sh reset-password API_KEY_FILE PROJECT BRANCH ROLE OUT_FILE [--dsn-from OWNER_URL_FILE [--host auto|pooled]]
#   (--allow-disk-tmp may precede the subcommand)
#   PROJECT is an id, or @FILE: a 0600/0400 file holding the id, or a dotenv line NEON_PROJECT_ID=... (what `vercel env pull` writes
#   for the even-cdmss project, so a second Neon project needs no code change). The file is never echoed: it may hold other secrets.
#   BRANCH is an id, or `auto`: the project's default branch (or its only branch); anything ambiguous exits 2 and changes nothing.
#   --host auto|pooled (needs --dsn-from) replaces the owner url's host with the API-discovered read_write endpoint of the branch
#   (`pooled` inserts -pooler after the first label, Neon's pooled-host convention); without it the owner url's host is kept.
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

usage() { echo "usage: $0 [--allow-disk-tmp] discover KEYFILE | resolve KEYFILE PROJECT | role-auth KEYFILE PROJECT|@FILE BRANCH|auto ROLE | reset-password KEYFILE PROJECT|@FILE BRANCH|auto ROLE OUT [--dsn-from OWNER_URL_FILE [--host auto|pooled]]" >&2; exit 2; }

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
api() { # api METHOD PATH [JSON_BODY]  -> response body on stdout. Non-2xx: curl --fail semantics (rc 22, nothing on stdout), but the
        # HTTP status and the API's error `message` are logged to stderr so a 422 is diagnosable. The message passes the same
        # filter as the wrappers' logs (urls, "password", bearer, token, secret lines dropped; printable characters only).
  local method=$1 path=$2 body=${3:-} out="$tmp/resp.$$.$RANDOM" code rc msg
  local args=(-sS --config "$cfg" -H 'Accept: application/json' -X "$method" -o "$out" -w '%{http_code}')
  if [[ -n $body ]]; then args+=(-H 'Content-Type: application/json' --data "$body"); fi
  code=$(curl "${args[@]}" "$api_base$path"); rc=$?
  if [[ $rc -ne 0 ]]; then shred -u "$out" 2>/dev/null || rm -f "$out"; return "$rc"; fi
  if [[ $code =~ ^2[0-9][0-9]$ ]]; then cat "$out"; shred -u "$out" 2>/dev/null || rm -f "$out"; return 0; fi
  msg=$(jq -r '.message // empty' "$out" 2>/dev/null | head -c 400 | tr -cd '[:print:]\n' | { grep -viE 'postgres(ql)?://|bearer|token|secret' || true; } | sed -E 's/[A-Za-z0-9_+/=-]{16,}/[redacted]/g; s/[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]/pw/g' | head -n 3 | tr '\n' ' ')
  if [[ -z ${msg// /} ]] && [[ -n $(jq -r '.message // empty' "$out" 2>/dev/null | head -c 1) ]]; then msg="(message withheld: it contained a filtered word)"; fi
  shred -u "$out" 2>/dev/null || rm -f "$out"
  echo "Neon API $method ${path//password/pw} -> HTTP $code${msg:+: $msg}" >&2   # (reset_password shown as reset_pw: the wrappers' log filter drops lines with the word)
  return 22
}

valid_id() { [[ $1 =~ ^[A-Za-z0-9._-]{1,128}$ ]]; }

# project_id ARG: ARG itself, or the id inside @FILE (bare token, or a NEON_PROJECT_ID= dotenv line). Prints the id only.
project_id() {
  local a=$1 f v
  if [[ $a != @* ]]; then printf '%s' "$a"; return 0; fi
  f=${a#@}
  [[ -f $f && -r $f ]] || { echo "project file not readable" >&2; return 2; }
  [[ $(stat -c '%a' "$f") == 600 || $(stat -c '%a' "$f") == 400 ]] || { echo "project file must be mode 600 (it may hold other secrets)" >&2; return 2; }
  v=$(sed -n 's/^NEON_PROJECT_ID=//p' "$f" | head -n 1 | tr -d "\"'\r ")
  if [[ -z $v ]]; then v=$(grep -c . "$f" | grep -qx 1 && tr -d "\"'\r \n" < "$f" || true); fi
  [[ -n $v ]] || { echo "no NEON_PROJECT_ID in the project file" >&2; return 2; }
  printf '%s' "$v"
}

# resolve_branch PROJECT ARG: ARG itself, or `auto` = the default branch (else the only branch). Ids only.
resolve_branch() {
  local project=$1 a=$2 ids n
  if [[ $a != auto ]]; then printf '%s' "$a"; return 0; fi
  ids=$(api GET "/projects/$project/branches" | jq -r '[.branches[]? | select(.default == true or .primary == true)] as $d
        | (if ($d | length) >= 1 then $d else [.branches[]?] end) | .[].id')
  n=$(printf '%s\n' "$ids" | grep -c . || true)
  if [[ $n != 1 ]]; then echo "cannot pick a branch automatically ($n candidates): pass the branch id" >&2; return 2; fi
  printf '%s' "$ids"
}

# endpoint_host PROJECT BRANCH: host of the branch's read_write endpoint (exactly one required).
endpoint_host() {
  local hosts n
  hosts=$(api GET "/projects/$1/endpoints" | jq -r --arg b "$2" '.endpoints[]? | select(.branch_id == $b and .type == "read_write") | .host')
  n=$(printf '%s\n' "$hosts" | grep -c . || true)
  if [[ $n != 1 ]]; then echo "expected exactly one read_write endpoint for the branch, found $n" >&2; return 2; fi
  [[ $hosts =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || { echo "endpoint host has an unexpected shape" >&2; return 2; }
  printf '%s' "$hosts"
}
valid_role() { [[ $1 =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; }

case $cmd in
  discover)
    [[ $# -eq 0 ]] || usage
    # Ids, names and role names only.
    projects=$(api GET "/projects?limit=400" | jq -r '.projects[]? | [.id, .name] | @tsv')
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
  resolve)
    [[ $# -eq 1 ]] || usage
    project=$(project_id "$1") || exit 2
    valid_id "$project" || { echo "invalid project id" >&2; exit 2; }
    api GET "/projects/$project/branches" | jq -r '.branches[]? | ["branch", .id, (.name // ""), (if (.default or .primary) then "default" else "-" end)] | @tsv' | tr -c 'A-Za-z0-9._\t\n/-' '?'
    api GET "/projects/$project/endpoints" | jq -r '.endpoints[]? | ["endpoint", .id, .branch_id, .type, .host] | @tsv' | tr -c 'A-Za-z0-9._\t\n/-' '?'
    ;;
  role-auth)
    [[ $# -eq 3 ]] || usage
    project=$(project_id "$1") || exit 2
    valid_id "$project" || { echo "invalid project id" >&2; exit 2; }
    branch=$(resolve_branch "$project" "$2") || exit 2
    valid_id "$branch" || { echo "invalid branch id" >&2; exit 2; }
    valid_role "$3" || { echo "invalid role name" >&2; exit 2; }
    method=$(api GET "/projects/$project/branches/$branch/roles" | jq -r --arg r "$3" '[.roles[]? | select(.name == $r)] | if length == 1 then (.[0].authentication_method // "unknown") else "NOT_VISIBLE" end')
    [[ $method != NOT_VISIBLE ]] || { echo "role not visible to Neon API: $3 (nothing changed)" >&2; exit 4; }
    [[ $method =~ ^[a-z0-9_-]{1,40}$ ]] || method=unknown
    echo "$method"
    ;;
  reset-password)
    [[ $# -ge 4 ]] || usage
    project=$1; branch=$2; role=$3; out_file=$4; shift 4
    dsn_from= host_mode=
    while [[ $# -gt 0 ]]; do
      case $1 in
        --dsn-from) dsn_from=${2:-}; shift 2 || usage ;;
        --host) host_mode=${2:-}; shift 2 || usage ;;
        *) usage ;;
      esac
    done
    [[ -z $host_mode || ( -n $dsn_from && ( $host_mode == auto || $host_mode == pooled ) ) ]] || { echo "--host auto|pooled needs --dsn-from" >&2; exit 2; }
    project=$(project_id "$project") || exit 2
    valid_id "$project" || { echo "invalid project id" >&2; exit 2; }
    branch=$(resolve_branch "$project" "$branch") || exit 2
    if ! valid_id "$branch"; then echo "invalid project or branch id" >&2; exit 2; fi
    if [[ -n $host_mode ]]; then
      new_host=$(endpoint_host "$project" "$branch") || exit 2
      [[ $host_mode == pooled ]] && new_host=${new_host%%.*}-pooler.${new_host#*.}
    fi
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
      if [[ -n $host_mode ]]; then rest=$new_host/${rest#*/}; fi
      "${resp_cmd[@]}" | jq -r --arg s "$scheme" --arg r "$role" --arg rest "$rest" \
        'select(.role.password) | $s + $r + ":" + (.role.password | @uri) + "@" + $rest' > "$out_file"
    fi
    [[ -s $out_file ]] || { echo "the API response held no password" >&2; exit 1; }
    out_created=
    echo "reset-password ok for role $role; secret written to $out_file (mode 600)"
    ;;
  *) usage ;;
esac
