#!/bin/bash -p
# studio_dw_writer password + LOGIN, run ON THE MAC MINI (macOS): RUNBOOK (ops/db13/RUNBOOK.md) install step 2 for the DB13 extract.
# Reuses the hardened ops/cdmss/run-login-mini.sh pattern (v5): env -i allowlist re-exec into `/bin/bash --noprofile --norc -p`, layer-2
# refusals, RAM disk, filtered log, rm -P + detach on every exit path incl. HUP/INT/TERM, Darwin + GNU stat checks. The prologue below is a
# deliberate COPY, not a sourced file: nothing that runs before the scrub may be loaded from a path an attacker could influence.
#
#   /usr/bin/env -i HOME=$HOME PATH=/usr/bin:/bin /bin/bash --noprofile --norc ops/neon/run-dw-writer-login-mini.sh
#
# Target: the GOVERNANCE Neon project (studio Neon). Nothing is invented: the owner DIRECT url is ~/oc/gov-orch/secrets/owner.url (the file
# the other Mini scripts install; refused unless mode 0600, pooled url refused), the Neon API key is ~/oc/gov-orch/secrets/neon-api-key
# (0600), and the project + branch are DISCOVERED through the Neon API (the `discover` route of neon-role.sh, ops/neon/README.md) as the one
# endpoint whose host equals the owner url's host, so the role is reset in the exact database the owner url points at.
# Steps (order fixed after Neon's HTTP 422 on a NOLOGIN role): role-auth must say no_login -> run-roles.sh --role studio_dw_writer --login
# (0003_login.sql: no membership, grants present, then ALTER ROLE LOGIN) -> neon-role.sh reset-password (--host auto: direct host) ->
# run-roles --login again (re-check) -> post-check connecting AS the writer from the new url (current_user, INSERT into
# studio_dw.extract_runs inside a rolled-back txn, no SELECT on studio_ro or any public relation) -> the url is written ATOMICALLY to
# ~/.config/studio-dw-extract/writer-url (dir 0700, file 0600, umask 077). Never printed. Any failure after the reset removes writer-url and
# contains the role NOLOGIN. It grants nothing and touches no other role. Status lines only; detail in ~/oc/gov-orch/scratch/dw-writer-login.log
# (filtered of urls, "password", bearer and token lines).
# Test-only overrides (honoured ONLY with LOGIN_MINI_TEST=1; otherwise the second layer refuses to start): LOGIN_MINI_REPO LOGIN_MINI_SKIP_GIT
# LOGIN_MINI_MOUNT LOGIN_MINI_SECURE_RM LOGIN_MINI_NEON_KEY LOGIN_MINI_LOG LOGIN_MINI_OWNER_URL LOGIN_MINI_DEST LOGIN_MINI_NOT_MAC NEON_API_BASE
# SQL_FILE PSQL; and always refused: the shell-control, PG*, CURL_*, proxy, PYTHON*, GIT_*, LD_*, DYLD_*, STUDIO_DW_DSN_FILE variables.
#
# ENVIRONMENT ALLOWLIST: shebang `/bin/bash -p`; the first block records the incoming variable NAMES, then `exec /usr/bin/env -i` with ONLY PATH
# (gnubin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin), HOME USER LOGNAME LANG TERM and a re-exec marker (the PID); test mode also carries
# the caller's PATH and the named test variables. Residual: `bash script` ignores the shebang's -p (BASH_ENV / PS4 act before line one);
# invoke it as above.
if [ "${LOGIN_MINI_REEXEC:-}" != "$$" ]; then
  set +x
  _t=${LOGIN_MINI_TEST:-0}; _seen=; _bad=0; _fn=0; _odd=0
  _names=$(compgen -e) || _bad=1
  for _v in $_names; do
    [[ $_v =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { _bad=1; continue; }
    [ -n "${!_v:-}" ] && _seen="$_seen $_v"
  done
  [ -n "$(compgen -A function)" ] && _fn=1
  _odd=$(env | grep -vc '^[A-Za-z_][A-Za-z0-9_]*=') || true
  _args=("LOGIN_MINI_REEXEC=$$" "LOGIN_MINI_SEEN=$_seen" "LOGIN_MINI_SCAN=bad=$_bad odd=$_odd fn=$_fn")
  if [ "$_t" = 1 ]; then
    _args+=("LOGIN_MINI_TEST=1" "PATH=$PATH")
    for _v in LOGIN_MINI_REPO LOGIN_MINI_SKIP_GIT LOGIN_MINI_MOUNT LOGIN_MINI_SECURE_RM LOGIN_MINI_NEON_KEY LOGIN_MINI_LOG \
              LOGIN_MINI_OWNER_URL LOGIN_MINI_DEST LOGIN_MINI_NOT_MAC NEON_API_BASE SQL_FILE PSQL; do
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
SEEN=${LOGIN_MINI_SEEN:-}; SCAN=${LOGIN_MINI_SCAN:-bad=1 odd=0 fn=0}
unset LOGIN_MINI_REEXEC LOGIN_MINI_SEEN LOGIN_MINI_SCAN

TEST=${LOGIN_MINI_TEST:-0}
if [[ $TEST != 1 ]]; then
  # layer 2a: what the first layer saw and dropped
  for v in $SEEN; do
    [[ $v =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "environment holds an odd variable name: refusing" >&2; exit 2; }
    case $v in
      LOGIN_MINI_*|VERCEL_API_BASE|NEON_API_BASE|SQL_FILE|PSQL|CDMSS_POSTCHECK_SQL|CDMSS_ALLOW_TEST_POSTCHECK|STUDIO_ROLES_SHM|XDG_RUNTIME_DIR|STUDIO_DW_DSN_FILE|BASH_ENV|ENV)
        [[ $v == LOGIN_MINI_TEST ]] || { echo "$v is a test-only override: refusing (set LOGIN_MINI_TEST=1 only in tests)" >&2; exit 2; } ;;
      SHELLOPTS|BASHOPTS|PS4|BASH_XTRACEFD|PROMPT_COMMAND)
        echo "$v (shell tracing/startup control) was in the environment: refusing" >&2; exit 2 ;;
      PG[A-Z]*|CURL_*|*_proxy|*_PROXY|PYTHON[A-Z]*|GIT_*|LD_*|DYLD_*)
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
  for v in LOGIN_MINI_REPO LOGIN_MINI_SKIP_GIT LOGIN_MINI_MOUNT LOGIN_MINI_SECURE_RM LOGIN_MINI_NEON_KEY LOGIN_MINI_LOG \
           LOGIN_MINI_OWNER_URL LOGIN_MINI_DEST LOGIN_MINI_NOT_MAC VERCEL_API_BASE NEON_API_BASE SQL_FILE PSQL CDMSS_POSTCHECK_SQL CDMSS_ALLOW_TEST_POSTCHECK \
           STUDIO_ROLES_SHM XDG_RUNTIME_DIR STUDIO_DW_DSN_FILE BASH_ENV ENV; do
    if [[ -n ${!v:-} ]]; then echo "$v is a test-only override: refusing (set LOGIN_MINI_TEST=1 only in tests)" >&2; exit 2; fi
  done
  # The scan fails CLOSED: any error, any odd name, any odd environment line exits 2 before anything else runs.
  if [[ -n $(compgen -A function) ]] || env | grep -q '^BASH_FUNC_'; then
    echo "exported bash functions are in the environment (they can replace any command): refusing" >&2; exit 2
  fi
  names=$(compgen -e) || { echo "cannot enumerate the environment: refusing" >&2; exit 2; }
  for v in $names; do
    [[ $v =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "environment holds an odd variable name: refusing" >&2; exit 2; }
    case $v in
      PG[A-Z]*|CURL_*|*_proxy|*_PROXY|PYTHON[A-Z]*|GIT_*|LD_*|DYLD_*)
        if [[ -n ${!v:-} ]]; then echo "$v redirects a host, file or binary: refusing (unset it)" >&2; exit 2; fi ;;
    esac
  done
  # a value with a newline, or an entry whose name is not an identifier, shows up as an `env` line that does not start NAME=
  odd=$(env | grep -vc '^[A-Za-z_][A-Za-z0-9_]*=') ; [[ $odd == 0 ]] || { echo "environment holds odd entries (newline in a value, or a non-identifier name): refusing" >&2; exit 2; }
  [[ $(uname -s) == Darwin ]] || { echo "this script is for the Mac Mini (macOS)" >&2; exit 2; }
fi


REPO=${LOGIN_MINI_REPO:-$HOME/oc/gov-orch/wt-banner}
MOUNT=${LOGIN_MINI_MOUNT:-/Volumes/dwwriterram}
VOLNAME=$(basename "$MOUNT")
SECURE_RM=${LOGIN_MINI_SECURE_RM:-/bin/rm -P}
OWNER_SRC=${LOGIN_MINI_OWNER_URL:-$HOME/oc/gov-orch/secrets/owner.url}
NEON_KEY=${LOGIN_MINI_NEON_KEY:-$HOME/oc/gov-orch/secrets/neon-api-key}
DEST=${LOGIN_MINI_DEST:-$HOME/.config/studio-dw-extract/writer-url}
LOG=${LOGIN_MINI_LOG:-$HOME/oc/gov-orch/scratch/dw-writer-login.log}
ROLE=studio_dw_writer
PSQL_BIN=${PSQL:-psql}

export PATH=/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH
stat -c '%a' / >/dev/null 2>&1 || { echo "GNU coreutils stat not first in PATH (brew install coreutils): the Neon scripts need stat -c" >&2; exit 2; }
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

[[ $# -eq 0 ]] || { echo "usage: $0 (no arguments)" >&2; exit 2; }
[[ -f $OWNER_SRC && -r $OWNER_SRC ]] || { echo "owner url file not readable" >&2; exit 2; }
[[ $(stat -c '%a' "$OWNER_SRC") == 600 ]] || { echo "owner url file must be mode 600: refusing" >&2; exit 2; }
[[ -f $NEON_KEY && -r $NEON_KEY && $(stat -c '%a' "$NEON_KEY") == 600 ]] || { echo "Neon API key file missing or not mode 600" >&2; exit 2; }
[[ ! -e $MOUNT ]] || { echo "$MOUNT already exists (an earlier run's RAM disk?): detach it first" >&2; exit 2; }
if [[ $TEST != 1 || ${LOGIN_MINI_SKIP_GIT:-0} != 1 ]]; then
  [[ -d $REPO ]] || { echo "repo checkout $REPO missing" >&2; exit 2; }
fi

secure_rm() { # secure_rm FILE...  (rm -P on macOS; a failure to wipe must not stop the detach)
  local f
  for f in "$@"; do [[ -e $f ]] && $SECURE_RM "$f" 2>/dev/null; done
  return 0
}

DEV=; OK=0; RESET_DONE=0; LOGIN_DONE=0; DESTTMP=
cleanup() {
  local rc=$?
  trap - EXIT HUP INT TERM
  set +x
  if [[ $OK -ne 1 ]]; then
    # contain first (needs the owner url still on the RAM disk), then remove everything the run produced
    if [[ $LOGIN_DONE -eq 1 && -s $MOUNT/owner-url ]]; then
      "$REPO/ops/neon/run-roles.sh" --role "$ROLE" --nologin "$MOUNT/owner-url" >/dev/null 2>&1 || echo "WARNING: could not confirm $ROLE NOLOGIN: run run-roles.sh --role $ROLE --nologin" >&2
    fi
    [[ -z $DESTTMP ]] || secure_rm "$DESTTMP"
    [[ $RESET_DONE -ne 1 ]] || secure_rm "$DEST"       # the reset killed the old password: a stale url is worse than none
  fi
  if [[ -d $MOUNT ]]; then
    secure_rm "$MOUNT/owner-url" "$MOUNT/project.env" "$MOUNT/branch.id" "$MOUNT/writer-url" "$MOUNT/writer.svc" "$MOUNT/check.sql" "$MOUNT/py.err" "$MOUNT/.device"
  fi
  if [[ -n $DEV ]]; then hdiutil detach "$DEV" >/dev/null 2>&1 || hdiutil detach -force "$DEV" >/dev/null 2>&1; fi
  [[ $rc -ne 0 || $OK -eq 1 ]] || rc=1
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
  ( cd "$REPO" && git fetch -q origin && git checkout -q --detach origin/main ) 2>&1 | filter >> "$LOG"
  [[ ${PIPESTATUS[0]} -eq 0 ]] || { echo "git fetch/checkout in $REPO failed (see $LOG)" >&2; exit 2; }
fi

DEV=$(hdiutil attach -nomount ram://65536 | awk '{print $1}')
[[ -n $DEV ]] || { echo "hdiutil attach failed" >&2; exit 2; }
diskutil erasevolume HFS+ "$VOLNAME" "$DEV" >/dev/null || { echo "diskutil erasevolume failed" >&2; exit 2; }
[[ -d $MOUNT ]] || { echo "RAM disk did not mount at $MOUNT" >&2; exit 2; }
export XDG_RUNTIME_DIR=$MOUNT STUDIO_ROLES_SHM=$MOUNT

install -m 600 "$OWNER_SRC" "$MOUNT/owner-url" || { echo "could not copy the owner url onto the RAM disk" >&2; exit 2; }

# Refuse a POOLED owner url BEFORE any Neon call. The url is never read into a shell variable (xtrace, error text): python reads the file.
set +x
python3 - "$MOUNT/owner-url" <<'PY'
import re, sys
raw = open(sys.argv[1]).read().strip()
m = re.match(r"^postgres(?:ql)?://([^/?#]*)", raw)
if not m:
    sys.exit(4)
host = m.group(1).rsplit("@", 1)[-1].split(":", 1)[0]
if "-pooler" in host or re.search(r"(?:^|[?&])pgbouncer=true(?:&|$)", raw):
    sys.exit(3)
PY
case $? in
  0) ;;
  3) echo "owner url is a POOLED url (the owner url must be direct): refusing, nothing was run" >&2; exit 3 ;;
  4) echo "owner url is not a postgres url: refusing" >&2; exit 3 ;;
  *) echo "owner url check failed: refusing" >&2; exit 3 ;;
esac

# Project + branch from the Neon API: the endpoint whose host is the owner url's host (exactly one), not a value anyone typed.
NEON_KEY_FILE=$NEON_KEY python3 - "$MOUNT/owner-url" "$MOUNT/project.env" "$MOUNT/branch.id" <<'PY' 2>"$MOUNT/py.err"
import json, os, re, sys, urllib.request

raw = open(sys.argv[1]).read().strip()
host = re.match(r"^postgres(?:ql)?://([^/?#]*)", raw).group(1).rsplit("@", 1)[-1].split(":", 1)[0]
if not host:
    sys.exit("owner url has no host")
key = open(os.environ["NEON_KEY_FILE"]).read().strip()
base = os.environ.get("NEON_API_BASE", "https://console.neon.tech/api/v2")
hdr = {"Authorization": "Bearer " + key, "Accept": "application/json"}

def get(path):
    return json.load(urllib.request.urlopen(urllib.request.Request(base + path, headers=hdr), timeout=30))

hits = []
for p in get("/projects?limit=400").get("projects", []):
    for e in get(f"/projects/{p['id']}/endpoints").get("endpoints", []):
        if e.get("host") == host:
            hits.append((p["id"], e["branch_id"]))
if len(hits) != 1:
    sys.exit(f"expected exactly one Neon endpoint for the owner url host, found {len(hits)}")
ok = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
if not all(ok.match(x) for x in hits[0]):
    sys.exit("unexpected id shape")

def write(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.write(fd, text.encode())
    os.close(fd)

write(sys.argv[2], "NEON_PROJECT_ID=" + hits[0][0] + "\n")
write(sys.argv[3], hits[0][1] + "\n")
PY
rc=$?
filter < "$MOUNT/py.err" >> "$LOG"; secure_rm "$MOUNT/py.err"
[[ $rc -eq 0 && -s $MOUNT/project.env && -s $MOUNT/branch.id ]] || { echo "could not discover the governance Neon project/branch for the owner url (see $LOG)" >&2; exit 2; }
BRANCH=$(<"$MOUNT/branch.id")

# ORDER (v6, after Neon answered 422 to reset_password on a NOLOGIN role): (pre) the role must be a NOLOGIN role with no password yet,
# (a) LOGIN with every membership/grant check, (b) Neon issues the password, (c) the same checks again (reset may add neon_superuser),
# (d) the post-check AS the writer below. A LOGIN role with no password cannot authenticate, so the window between (a) and (b) opens no
# door. Any failure from (a) on contains the role to NOLOGIN (see cleanup) and leaves no url.
method=$("$REPO/ops/neon/neon-role.sh" role-auth "$NEON_KEY" "@$MOUNT/project.env" "$BRANCH" "$ROLE" 2>"$MOUNT/py.err")
rc=$?
filter < "$MOUNT/py.err" >> "$LOG"; secure_rm "$MOUNT/py.err"
if [[ $rc -ne 0 ]]; then
  [[ $rc -eq 4 ]] && echo "Neon API cannot see $ROLE (SQL-created role): nothing changed; tell gov-orch" >&2
  echo "role-auth FAILED rc=$rc (see $LOG)" >&2; exit "$rc"
fi
if [[ $method != no_login ]]; then
  echo "$ROLE is not a password-less NOLOGIN role (Neon says authentication_method=$method): this is ROTATION, not a first login. Nothing was changed. Follow the rotation path in ops/neon/README.md" >&2
  exit 6
fi
note "role-auth no_login"

"$REPO/ops/neon/run-roles.sh" --role "$ROLE" --login "$MOUNT/owner-url" 2>&1 | filter | tail -20 >> "$LOG"
rc=${PIPESTATUS[0]}
if [[ $rc -ne 0 ]]; then echo "run-roles --login (a) FAILED rc=$rc, role contained NOLOGIN (see $LOG)" >&2; exit "$rc"; fi
LOGIN_DONE=1
note "login enabled (a)"

"$REPO/ops/neon/neon-role.sh" reset-password "$NEON_KEY" "@$MOUNT/project.env" "$BRANCH" "$ROLE" "$MOUNT/writer-url" \
    --dsn-from "$MOUNT/owner-url" --host auto 2>&1 | filter | tail -20 >> "$LOG"
rc=${PIPESTATUS[0]}
if [[ $rc -ne 0 ]]; then
  [[ $rc -eq 4 ]] && echo "Neon API cannot see $ROLE (SQL-created role): tell gov-orch" >&2
  echo "reset-password (b) FAILED rc=$rc, role contained NOLOGIN (see $LOG)" >&2; exit "$rc"
fi
RESET_DONE=1
note "reset-password ok (b)"

"$REPO/ops/neon/run-roles.sh" --role "$ROLE" --login "$MOUNT/owner-url" 2>&1 | filter | tail -20 >> "$LOG"
rc=${PIPESTATUS[0]}
if [[ $rc -ne 0 ]]; then echo "re-check (c) FAILED rc=$rc, role contained NOLOGIN, no url left (see $LOG)" >&2; exit "$rc"; fi
note "re-check ok (c)"

# POST-CHECK, connecting AS the writer with the url that will be installed.
cat > "$MOUNT/check.sql" <<'SQL'
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
  r record;
  first_pub text;
  first_ro text;
BEGIN
  IF current_user <> 'studio_dw_writer' THEN RAISE EXCEPTION 'connected as %, not studio_dw_writer', current_user; END IF;
  INSERT INTO studio_dw.extract_runs (run_id, mode, started_at, status) VALUES (gen_random_uuid(), 'full', now(), 'running');
  IF has_schema_privilege(current_user, 'studio_ro', 'USAGE') THEN RAISE EXCEPTION 'the writer has USAGE on studio_ro'; END IF;
  FOR r IN SELECT n.nspname, c.relname, c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname IN ('public', 'studio_ro') AND c.relkind IN ('r', 'p', 'v', 'm', 'f') LOOP
    IF has_any_column_privilege(current_user, r.oid, 'SELECT') OR has_table_privilege(current_user, r.oid, 'SELECT') THEN
      RAISE EXCEPTION 'the writer can read %.%', r.nspname, r.relname;
    END IF;
  END LOOP;
  SELECT format('%I.%I', n.nspname, c.relname) INTO first_pub FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1 LIMIT 1;
  SELECT format('%I.%I', n.nspname, c.relname) INTO first_ro FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'studio_ro' AND c.relkind = 'v' ORDER BY 1 LIMIT 1;
  IF first_pub IS NOT NULL THEN
    BEGIN EXECUTE 'SELECT 1 FROM ' || first_pub || ' LIMIT 1'; RAISE EXCEPTION 'the writer read %', first_pub;
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  END IF;
  IF first_ro IS NOT NULL THEN
    BEGIN EXECUTE 'SELECT 1 FROM ' || first_ro || ' LIMIT 1'; RAISE EXCEPTION 'the writer read %', first_ro;
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  END IF;
END
$$;
ROLLBACK;
SQL
WRITER_URL_FILE=$MOUNT/writer-url SERVICE_FILE=$MOUNT/writer.svc python3 - <<'PY'
import os, urllib.parse as u

raw = open(os.environ["WRITER_URL_FILE"]).read().strip()
p = u.urlsplit(raw)
q = dict(u.parse_qsl(p.query))
lines = ["[writer]"]
host = q.pop("host", None) or p.hostname
if host: lines.append(f"host={host}")
if p.port: lines.append(f"port={p.port}")
if p.username: lines.append(f"user={u.unquote(p.username)}")
if p.password: lines.append(f"password={u.unquote(p.password)}")
db = p.path.lstrip("/")
if db: lines.append(f"dbname={u.unquote(db)}")
for k, v in q.items():
    if k in ("sslmode", "channel_binding", "options", "sslrootcert"): lines.append(f"{k}={v}")
fd = os.open(os.environ["SERVICE_FILE"], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, ("\n".join(lines) + "\n").encode())
os.close(fd)
PY
PGSERVICEFILE="$MOUNT/writer.svc" "$PSQL_BIN" -X -q -At -v ON_ERROR_STOP=1 -f "$MOUNT/check.sql" "service=writer" 2>&1 | filter | tail -20 >> "$LOG"
rc=${PIPESTATUS[0]}
if [[ $rc -ne 0 ]]; then echo "post-check as the writer FAILED rc=$rc: role contained NOLOGIN, no writer-url left (see $LOG)" >&2; exit 1; fi
note "post-check ok"

# Install atomically: dir 0700, temp file 0600 in the SAME directory, then rename. The url is only ever redirected, never an argument.
DESTDIR=$(dirname "$DEST")
( umask 077; mkdir -p "$DESTDIR" ) || { echo "cannot create $DESTDIR" >&2; exit 1; }
chmod 700 "$DESTDIR" || { echo "cannot set $DESTDIR to 0700" >&2; exit 1; }
[[ $(stat -c '%a' "$DESTDIR") == 700 ]] || { echo "$DESTDIR is not mode 700" >&2; exit 1; }
DESTTMP=$(umask 077; mktemp "$DESTDIR/.writer-url.XXXXXX") || { echo "cannot create a temp file in $DESTDIR" >&2; exit 1; }
cat "$MOUNT/writer-url" > "$DESTTMP" || { echo "could not write the temp url file" >&2; exit 1; }
chmod 600 "$DESTTMP"
mv -f "$DESTTMP" "$DEST" || { echo "could not move the url into place" >&2; exit 1; }
DESTTMP=
[[ -s $DEST && $(stat -c '%a' "$DEST") == 600 ]] || { echo "writer-url missing or not mode 600" >&2; exit 1; }
OK=1
echo "OK $ROLE: password issued by Neon, LOGIN enabled, post-check passed (insert in a rolled-back txn; no read on studio_ro/public); url written to $DEST (mode 600, dir 700); RAM disk wiped and detached"
