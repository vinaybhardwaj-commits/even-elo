#!/usr/bin/env bash
# L-C3/L-C4: after a session, look for a canary patient string on disk and in the journal.
# Expected result: zero hits. The canary is read from stdin (or $STUDIO_CANARY) so it never
# appears in argv or shell history, and it is never printed; only paths and counts are.
#
#   printf '%s' "$CANARY" | sudo ./post-session-check.sh [--dry-run]
set -uo pipefail

DIRS=(/var /tmp /opt/studio-agent)
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

if [ "$DRY" = 1 ]; then
  echo "+ read canary from stdin or STUDIO_CANARY (not echoed, not in argv)"
  for d in "${DIRS[@]}"; do
    echo "+ grep -rlaF -f <canary fd> $d   # prints matching paths only"
  done
  echo "+ journalctl --no-pager -a | grep -cF -f <canary fd>"
  echo "expect: 0 file hits, 0 journal hits; exit 1 otherwise"
  exit 0
fi

[ "$(id -u)" = 0 ] || { echo "run as root so all of /var and the journal are readable" >&2; exit 2; }

canary=${STUDIO_CANARY:-}
if [ -z "$canary" ] && [ ! -t 0 ]; then IFS= read -r canary || true; fi
[ -n "$canary" ] || { echo "no canary supplied (stdin or STUDIO_CANARY)" >&2; exit 2; }
[ "${#canary}" -ge 8 ] || { echo "canary too short to be meaningful" >&2; exit 2; }

hits=0
for d in "${DIRS[@]}"; do
  [ -d "$d" ] || continue
  while IFS= read -r f; do
    echo "HIT file: $f"; hits=$((hits + 1))
  done < <(grep -rlaF -s --exclude-dir=proc -f <(printf '%s\n' "$canary") "$d" 2>/dev/null)
done

jc=$(journalctl --no-pager -a 2>/dev/null | grep -cF -f <(printf '%s\n' "$canary"))
echo "journal hits: ${jc:-0}"
hits=$((hits + ${jc:-0}))

echo "total hits: $hits"
[ "$hits" -eq 0 ]
