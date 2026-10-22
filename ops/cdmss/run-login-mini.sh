#!/usr/bin/env bash
# CDMSS LOGIN step, run ON THE MAC MINI (macOS). Issues the studio_cdmss_ro password through the Neon API, enables LOGIN, and
# leaves the password-bearing URL as ONE 0600 file on a RAM disk for the later relay lane (which moves it to the Asus).
#
#   ops/cdmss/run-login-mini.sh            issue password + enable LOGIN; prints only status lines and the relay file path
#   ops/cdmss/run-login-mini.sh --detach   after the relay lane has taken the file: rm -P it and detach the RAM disk
#   ops/cdmss/run-login-mini.sh --nologin  rotation step 0: pulls the owner url onto a fresh RAM disk (same pooled refusal), runs
#                                          run-roles.sh --role studio_cdmss_ro --nologin, wipes everything and detaches
#
# Modelled on the two working Mini scripts (cdmss_ro_run.sh, apply_view_mig.sh): GNU coreutils first in PATH, umask 077, owner
# DIRECT url + NEON_PROJECT_ID pulled from the Vercel API (project even-cdmss, env DATABASE_URL_UNPOOLED / NEON_PROJECT_ID; token
# from ~/Library/Application Support/com.vercel.cli/auth.json) straight into 0600 files on a RAM disk (python, no argv), Neon API
# key read in place from ~/oc/gov-orch/secrets/neon-api-key (mode 600). A POOLED owner url is refused before anything runs.
# Then: neon-role.sh reset-password ... ; run-roles.sh --role studio_cdmss_ro --login (LOGIN + the cdmss post-check, one txn).
# Every exit path (also HUP/INT/TERM) rm -P's the secrets and detaches the RAM disk, EXCEPT the relay URL on success, which stays on
# the still-attached RAM disk until --detach. Detail goes to the log (filtered of URLs and "password"), never to the terminal.
# The relay url's host is the branch's read_write endpoint from the API (--host auto), fixed in production.
# Test-only overrides: honoured ONLY with LOGIN_MINI_TEST=1; in any other run the script REFUSES TO START (exit 2) if one is set.
# Named: LOGIN_MINI_REPO LOGIN_MINI_SKIP_GIT LOGIN_MINI_MOUNT LOGIN_MINI_SECURE_RM LOGIN_MINI_AUTH_JSON LOGIN_MINI_NEON_KEY LOGIN_MINI_LOG
# LOGIN_MINI_RELAY_HOST LOGIN_MINI_NOT_MAC VERCEL_API_BASE NEON_API_BASE SQL_FILE PSQL CDMSS_POSTCHECK_SQL CDMSS_ALLOW_TEST_POSTCHECK
# STUDIO_ROLES_SHM XDG_RUNTIME_DIR; and every variable that redirects a host, file or binary under the tools it runs: PG* (libpq),
# CURL_* and the proxy variables, PYTHON*, GIT_*, BASH_ENV, ENV, LD_*, DYLD_*. (HOME and PATH are not refused: the script needs them.)
set -uo pipefail
umask 077

TEST=${LOGIN_MINI_TEST:-0}
if [[ $TEST != 1 ]]; then
  for v in LOGIN_MINI_REPO LOGIN_MINI_SKIP_GIT LOGIN_MINI_MOUNT LOGIN_MINI_SECURE_RM LOGIN_MINI_AUTH_JSON LOGIN_MINI_NEON_KEY LOGIN_MINI_LOG \
           LOGIN_MINI_RELAY_HOST LOGIN_MINI_NOT_MAC VERCEL_API_BASE NEON_API_BASE SQL_FILE PSQL CDMSS_POSTCHECK_SQL CDMSS_ALLOW_TEST_POSTCHECK \
           STUDIO_ROLES_SHM XDG_RUNTIME_DIR BASH_ENV ENV; do
    if [[ -n ${!v:-} ]]; then echo "$v is a test-only override: refusing (set LOGIN_MINI_TEST=1 only in tests)" >&2; exit 2; fi
  done
  for v in $(env | cut -d= -f1); do
    case $v in
      PG[A-Z]*|CURL_*|*_proxy|*_PROXY|PYTHON[A-Z]*|GIT_*|LD_*|DYLD_*)
        if [[ -n ${!v:-} ]]; then echo "$v redirects a host, file or binary: refusing (unset it)" >&2; exit 2; fi ;;
    esac
  done
  [[ $(uname -s) == Darwin ]] || { echo "this script is for the Mac Mini (macOS)" >&2; exit 2; }
fi

REPO=${LOGIN_MINI_REPO:-$HOME/oc/gov-orch/wt-banner}
MOUNT=${LOGIN_MINI_MOUNT:-/Volumes/cdmssloginram}
VOLNAME=$(basename "$MOUNT")
SECURE_RM=${LOGIN_MINI_SECURE_RM:-/bin/rm -P}
AUTH_JSON=${LOGIN_MINI_AUTH_JSON:-$HOME/Library/Application Support/com.vercel.cli/auth.json}
NEON_KEY=${LOGIN_MINI_NEON_KEY:-$HOME/oc/gov-orch/secrets/neon-api-key}
API_BASE=${VERCEL_API_BASE:-https://api.vercel.com}
TEAM=team_yu1wWpsKdjsf90haai1ETJDG
VPROJECT=even-cdmss
ROLE=studio_cdmss_ro
LOG=${LOGIN_MINI_LOG:-$HOME/oc/gov-orch/scratch/cdmss-login.log}
HOSTMODE=${LOGIN_MINI_RELAY_HOST:-auto}   # only settable in tests (refused above otherwise)
case $HOSTMODE in auto|pooled|owner) ;; *) echo "LOGIN_MINI_RELAY_HOST must be auto, pooled or owner" >&2; exit 2 ;; esac

export PATH=/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH
stat -c '%a' / >/dev/null 2>&1 || { echo "GNU coreutils stat not first in PATH (brew install coreutils): the Neon scripts need stat -c" >&2; exit 2; }
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

secure_rm() { # secure_rm FILE...  (rm -P on macOS; a failure to wipe must not stop the detach)
  local f
  for f in "$@"; do [[ -e $f ]] && $SECURE_RM "$f" 2>/dev/null; done
  return 0
}

if [[ ${1:-} == --detach ]]; then
  [[ -d $MOUNT ]] || { echo "no RAM disk at $MOUNT (nothing to detach)"; exit 0; }
  dev=$(cat "$MOUNT/.device" 2>/dev/null || true)
  secure_rm "$MOUNT/relay-url" "$MOUNT/owner-url" "$MOUNT/project.env" "$MOUNT/py.err" "$MOUNT/.device"
  if [[ -n $dev ]]; then hdiutil detach "$dev" >/dev/null 2>&1 || hdiutil detach -force "$dev" >/dev/null 2>&1; fi
  echo "detached $MOUNT"; exit 0
fi
MODE=login
if [[ ${1:-} == --nologin ]]; then MODE=nologin; shift; fi
[[ $# -eq 0 ]] || { echo "usage: $0 [--detach|--nologin]" >&2; exit 2; }

[[ -f $AUTH_JSON && -r $AUTH_JSON ]] || { echo "Vercel auth.json not readable" >&2; exit 2; }
[[ -f $NEON_KEY && -r $NEON_KEY && $(stat -c '%a' "$NEON_KEY") == 600 ]] || { echo "Neon API key file missing or not mode 600" >&2; exit 2; }
[[ ! -e $MOUNT ]] || { echo "$MOUNT already exists (an earlier run's RAM disk?): run $0 --detach first" >&2; exit 2; }
if [[ $TEST != 1 || ${LOGIN_MINI_SKIP_GIT:-0} != 1 ]]; then
  [[ -d $REPO ]] || { echo "repo checkout $REPO missing" >&2; exit 2; }
fi

DEV=
KEEP_RELAY=0
cleanup() {
  local rc=$?
  trap - EXIT HUP INT TERM
  if [[ -d $MOUNT ]]; then
    secure_rm "$MOUNT/owner-url" "$MOUNT/project.env" "$MOUNT/py.err"
    if [[ $rc -eq 0 && $KEEP_RELAY -eq 1 ]]; then
      :                                   # success: relay-url stays on the attached RAM disk for the relay lane
    else
      secure_rm "$MOUNT/relay-url" "$MOUNT/.device"
      [[ -z $DEV ]] || hdiutil detach "$DEV" >/dev/null 2>&1 || hdiutil detach -force "$DEV" >/dev/null 2>&1
    fi
  elif [[ -n $DEV ]]; then
    hdiutil detach "$DEV" >/dev/null 2>&1 || hdiutil detach -force "$DEV" >/dev/null 2>&1
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

: > "$LOG" 2>/dev/null || LOG=/dev/null
note() { echo "$*" >> "$LOG"; }
# Everything that reaches the on-disk log goes through this: urls, "password", bearer and token lines are dropped.
filter() { grep -viE 'postgres(ql)?://|password|bearer|token' || true; }

if [[ $TEST != 1 || ${LOGIN_MINI_SKIP_GIT:-0} != 1 ]]; then
  ( cd "$REPO" && git fetch -q origin && git checkout -q --detach origin/main ) >> "$LOG" 2>&1 || { echo "git fetch/checkout in $REPO failed (see $LOG)" >&2; exit 2; }
fi

DEV=$(hdiutil attach -nomount ram://65536 | awk '{print $1}')
[[ -n $DEV ]] || { echo "hdiutil attach failed" >&2; exit 2; }
diskutil erasevolume HFS+ "$VOLNAME" "$DEV" >/dev/null || { echo "diskutil erasevolume failed" >&2; exit 2; }
[[ -d $MOUNT ]] || { echo "RAM disk did not mount at $MOUNT" >&2; exit 2; }
printf '%s' "$DEV" > "$MOUNT/.device"
export XDG_RUNTIME_DIR=$MOUNT STUDIO_ROLES_SHM=$MOUNT

# Owner DIRECT url + NEON_PROJECT_ID from the Vercel API, written by python straight to 0600 files (no argv, no stdout).
AUTH_JSON=$AUTH_JSON API_BASE=$API_BASE TEAM=$TEAM VPROJECT=$VPROJECT python3 - "$MOUNT/owner-url" "$MOUNT/project.env" <<'PY' 2>"$MOUNT/py.err"
import json, os, sys, urllib.parse, urllib.request

tok = json.load(open(os.environ["AUTH_JSON"]))["token"]
base, team, proj = os.environ["API_BASE"], os.environ["TEAM"], os.environ["VPROJECT"]
hdr = {"Authorization": "Bearer " + tok}

def get(path):
    return json.load(urllib.request.urlopen(urllib.request.Request(base + path, headers=hdr), timeout=30))

q = "teamId=" + urllib.parse.quote(team)
envs = get(f"/v9/projects/{urllib.parse.quote(proj)}/env?{q}")["envs"]

def value(key):
    hits = [e for e in envs if e["key"] == key and "production" in e.get("target", [])]
    if len(hits) != 1:
        sys.exit(f"expected exactly one production env {key}, found {len(hits)}")
    return get(f"/v1/projects/{urllib.parse.quote(proj)}/env/{hits[0]['id']}?{q}")["value"]

def write(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.write(fd, text.encode())
    os.close(fd)

write(sys.argv[1], value("DATABASE_URL_UNPOOLED"))
write(sys.argv[2], "NEON_PROJECT_ID=" + value("NEON_PROJECT_ID") + "\n")
PY
rc=$?
filter < "$MOUNT/py.err" >> "$LOG"; secure_rm "$MOUNT/py.err"   # python's stderr is filtered like stdout before it touches the disk log
[[ $rc -eq 0 && -s $MOUNT/owner-url && -s $MOUNT/project.env ]] || { echo "could not pull the owner url / NEON_PROJECT_ID from Vercel (see $LOG)" >&2; exit 2; }
chmod 600 "$MOUNT/owner-url" "$MOUNT/project.env"

# Refuse a POOLED owner url BEFORE running anything: the post-check needs the database owner on a direct connection.
raw=$(<"$MOUNT/owner-url")
rest=${raw#*://}; authority=${rest%%/*}; host=${authority##*@}; host=${host%%:*}
if [[ $raw != postgres*://* ]]; then echo "owner url is not a postgres url: refusing" >&2; exit 3; fi
if [[ $host == *-pooler* || $raw == *pgbouncer=true* ]]; then
  echo "owner url is a POOLED url (DATABASE_URL_UNPOOLED must be direct): refusing, nothing was run" >&2; exit 3
fi
unset raw rest authority host

if [[ $MODE == nologin ]]; then
  "$REPO/ops/neon/run-roles.sh" --role "$ROLE" --nologin "$MOUNT/owner-url" 2>&1 | filter | tail -20 >> "$LOG"
  rc=${PIPESTATUS[0]}
  if [[ $rc -ne 0 ]]; then echo "run-roles --nologin FAILED rc=$rc (rc 5 = live sessions could not be ended; see $LOG)" >&2; exit "$rc"; fi
  echo "OK $ROLE set NOLOGIN (live sessions ended); RAM disk wiped and detached. Next: $0"; exit 0
fi

host_flag=()
case $HOSTMODE in auto|pooled) host_flag=(--host "$HOSTMODE") ;; esac
"$REPO/ops/neon/neon-role.sh" reset-password "$NEON_KEY" "@$MOUNT/project.env" auto "$ROLE" "$MOUNT/relay-url" \
    --dsn-from "$MOUNT/owner-url" ${host_flag[@]+"${host_flag[@]}"} 2>&1 | filter | tail -20 >> "$LOG"
rc=${PIPESTATUS[0]}
if [[ $rc -ne 0 ]]; then
  [[ $rc -eq 4 ]] && echo "Neon API cannot see $ROLE (SQL-created role): nothing changed; tell gov-orch" >&2
  echo "reset-password FAILED rc=$rc (see $LOG)" >&2; exit "$rc"
fi
note "reset-password ok"

"$REPO/ops/neon/run-roles.sh" --role "$ROLE" --login "$MOUNT/owner-url" 2>&1 | filter | tail -20 >> "$LOG"
rc=${PIPESTATUS[0]}
if [[ $rc -ne 0 ]]; then echo "run-roles --login FAILED rc=$rc, role contained NOLOGIN (see $LOG)" >&2; exit "$rc"; fi

[[ -s $MOUNT/relay-url && $(stat -c '%a' "$MOUNT/relay-url") == 600 ]] || { echo "relay url file missing or not mode 600" >&2; exit 1; }
KEEP_RELAY=1
echo "OK $ROLE LOGIN enabled; relay URL file: $MOUNT/relay-url (mode 600, RAM disk $DEV stays attached; after the relay lane has moved it: $0 --detach)"
