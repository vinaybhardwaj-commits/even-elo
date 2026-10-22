#!/bin/bash -p
# CDMSS RELAY step, run ON THE MAC MINI (macOS, bash 3.2). Moves the studio_cdmss_ro URL from the RAM disk that run-login-mini.sh left
# (/Volumes/cdmssloginram/relay-url, mode 600) to the Asus studio agent's Neon relay, verifies it there, and then wipes the Mini copy.
#
#   ops/cdmss/relay-install.sh             stream the url over ssh stdin, install, verify as studio-agent, then run-login-mini.sh --detach
#   ops/cdmss/relay-install.sh --rollback  remove everything the install put on the Asus (url, relay password, env line, pinned host)
#
# Invoke like run-login-mini.sh (clean env, clean bash):
#   /usr/bin/env -i HOME=$HOME PATH=/usr/bin:/bin /bin/bash --noprofile --norc ops/cdmss/relay-install.sh
#
# How: the Asus-side logic is ops/cdmss/asus-relay-apply.sh. It is sent INSIDE the ssh command line (base64; it is not secret) as
# `sudo -n bash -c "<script>" relay-apply install`, and the URL is the ssh STDIN, read straight from the RAM-disk file: it is never in argv,
# never in a variable of this script, never in a file on the Mini or (outside /etc/studio-pgrelay/neon.env, 0600 root:root, where the gov
# DSN already lives) on the Asus. Only lines the Asus script prints with the fixed prefix "asus " are shown or logged, minus anything shaped
# like a URL. The detach (rm -P of relay-url and hdiutil detach) runs ONLY after the Asus reported "relay ready"; on any failure the Asus
# script has restored its previous state (and this script asks for a rollback once more if the ssh link itself broke) and the RAM disk stays
# attached for a retry: run it again, or `run-login-mini.sh --detach` to give up (and --nologin to disable the role).
# Exit: 0 done and wiped; 2 refused (usage/environment/missing file); 3 relay-url unusable; 5 the Asus install failed (rolled back);
# 6 ssh could not reach the Asus; 4 installed but the RAM disk could not be detached; 9 a rollback was incomplete.
# Test-only overrides (honoured ONLY with RELAY_INSTALL_TEST=1; any other run REFUSES TO START if one is set):
#   RELAY_INSTALL_MOUNT RELAY_INSTALL_SSH RELAY_INSTALL_ASUS RELAY_INSTALL_APPLY RELAY_INSTALL_LOGIN_MINI RELAY_INSTALL_LOG RELAY_INSTALL_NOT_MAC
# plus the same refusal list as run-login-mini.sh (shell tracing/startup variables; PG*, CURL_*, proxies, PYTHON*, GIT_*, LD_*, DYLD_*,
# SSH_ASKPASS*, SUDO_*): see run-login-mini.sh for the two-layer environment allowlist (v5), which this script copies.
if [ "${RELAY_INSTALL_REEXEC:-}" != "$$" ]; then
  set +x
  _t=${RELAY_INSTALL_TEST:-0}; _seen=; _bad=0; _fn=0; _odd=0
  _names=$(compgen -e) || _bad=1
  for _v in $_names; do
    [[ $_v =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { _bad=1; continue; }
    [ -n "${!_v:-}" ] && _seen="$_seen $_v"
  done
  [ -n "$(compgen -A function)" ] && _fn=1
  _odd=$(env | grep -vc '^[A-Za-z_][A-Za-z0-9_]*=') || true
  _args=("RELAY_INSTALL_REEXEC=$$" "RELAY_INSTALL_SEEN=$_seen" "RELAY_INSTALL_SCAN=bad=$_bad odd=$_odd fn=$_fn")
  if [ "$_t" = 1 ]; then
    _args+=("RELAY_INSTALL_TEST=1" "PATH=$PATH")
    for _v in RELAY_INSTALL_MOUNT RELAY_INSTALL_SSH RELAY_INSTALL_ASUS RELAY_INSTALL_APPLY RELAY_INSTALL_LOGIN_MINI RELAY_INSTALL_LOG \
              RELAY_INSTALL_NOT_MAC; do
      [ -n "${!_v:-}" ] && _args+=("$_v=${!_v}")
    done
  else
    _args+=("PATH=/opt/homebrew/opt/coreutils/libexec/gnubin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin")
  fi
  for _v in HOME USER LOGNAME LANG TERM; do [ -n "${!_v:-}" ] && _args+=("$_v=${!_v}"); done
  exec /usr/bin/env -i "${_args[@]}" /bin/bash --noprofile --norc -p "$0" "$@"
fi
set +x
set -uo pipefail
umask 077
SEEN=${RELAY_INSTALL_SEEN:-}; SCAN=${RELAY_INSTALL_SCAN:-bad=1 odd=0 fn=0}
unset RELAY_INSTALL_REEXEC RELAY_INSTALL_SEEN RELAY_INSTALL_SCAN

TEST=${RELAY_INSTALL_TEST:-0}
if [[ $TEST != 1 ]]; then
  # layer 2a: what the first layer saw and dropped
  for v in $SEEN; do
    [[ $v =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "environment holds an odd variable name: refusing" >&2; exit 2; }
    case $v in
      RELAY_INSTALL_*|BASH_ENV|ENV)
        [[ $v == RELAY_INSTALL_TEST ]] || { echo "$v is a test-only override: refusing (set RELAY_INSTALL_TEST=1 only in tests)" >&2; exit 2; } ;;
      SHELLOPTS|BASHOPTS|PS4|BASH_XTRACEFD|PROMPT_COMMAND)
        echo "$v (shell tracing/startup control) was in the environment: refusing" >&2; exit 2 ;;
      PG[A-Z]*|CURL_*|*_proxy|*_PROXY|PYTHON[A-Z]*|GIT_*|LD_*|DYLD_*|SSH_ASKPASS*|SUDO_*|SSH_ORIGINAL_COMMAND)
        echo "$v redirects a host, file or binary: refusing (unset it)" >&2; exit 2 ;;
    esac
  done
  case $SCAN in
    *"bad=0"*) ;; *) echo "cannot enumerate the environment cleanly: refusing" >&2; exit 2 ;;
  esac
  case $SCAN in *"fn=0"*) ;; *) echo "exported bash functions are in the environment (they can replace any command): refusing" >&2; exit 2 ;; esac
  case $SCAN in *"odd=0 "*) ;; *) echo "environment holds odd entries (newline in a value, or a non-identifier name): refusing" >&2; exit 2 ;; esac
  # layer 2b: tracing/startup variables that somehow survive in THIS shell's exported environment
  for v in SHELLOPTS BASHOPTS PS4 BASH_XTRACEFD BASH_ENV ENV; do
    if compgen -e | grep -qx "$v"; then echo "$v survived into the exported environment: refusing" >&2; exit 2; fi
  done
  # layer 2c: the previous scan of this shell's own environment
  for v in RELAY_INSTALL_MOUNT RELAY_INSTALL_SSH RELAY_INSTALL_ASUS RELAY_INSTALL_APPLY RELAY_INSTALL_LOGIN_MINI RELAY_INSTALL_LOG \
           RELAY_INSTALL_NOT_MAC BASH_ENV ENV; do
    if [[ -n ${!v:-} ]]; then echo "$v is a test-only override: refusing (set RELAY_INSTALL_TEST=1 only in tests)" >&2; exit 2; fi
  done
  # The scan fails CLOSED: any error, any odd name, any odd environment line exits 2 before anything else runs.
  if [[ -n $(compgen -A function) ]] || env | grep -q '^BASH_FUNC_'; then
    echo "exported bash functions are in the environment (they can replace any command): refusing" >&2; exit 2
  fi
  names=$(compgen -e) || { echo "cannot enumerate the environment: refusing" >&2; exit 2; }
  for v in $names; do
    [[ $v =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "environment holds an odd variable name: refusing" >&2; exit 2; }
    case $v in
      PG[A-Z]*|CURL_*|*_proxy|*_PROXY|PYTHON[A-Z]*|GIT_*|LD_*|DYLD_*|SSH_ASKPASS*|SUDO_*|SSH_ORIGINAL_COMMAND)
        if [[ -n ${!v:-} ]]; then echo "$v redirects a host, file or binary: refusing (unset it)" >&2; exit 2; fi ;;
    esac
  done
  # a value with a newline, or an entry whose name is not an identifier, shows up as an `env` line that does not start NAME=
  odd=$(env | grep -vc '^[A-Za-z_][A-Za-z0-9_]*=') ; [[ $odd == 0 ]] || { echo "environment holds odd entries (newline in a value, or a non-identifier name): refusing" >&2; exit 2; }
  [[ $(uname -s) == Darwin ]] || { echo "this script is for the Mac Mini (macOS)" >&2; exit 2; }
fi


MOUNT=${RELAY_INSTALL_MOUNT:-/Volumes/cdmssloginram}
ASUS=${RELAY_INSTALL_ASUS:-vinay@100.65.203.79}
SSH=${RELAY_INSTALL_SSH:-/usr/bin/ssh}
HERE=$(cd "$(dirname "$0")" && pwd)
APPLY=${RELAY_INSTALL_APPLY:-$HERE/asus-relay-apply.sh}
LOGIN_MINI=${RELAY_INSTALL_LOGIN_MINI:-$HERE/run-login-mini.sh}
LOG=${RELAY_INSTALL_LOG:-$HOME/oc/gov-orch/scratch/cdmss-relay.log}
RELAY_URL=$MOUNT/relay-url

export PATH=/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH
stat -c '%a' / >/dev/null 2>&1 || { echo "GNU coreutils stat not first in PATH (brew install coreutils)" >&2; exit 2; }
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
: > "$LOG" 2>/dev/null || LOG=/dev/null

MODE=install
case ${1:-} in
  "") ;;
  --rollback) MODE=rollback; shift ;;
  *) echo "usage: $0 [--rollback]" >&2; exit 2 ;;
esac
[ $# -eq 0 ] || { echo "usage: $0 [--rollback]" >&2; exit 2; }

say() { echo "$*"; echo "$*" >> "$LOG"; }
# only the Asus script's own status lines, and never anything shaped like a url
show() { grep '^asus ' | grep -viE 'postgres(ql)?://' | while IFS= read -r line; do say "$line"; done; }

[ -f "$APPLY" ] && [ ! -L "$APPLY" ] || { echo "cannot find $APPLY" >&2; exit 2; }
[ -x "$SSH" ] || command -v "$SSH" >/dev/null 2>&1 || { echo "ssh not found" >&2; exit 2; }
case $ASUS in [A-Za-z0-9._-]*@[A-Za-z0-9.-]*) ;; *) echo "bad Asus target" >&2; exit 2 ;; esac

B64=$(base64 < "$APPLY" | tr -d '\n') || { echo "cannot encode the Asus script" >&2; exit 2; }
[ -n "$B64" ] || { echo "cannot encode the Asus script" >&2; exit 2; }
REMOTE="sudo -n bash -c \"\$(printf %s $B64 | base64 -d)\" relay-apply $MODE"
SSH_OPTS=(-T -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes -o ClearAllForwardings=yes -o ForwardAgent=no -o ForwardX11=no)

# one ssh call: stdin from the given file; status lines only. Sets ASUS_RC.
asus_call() { # asus_call STDIN_FILE
  local out
  out=$("$SSH" "${SSH_OPTS[@]}" -- "$ASUS" "$REMOTE" < "$1" 2>&1)
  ASUS_RC=$?
  printf '%s\n' "$out" | show
}

if [ "$MODE" = rollback ]; then
  say "mover: rolling the CDMSS relay config back on the Asus"
  asus_call /dev/null
  case $ASUS_RC in
    0) say "mover: rollback done"; exit 0 ;;
    255) say "mover: ssh could not reach the Asus; nothing known" >&2; exit 6 ;;
    *) say "mover: rollback reported rc=$ASUS_RC" >&2; exit 9 ;;
  esac
fi

# ---- install: the local file first (never printed)
[ -d "$MOUNT" ] || { echo "no RAM disk at $MOUNT: run run-login-mini.sh first" >&2; exit 2; }
[ -f "$RELAY_URL" ] && [ ! -L "$RELAY_URL" ] || { echo "$RELAY_URL missing (or a symlink)" >&2; exit 2; }
[ "$(stat -c '%a' "$RELAY_URL")" = 600 ] || { echo "$RELAY_URL is not mode 600: refusing" >&2; exit 2; }
[ -O "$RELAY_URL" ] || { echo "$RELAY_URL is not owned by this user: refusing" >&2; exit 2; }
python3 -I - "$RELAY_URL" <<'PY'
import re, sys
from urllib.parse import parse_qsl, unquote, urlsplit
raw = open(sys.argv[1]).read()
if raw.count("\n") > 1 or (raw.count("\n") == 1 and not raw.endswith("\n")):
    sys.exit(3)
raw = raw.strip()
u = urlsplit(raw)
if not (re.match(r"^postgres(ql)?://", raw) and 0 < len(raw) <= 1024 and unquote(u.username or "") == "studio_cdmss_ro" and u.password):
    sys.exit(3)
if "-pooler" in (u.hostname or "") or u.port not in (None, 5432):
    sys.exit(3)
if any(k not in ("sslmode", "channel_binding") for k, _ in parse_qsl(u.query)):
    sys.exit(3)
PY
case $? in 0) ;; *) echo "relay-url is not the direct studio_cdmss_ro url (wrong user, a pooled host, a port other than 5432, or not one line): refusing, nothing sent" >&2; exit 3 ;; esac
say "mover: relay-url ok (mode 600, studio_cdmss_ro, direct endpoint); streaming it to the Asus over ssh stdin"

asus_call "$RELAY_URL"
if [ "$ASUS_RC" != 0 ]; then
  rc=$ASUS_RC
  if [ "$rc" = 255 ]; then
    # ssh failed or broke: the call may or may not have reached the Asus (its script rolls itself back when the link drops), so make the state certain
    REMOTE="sudo -n bash -c \"\$(printf %s $B64 | base64 -d)\" relay-apply rollback"
    asus_call /dev/null
    [ "$ASUS_RC" = 0 ] && { say "mover: the Asus is in its previous state; the RAM disk is still attached, retry or run-login-mini.sh --detach" >&2; exit 6; }
    [ "$ASUS_RC" = 255 ] && { say "mover: the Asus is unreachable (state unknown, most likely unchanged); the RAM disk is still attached. When ssh works run $0 --rollback, then retry" >&2; exit 6; }
    say "mover: could not confirm the Asus state (rc=$ASUS_RC): run $0 --rollback" >&2; exit 9
  fi
  [ "$rc" = 9 ] && { say "mover: the Asus rollback was INCOMPLETE: run $0 --rollback" >&2; exit 9; }
  [ "$rc" = 7 ] || [ "$rc" = 3 ] && { say "mover: the Asus refused before changing anything (rc=$rc, see the asus lines above). The RAM disk is still attached." >&2; exit 5; }
  say "mover: the Asus install did not complete (rc=$rc); it restored its previous state. The RAM disk is still attached: fix and rerun, or run-login-mini.sh --detach (and --nologin) to give up" >&2
  exit 5
fi

say "mover: installed and verified on the Asus; wiping the Mini copy"
/usr/bin/env -i HOME="$HOME" PATH=/usr/bin:/bin /bin/bash --noprofile --norc "$LOGIN_MINI" --detach > /dev/null 2>&1
drc=$?
if [ "$drc" != 0 ]; then
  say "mover: WARNING run-login-mini.sh --detach failed (rc=$drc): the RAM disk may still hold the url; run it by hand" >&2
  exit 4
fi
say "mover: relay-url wiped and RAM disk detached. The agent was not restarted: CDMSS_RO_DATABASE_URL is read at its next start; Phase 1 wires tools."
exit 0
