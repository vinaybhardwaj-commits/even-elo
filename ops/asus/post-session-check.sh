#!/usr/bin/env bash
# L-C3/L-C4: after a session, look for a canary patient string on disk (plain and .gz) and in the journal.
# The canary is read from stdin (or $STUDIO_CANARY) so it never appears in argv or shell history.
# Only a hash of each hit path is printed (plus the path itself when it does not contain the canary),
# never the canary and never file contents.
#
#   printf '%s' "$CANARY" | sudo ./post-session-check.sh [--dry-run]
# Also checks: egress-refresh last success <= 15 min old, and STUDIO_LOG_LEVEL is INFO or higher (env file and running process).
# Exit: 0 clean, 1 hit(s) or log-level violation, 2 usage, 3 INCONCLUSIVE (unreadable path, journalctl failure,
# missing/stale egress-refresh stamp, unreadable env; nothing worse seen).
set -uo pipefail

DIRS=(/var /tmp /opt/studio-agent)
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

if [ "$DRY" = 1 ]; then
  echo "+ read canary from stdin or STUDIO_CANARY (not echoed, not in argv)"
  for d in "${DIRS[@]}"; do
    echo "+ grep -rlaF -D skip -f <canary fd> $d      # plain files"
    echo "+ find $d -name '*.gz|*.xz|*.zst' | zgrep/xzgrep/zstdgrep -qaF -f <canary fd>   # compressed rotated logs"
  done
  echo "+ journalctl --no-pager -a | grep -cF -f <canary fd>"
  echo "+ egress-refresh last success: /var/lib/studio-agent-egress-ok age <= 900s else INCONCLUSIVE"
  echo "+ STUDIO_LOG_LEVEL in /etc/studio-agent/env and in /proc/<MainPID>/environ must be INFO|WARNING|ERROR|CRITICAL"
  echo "expect: 0 hits (exit 0); exit 1 on hits; exit 3 if any path/journal was unreadable"
  exit 0
fi

[ "$(id -u)" = 0 ] || { echo "run as root so all of /var and the journal are readable" >&2; exit 2; }

canary=${STUDIO_CANARY:-}
if [ -z "$canary" ] && [ ! -t 0 ]; then IFS= read -r canary || true; fi
[ -n "$canary" ] || { echo "no canary supplied (stdin or STUDIO_CANARY)" >&2; exit 2; }
[ "${#canary}" -ge 8 ] || { echo "canary too short to be meaningful" >&2; exit 2; }

hits=0
inconclusive=0
violations=0
errfile=$(mktemp)
finderr=$(mktemp)
trap 'rm -f "$errfile" "$finderr"' EXIT

report_hit() { # $1 = path
  local h
  h=$(printf '%s' "$1" | sha256sum | cut -c1-16)
  if [[ $1 == *"$canary"* ]]; then echo "HIT path-sha256:$h"; else echo "HIT path-sha256:$h  $1"; fi
  hits=$((hits + 1))
}

for d in "${DIRS[@]}"; do
  if [ ! -d "$d" ]; then echo "INCONCLUSIVE: $d is not a directory"; inconclusive=1; continue; fi
  : >"$errfile"
  while IFS= read -r f; do report_hit "$f"; done \
    < <(grep -rlaF -D skip --exclude-dir=proc -f <(printf '%s\n' "$canary") "$d" 2>"$errfile")
  if [ -s "$errfile" ]; then
    first=$(head -1 "$errfile")
    echo "INCONCLUSIVE: $(wc -l <"$errfile") read error(s) under $d (first: ${first//"$canary"/<canary>})"
    inconclusive=1
  fi
  for pair in "gz:zgrep" "xz:xzgrep" "zst:zstdgrep"; do
    ext=${pair%%:*} tool=${pair##*:}
    while IFS= read -r -d '' f; do
      if ! command -v "$tool" >/dev/null; then
        echo "INCONCLUSIVE: $tool not installed but .$ext files exist under $d"; inconclusive=1; break
      fi
      "$tool" -qaF -f <(printf '%s\n' "$canary") "$f" 2>"$errfile"
      rc=$?
      if [ "$rc" = 0 ]; then report_hit "$f"
      elif [ "$rc" != 1 ]; then echo "INCONCLUSIVE: $tool failed (rc=$rc) on path-sha256:$(printf '%s' "$f" | sha256sum | cut -c1-16)"; inconclusive=1
      fi
    done < <(find "$d" -xdev -type f -name "*.$ext" -print0 2>>"$finderr")
  done
  if [ -s "$finderr" ]; then echo "INCONCLUSIVE: find could not read parts of $d"; inconclusive=1; fi
done

jfile=$(mktemp)
journalctl --no-pager -a >"$jfile" 2>"$errfile"
jrc=$?
jc=$(grep -cF -f <(printf '%s\n' "$canary") "$jfile")
rm -f "$jfile"
if [ "$jrc" != 0 ] || [ -s "$errfile" ]; then
  echo "INCONCLUSIVE: journalctl exited $jrc or printed errors"; inconclusive=1
fi
echo "journal hits: $jc"
hits=$((hits + jc))

# egress-refresh timer: last success stamp written by studio-agent-egress-refresh
stamp=/var/lib/studio-agent-egress-ok
if [ -r "$stamp" ] && [[ $(cat "$stamp") =~ ^[0-9]+$ ]]; then
  age=$(( $(date +%s) - $(cat "$stamp") ))
  if [ "$age" -gt 900 ]; then echo "INCONCLUSIVE: egress refresh last succeeded ${age}s ago (> 900s)"; inconclusive=1
  else echo "egress refresh last success: ${age}s ago"; fi
else
  echo "INCONCLUSIVE: no egress refresh success stamp ($stamp)"; inconclusive=1
fi

# log level must not be below INFO in the live env (file and running process)
level_ok() { case "${1^^}" in INFO|WARNING|WARN|ERROR|CRITICAL|FATAL) return 0 ;; *) return 1 ;; esac; }
if [ -r /etc/studio-agent/env ]; then
  lvl=$(grep -E '^STUDIO_LOG_LEVEL=' /etc/studio-agent/env | tail -1 | cut -d= -f2-)
  lvl=${lvl:-INFO}  # the app defaults to INFO
  if level_ok "$lvl"; then echo "STUDIO_LOG_LEVEL (env file): ${lvl^^}"; else echo "VIOLATION: STUDIO_LOG_LEVEL in env file is below INFO"; violations=$((violations + 1)); fi
else
  echo "INCONCLUSIVE: /etc/studio-agent/env unreadable"; inconclusive=1
fi
pid=$(systemctl show studio-agent -p MainPID --value 2>/dev/null)
if [[ $pid =~ ^[1-9][0-9]*$ ]]; then
  if plvl=$(tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | grep -E '^STUDIO_LOG_LEVEL=' | cut -d= -f2-); then
    plvl=${plvl:-INFO}
    if level_ok "$plvl"; then echo "STUDIO_LOG_LEVEL (running process): ${plvl^^}"; else echo "VIOLATION: running process STUDIO_LOG_LEVEL is below INFO"; violations=$((violations + 1)); fi
  else
    echo "INCONCLUSIVE: cannot read environment of agent pid $pid"; inconclusive=1
  fi
else
  echo "note: agent not running; process log level not checked"
fi

echo "total hits: $hits, violations: $violations"
[ "$hits" -eq 0 ] && [ "$violations" -eq 0 ] || exit 1
[ "$inconclusive" -eq 0 ] || { echo "result: INCONCLUSIVE"; exit 3; }
exit 0
