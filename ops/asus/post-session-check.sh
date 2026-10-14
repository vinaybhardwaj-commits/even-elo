#!/usr/bin/env bash
# L-C3/L-C4: after a session, look for a canary patient string on disk (plain and .gz) and in the journal.
# The canary is read from stdin (or $STUDIO_CANARY) so it never appears in argv or shell history.
# Only a hash of each hit path is printed (plus the path itself when it does not contain the canary),
# never the canary and never file contents.
#
#   printf '%s' "$CANARY" | sudo ./post-session-check.sh [--dry-run]
# Exit: 0 clean, 1 hit(s), 2 usage, 3 INCONCLUSIVE (an unreadable path or a journalctl failure; no hits seen).
set -uo pipefail

DIRS=(/var /tmp /opt/studio-agent)
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

if [ "$DRY" = 1 ]; then
  echo "+ read canary from stdin or STUDIO_CANARY (not echoed, not in argv)"
  for d in "${DIRS[@]}"; do
    echo "+ grep -rlaF -D skip -f <canary fd> $d      # plain files"
    echo "+ find $d -name '*.gz' | zgrep -qaF -f <canary fd>   # compressed rotated logs"
  done
  echo "+ journalctl --no-pager -a | grep -cF -f <canary fd>"
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
  while IFS= read -r -d '' f; do
    zgrep -qaF -f <(printf '%s\n' "$canary") "$f" 2>"$errfile"
    rc=$?
    if [ "$rc" = 0 ]; then report_hit "$f"
    elif [ "$rc" != 1 ]; then echo "INCONCLUSIVE: zgrep failed (rc=$rc) on path-sha256:$(printf '%s' "$f" | sha256sum | cut -c1-16)"; inconclusive=1
    fi
  done < <(find "$d" -xdev -type f -name '*.gz' -print0 2>"$finderr")
  if [ -s "$finderr" ]; then echo "INCONCLUSIVE: find could not read parts of $d"; inconclusive=1; fi
done

jc=$(journalctl --no-pager -a 2>"$errfile" | grep -cF -f <(printf '%s\n' "$canary"))
if [ -s "$errfile" ] || ! [[ $jc =~ ^[0-9]+$ ]]; then
  echo "INCONCLUSIVE: journalctl failed or printed errors"; inconclusive=1; jc=0
fi
echo "journal hits: $jc"
hits=$((hits + jc))

echo "total hits: $hits"
[ "$hits" -eq 0 ] || exit 1
[ "$inconclusive" -eq 0 ] || { echo "result: INCONCLUSIVE"; exit 3; }
exit 0
