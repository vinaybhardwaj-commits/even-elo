#!/usr/bin/env bash
# Asus side of ops/cdmss/relay-install.sh. Not run by hand: the Mini ships this text in the ssh command line (it is not secret) as
#   sudo -n bash -c "<this script>" relay-apply install|rollback
# and streams the studio_cdmss_ro URL on STDIN (one line). The URL is never in argv, in the environment, in a log or in any file but the
# one the gov DSN already lives in (/etc/studio-pgrelay/neon.env, 0600 root:root, key CDMSS_NEON_URL next to GOV_NEON_URL).
#
# What install changes on the Asus (and nothing else; every item is undone by rollback):
#   1. /etc/studio-pgrelay/neon.env     + CDMSS_NEON_URL=<url>            (0600 root:root, same file/owner/mode as GOV_NEON_URL)
#   2. /etc/studio-pgrelay/local.env    + AGENT_CDMSS_PW=<48 hex>         (the agent's loopback password toward the relay, 0600 root:root)
#   3. /etc/studio-agent/env            + CDMSS_RO_DATABASE_URL=postgresql://agent_cdmss:<pw>@127.0.0.1:6432/cdmss?sslmode=disable
#                                         (0600 root:studio-agent, loaded by systemd like GOV_RO_DATABASE_URL; the agent holds no Neon host or credential)
#   4. /etc/studio-agent/neon-hosts.extra  the CDMSS endpoint host (0644 root:root): studio-agent-egress-refresh pins it like a --neon-host
#   5. studio-agent-egress-refresh run (nft: the relay uid may now also reach the host's pinned IPs on :5432, nothing else;
#      pins file, relay hosts file, relay IPAddressAllow), studio-pgrelay restarted (gov and studio pools reconnect; the agent is NOT restarted)
# Squid, its allowlist, the pre-filter, the agent unit and the agent's nft rules are not touched. Postgres never passes Squid: the relay
# (uid studio-pgrelay) is the only process that reaches Neon, on :5432, TLS verify-full against the system CA.
# Then it verifies AS studio-agent through the relay with the agent venv's psycopg: current_user=studio_cdmss_ro, SELECT count on
# cdmss_ro.ams_formulary, a write refused (role fence, session read-only switched OFF first), a base table read refused (public.formulary).
# Any failure (or HUP/INT/TERM, e.g. the ssh link dropping) restores the previous state of items 1-4 and refreshes/restarts again.
# Prints fixed status lines starting "asus " only. Exit: 0 ok, 3 bad url, 7 precondition (nothing changed), 1 verify/apply failed (rolled back),
# 9 rollback itself incomplete.
set -uo pipefail
umask 077
set +x
MODE=${1:-}
case $MODE in install|rollback) ;; *) echo "asus usage: install|rollback" >&2; exit 2 ;; esac

ROOT=""; RUNAS="runuser -u studio-agent --"
if [ "${ASUS_RELAY_TEST:-}" = 1 ]; then   # sudo resets the environment, so the Mini cannot set these; the Linux tests do
  ROOT=${ASUS_ROOT:?}; RUNAS=${ASUS_RUNAS:-}
fi
NEON_ENV=$ROOT/etc/studio-pgrelay/neon.env
LOCAL_ENV=$ROOT/etc/studio-pgrelay/local.env
AGENT_ENV=$ROOT/etc/studio-agent/env
EXTRA=$ROOT/etc/studio-agent/neon-hosts.extra
REFRESH=$ROOT/usr/local/sbin/studio-agent-egress-refresh
RENDER=$ROOT/usr/local/sbin/studio-pgrelay-render
VENV_PY=${ASUS_VENV_PY:-/opt/studio-agent/current/venv/bin/python}
[ -z "$ROOT" ] || VENV_PY=${ASUS_VENV_PY:-python3}
RELAY=studio-pgrelay.service
RELAY_PORT=6432
LOCKF=$ROOT/run/lock/studio-cdmss-relay.lock

say() { printf 'asus %s\n' "$*"; }
own() { [ -n "$ROOT" ] || chown "$1" "$2"; }

if [ -z "$ROOT" ] && [ "$(id -u)" != 0 ]; then say "must run as root"; exit 7; fi
mkdir -p "$(dirname "$LOCKF")"
exec 8>"$LOCKF"
flock -n 8 || { say "another relay-apply is running"; exit 7; }

# private scratch on tmpfs (values only ever live here for the length of the run)
SCR=$(mktemp -d "$ROOT/run/studio-cdmss-relay.XXXXXX" 2>/dev/null) || SCR=$(mktemp -d) || { say "no scratch dir"; exit 7; }
chmod 700 "$SCR"
wipe() { local f; for f in "$@"; do [ ! -e "$f" ] || { shred -u "$f" 2>/dev/null || rm -f "$f"; }; done; }
CHANGED=0 COMMITTED=0 ROLLING=0 PGDIR=
cleanup() {
  local rc=$?
  trap - EXIT HUP INT TERM
  if [ "$MODE" = install ] && [ "$CHANGED" = 1 ] && [ "$COMMITTED" != 1 ]; then
    do_rollback_from_snapshot || rc=9
    [ "$rc" != 0 ] || rc=1
  fi
  [ -z "$PGDIR" ] || { wipe "$PGDIR/pgpass"; rm -rf "$PGDIR" 2>/dev/null; }
  wipe "$SCR"/*; rm -rf "$SCR" 2>/dev/null
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# edit_line FILE KEY VALFILE  : set "KEY=<content of VALFILE>" (replace the line or append); VALFILE=- removes the line.
# Atomic (temp + rename) and keeps the owner and mode of FILE. The value only travels through files in $SCR.
edit_line() {
  python3 -I - "$1" "$2" "$3" <<'PY'
import os, sys
path, key, valfile = sys.argv[1:4]
val = None if valfile == "-" else open(valfile).read().rstrip("\n")
lines = open(path).read().splitlines() if os.path.exists(path) else []
out, done = [], False
for l in lines:
    if l.startswith(key + "="):
        if val is not None and not done:
            out.append(key + "=" + val)
        done = True
    else:
        out.append(l)
if val is not None and not done:
    out.append(key + "=" + val)
st = os.stat(path)
tmp = path + ".new"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    f.write("\n".join(out) + "\n")
os.chmod(tmp, st.st_mode & 0o777)
try:
    os.chown(tmp, st.st_uid, st.st_gid)
except PermissionError:
    pass
os.rename(tmp, path)
PY
}
# get_line FILE KEY OUTFILE : writes the current value of KEY (or nothing and rc 1 when absent)
get_line() {
  python3 -I - "$1" "$2" "$3" <<'PY'
import os, sys
path, key, outf = sys.argv[1:4]
for l in (open(path).read().splitlines() if os.path.exists(path) else []):
    if l.startswith(key + "="):
        fd = os.open(outf, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.write(fd, l[len(key) + 1:].encode()); os.close(fd)
        sys.exit(0)
sys.exit(1)
PY
}

# ---- snapshot of the four items, for rollback of a failed install (also the "previous state" a re-install restores)
snapshot() {
  mkdir -p "$SCR/snap"
  get_line "$NEON_ENV" CDMSS_NEON_URL "$SCR/snap/url" && : >"$SCR/snap/has_url"
  get_line "$LOCAL_ENV" AGENT_CDMSS_PW "$SCR/snap/pw" && : >"$SCR/snap/has_pw"
  get_line "$AGENT_ENV" CDMSS_RO_DATABASE_URL "$SCR/snap/agenturl" && : >"$SCR/snap/has_agenturl"
  if [ -e "$EXTRA" ]; then cp -p "$EXTRA" "$SCR/snap/extra" && : >"$SCR/snap/has_extra"; fi
  return 0
}
restore_items() {
  local rc=0
  if [ -e "$SCR/snap/has_url" ]; then edit_line "$NEON_ENV" CDMSS_NEON_URL "$SCR/snap/url" || rc=1; else edit_line "$NEON_ENV" CDMSS_NEON_URL - || rc=1; fi
  if [ -e "$SCR/snap/has_pw" ]; then edit_line "$LOCAL_ENV" AGENT_CDMSS_PW "$SCR/snap/pw" || rc=1; else edit_line "$LOCAL_ENV" AGENT_CDMSS_PW - || rc=1; fi
  if [ -e "$SCR/snap/has_agenturl" ]; then edit_line "$AGENT_ENV" CDMSS_RO_DATABASE_URL "$SCR/snap/agenturl" || rc=1; else edit_line "$AGENT_ENV" CDMSS_RO_DATABASE_URL - || rc=1; fi
  if [ -e "$SCR/snap/has_extra" ]; then cp -p "$SCR/snap/extra" "$EXTRA" || rc=1; else rm -f "$EXTRA" || rc=1; fi
  return $rc
}
apply_runtime() { # refresh egress (pins, nft, relay allow) and restart the relay; rc 0 when both worked and the relay listens
  if ! "$REFRESH" >/dev/null 2>&1 </dev/null; then say "egress refresh failed"; return 1; fi
  if systemctl is-enabled --quiet "$RELAY" 2>/dev/null || systemctl is-active --quiet "$RELAY" 2>/dev/null; then
    systemctl restart "$RELAY" >/dev/null 2>&1 </dev/null || { say "relay restart failed"; return 1; }
    local i
    for i in $(seq 20); do
      if systemctl is-active --quiet "$RELAY" 2>/dev/null && { [ -n "$ROOT" ] || ss -ltn 2>/dev/null | grep -q "127.0.0.1:$RELAY_PORT "; }; then return 0; fi
      sleep 1
    done
    say "relay not listening on 127.0.0.1:$RELAY_PORT"; return 1
  fi
  return 0
}
do_rollback_from_snapshot() {
  [ "$ROLLING" = 0 ] || return 1
  ROLLING=1
  say "rolling back"
  local rc=0
  restore_items || { say "restoring the files failed"; rc=1; }
  apply_runtime || rc=1
  if [ "$rc" = 0 ]; then say "rolled back (previous state restored)"; else say "ROLLBACK INCOMPLETE: inspect /etc/studio-pgrelay/neon.env, /etc/studio-agent/env and neon-hosts.extra"; fi
  return $rc
}

# ---- rollback mode: remove the four items for good
if [ "$MODE" = rollback ]; then
  say "removing the CDMSS relay config"
  : >"$SCR/none"
  rc=0
  edit_line "$NEON_ENV" CDMSS_NEON_URL - || rc=1
  edit_line "$LOCAL_ENV" AGENT_CDMSS_PW - || rc=1
  # the installer keeps the (empty) name in the agent env: blank it rather than delete it
  if get_line "$AGENT_ENV" CDMSS_RO_DATABASE_URL "$SCR/cur"; then : >"$SCR/empty"; edit_line "$AGENT_ENV" CDMSS_RO_DATABASE_URL "$SCR/empty" || rc=1; fi
  rm -f "$EXTRA" || rc=1
  apply_runtime || rc=1
  if [ "$rc" = 0 ]; then say "rollback done: no CDMSS url, password, env line or pinned host remains"; exit 0; fi
  say "ROLLBACK INCOMPLETE"; exit 9
fi

# ---- install
say "precheck"
for f in "$NEON_ENV" "$LOCAL_ENV" "$AGENT_ENV" "$REFRESH" "$RENDER"; do
  [ -e "$f" ] || { say "missing $(basename "$f"): run install-studio-agent.sh from gov/cdmss-relay first (nothing changed)"; exit 7; }
done
grep -q 'CDMSS_NEON_URL' "$RENDER" && grep -q 'neon-hosts.extra' "$REFRESH" \
  || { say "the installed relay render / egress refresh predate CDMSS support: run install-studio-agent.sh from gov/cdmss-relay first (nothing changed)"; exit 7; }
command -v python3 >/dev/null || { say "python3 missing"; exit 7; }

# read + validate the URL from stdin; python writes it (and the host) to scratch files, prints nothing secret
VALIDATE=$(cat <<'PY'
import os, re, sys
from urllib.parse import parse_qsl, unquote, urlsplit
raw = sys.stdin.readline().rstrip("\r\n")
def bad(why):
    print("asus bad url: " + why, flush=True); sys.exit(3)
if not raw or len(raw) > 1024 or not all(32 < ord(c) < 127 for c in raw):
    bad("not one printable line of at most 1024 characters")
if not re.match(r"^postgres(ql)?://", raw):
    bad("not a postgres url")
u = urlsplit(raw)
if unquote(u.username or "") != "studio_cdmss_ro" or not u.password:
    bad("user is not studio_cdmss_ro or has no password")
host = (u.hostname or "")
if not re.fullmatch(r"[a-z0-9]([a-z0-9.-]*[a-z0-9])?", host) or "." not in host or re.fullmatch(r"[0-9.]+", host):
    bad("host is not a plain DNS name")
if "-pooler" in host:
    bad("host is a POOLED endpoint (the direct read_write endpoint is required)")
if u.port not in (None, 5432):
    bad("port is not 5432")
if not re.fullmatch(r"/[A-Za-z0-9_-]+", u.path or ""):
    bad("no plain database name")
if u.fragment or any(k not in ("sslmode", "channel_binding") for k, _ in parse_qsl(u.query)):
    bad("query parameters other than sslmode/channel_binding")
for path, text in ((sys.argv[1], raw), (sys.argv[2], host + "\n")):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.write(fd, text.encode()); os.close(fd)
print("asus url ok (user studio_cdmss_ro, direct endpoint, port 5432)", flush=True)
PY
)
python3 -I -c "$VALIDATE" "$SCR/url" "$SCR/host"
rc=$?; [ "$rc" = 0 ] || exit "$rc"
say "host $(cat "$SCR/host")"

snapshot
CHANGED=1
if [ ! -e "$SCR/snap/has_pw" ]; then
  python3 -I -c 'import secrets,sys; sys.stdout.write(secrets.token_hex(24))' >"$SCR/pw"
else cp "$SCR/snap/pw" "$SCR/pw"; fi
# the agent's relay url, built from local.env's password by python (the password never reaches argv)
python3 -I - "$SCR/pw" "$SCR/agenturl" <<'PY'
import os, sys
pw = open(sys.argv[1]).read().strip()
fd = os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, f"postgresql://agent_cdmss:{pw}@127.0.0.1:6432/cdmss?sslmode=disable".encode()); os.close(fd)
PY
edit_line "$NEON_ENV" CDMSS_NEON_URL "$SCR/url" || { say "could not write neon.env"; exit 1; }
edit_line "$LOCAL_ENV" AGENT_CDMSS_PW "$SCR/pw" || { say "could not write local.env"; exit 1; }
edit_line "$AGENT_ENV" CDMSS_RO_DATABASE_URL "$SCR/agenturl" || { say "could not write the agent env"; exit 1; }
install -m 0644 "$SCR/host" "$EXTRA" && own root:root "$EXTRA" || { say "could not write neon-hosts.extra"; exit 1; }
wipe "$SCR/url"
say "config written (neon.env, local.env, agent env, neon-hosts.extra)"
apply_runtime || exit 1
say "egress refreshed, relay restarted"

# ---- verify as studio-agent through the relay (the agent's own psycopg; the loopback password via a pgpass file owned by the agent)
PGDIR=$(mktemp -d "$ROOT/run/studio-cdmss-pg.XXXXXX") || { say "no scratch dir"; exit 1; }
python3 -I - "$SCR/pw" "$PGDIR/pgpass" <<'PY'
import os, sys
pw = open(sys.argv[1]).read().strip()
fd = os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, f"127.0.0.1:6432:cdmss:agent_cdmss:{pw}\n".encode()); os.close(fd)
PY
if [ -z "$ROOT" ]; then chown studio-agent "$PGDIR" "$PGDIR/pgpass"; fi
chmod 700 "$PGDIR"
VERIFY=$(cat <<'PY'
import sys
import psycopg
bad = 0
def out(name, ok, extra=""):
    global bad
    bad += 0 if ok else 1
    print("asus verify " + name + (" ok" if ok else " FAIL") + (" " + extra if extra else ""), flush=True)
try:
    conn = psycopg.connect("host=127.0.0.1 port=6432 dbname=cdmss user=agent_cdmss sslmode=disable connect_timeout=10", autocommit=True)
except Exception as e:
    out("connect", False, type(e).__name__)
    sys.exit(1)
def code(e):
    return getattr(e, "sqlstate", None) or type(e).__name__
try:
    who = conn.execute("select current_user").fetchone()[0]
    out("current_user", who == "studio_cdmss_ro", "current_user=" + str(who))
except Exception as e:
    out("current_user", False, code(e))
try:
    n = conn.execute("select count(*) from cdmss_ro.ams_formulary").fetchone()[0]
    out("select-count", n >= 0, "cdmss_ro.ams_formulary rows=" + str(n))
except Exception as e:
    out("select-count", False, code(e))
try:
    conn.execute("set default_transaction_read_only = off")   # the ROLE must refuse, not just the session default
    conn.execute("delete from cdmss_ro.ams_formulary where false")
    out("write-refused", False, "the write was ACCEPTED")
except Exception as e:
    out("write-refused", code(e) in ("42501", "25006", "0A000"), "refused " + code(e))
try:
    conn.execute("select 1 from public.formulary limit 1")
    out("base-table-refused", False, "the base table was READABLE")
except Exception as e:
    out("base-table-refused", code(e) == "42501", "refused " + code(e))
sys.exit(1 if bad else 0)
PY
)
# shellcheck disable=SC2086
vout=$($RUNAS env PGPASSFILE="$PGDIR/pgpass" "$VENV_PY" -I -c "$VERIFY" 2>/dev/null); vrc=$?
printf '%s\n' "$vout" | grep '^asus verify ' || true
wipe "$PGDIR/pgpass"
if [ "$vrc" != 0 ]; then say "verification FAILED"; exit 1; fi
COMMITTED=1
say "relay ready: studio_cdmss_ro reachable by studio-agent through the relay (alias cdmss), read-only fences hold; agent not restarted"
exit 0
