#!/usr/bin/env bash
# L-C3/L-C4: after a session, look for a canary patient string on disk (plain and .gz) and in the journal.
# The canary is read from stdin (or $STUDIO_CANARY) so it never appears in argv or shell history.
# /var /tmp /run /opt/studio-agent plus the journal (which includes the volatile one under /run/log/journal);
# a canary in a file NAME alone is reported too. Only a hash of each hit path is printed (plus the path itself when it does not contain the canary),
# never the canary and never file contents.
#
#   printf '%s' "$CANARY" | sudo ./post-session-check.sh [--dry-run]
# Also reports (R3-3.2, informational, never a failure): per session the number of Squid terminations (no-SNI, SNI mismatch, denied CONNECT),
# the ClientHello pre-filter drops, and the bytes tunnelled to each allowed name (api.typesafe.ai included) from the Squid access log in the journal.
# The session starts at the agent's last start (override: STUDIO_SESSION_SINCE="YYYY-MM-DD HH:MM:SS"; none known: the whole journal).
# Also checks: egress-refresh last success <= 15 min old, and STUDIO_LOG_LEVEL is INFO or higher (env file and running process).
# Exit: 0 clean (or PURGED: secrets were purged, nothing found), 1 hit(s) or log-level violation, 2 usage, 3 INCONCLUSIVE (unreadable path, journalctl failure,
# missing/stale egress-refresh stamp, unreadable env; nothing worse seen).
set -uo pipefail

DIRS=(/var /tmp /run /opt/studio-agent)
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

if [ "$DRY" = 1 ]; then
  echo "+ read canary from stdin or STUDIO_CANARY (not echoed, not in argv)"
  for d in "${DIRS[@]}"; do
    echo "+ grep -rlaF -D skip -f <canary fd> $d      # plain files"
    echo "+ find $d -print0 | grep -azF -f <canary fd>   # canary in a file NAME only"
    echo "+ find $d -name '*.gz|*.xz|*.zst' | zgrep/xzgrep/zstdgrep -qaF -f <canary fd>   # compressed rotated logs"
  done
  echo "+ journalctl --no-pager -a | grep -cF -f <canary fd>"
  echo "+ journalctl -t squid --since <agent start|STUDIO_SESSION_SINCE>: count bump=terminate (no-sni / sni-mismatch), TCP_DENIED, sum in=/out= of TCP_TUNNEL per host"
  echo "+ journalctl -u studio-prefilter --since <same>: count 'prefilter drop reason=' (ech / malformed / other)"
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
purged=0
declare -A seen   # a path is reported once, however many scanners find it
errfile=$(mktemp)
finderr=$(mktemp)
trap 'rm -f "$errfile" "$finderr"' EXIT

report_hit() { # $1 = path
  [ -z "${seen[$1]:-}" ] || return 0
  seen[$1]=1
  local h
  h=$(printf '%s' "$1" | sha256sum | cut -c1-16)
  if [[ $1 == *"$canary"* ]]; then echo "HIT path-sha256:$h"; else echo "HIT path-sha256:$h  $1"; fi
  hits=$((hits + 1))
}
report_name_hit() { # $1 = path whose NAME contains the canary (content may be clean)
  [ -z "${seen[name:$1]:-}" ] || return 0
  seen[name:$1]=1
  echo "HIT (file name contains the canary) path-sha256:$(printf '%s' "$1" | sha256sum | cut -c1-16)"
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
  # canary in a file or directory NAME (no content hit needed)
  while IFS= read -r -d '' f; do report_name_hit "$f"; done \
    < <(find "$d" -xdev -print0 2>>"$finderr" | grep -azF -f <(printf '%s\n' "$canary"))
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

# ---- R3-3.2: what left through the proxy during this session (informational; a journal read failure is INCONCLUSIVE)
since=${STUDIO_SESSION_SINCE:-}
src="STUDIO_SESSION_SINCE"
if [ -z "$since" ]; then
  ts=$(systemctl show studio-agent -p ActiveEnterTimestamp --value 2>/dev/null)
  if [ -n "$ts" ] && since=$(date -d "$ts" '+%Y-%m-%d %H:%M:%S' 2>/dev/null); then src="agent start"; else since=""; fi
fi
jargs=(--no-pager -a -o cat)
if [ -n "$since" ]; then jargs+=(--since "$since"); echo "egress session: since $since ($src)"; else echo "egress session: whole journal (no agent start time, no STUDIO_SESSION_SINCE)"; fi
sqlog=$(mktemp); pflog=$(mktemp)
if journalctl "${jargs[@]}" -t squid >"$sqlog" 2>"$errfile" && journalctl "${jargs[@]}" -u studio-prefilter >"$pflog" 2>>"$errfile" && [ ! -s "$errfile" ]; then
  awk -v hosts="$( [ -r /etc/studio-proxy/hosts.txt ] && tr '\n' ' ' </etc/studio-proxy/hosts.txt )" '
    function kv(k,   i, p) { for (i = 1; i <= NF; i++) { p = k "="; if (index($i, p) == 1) return substr($i, length(p) + 1) } return "" }
    BEGIN { n = split(hosts, h, " "); for (i = 1; i <= n; i++) seen[h[i]] = 1 }
    {
      host = $3; sub(/:[0-9]+$/, "", host); sni = kv("sni"); bump = kv("bump")
      if ($1 ~ /^TCP_TUNNEL\// && $2 == "CONNECT") { seen[host] = 1; tn[host]++; bin[host] += kv("in"); bout[host] += kv("out") }
      else if (bump == "terminate") { if (sni == "-" || sni == "") nosni++; else if (sni != host) mism++; else other++ }
      else if ($1 ~ /^TCP_DENIED\//) denied++
    }
    END {
      printf "egress terminations: %d (no-sni=%d, sni-mismatch=%d, other=%d); denied CONNECTs: %d\n", nosni + mism + other, nosni, mism, other, denied
      for (k in seen) printf "egress tunnelled %s: tunnels=%d bytes_in(client->server)=%d bytes_out(server->client)=%d\n", k, tn[k], bin[k], bout[k]
    }' "$sqlog" | sort
  pd=$(grep -c '^prefilter drop ' "$pflog"); pe=$(grep -c '^prefilter drop reason=ech ' "$pflog"); pm=$(grep -c '^prefilter drop reason=malformed' "$pflog")
  echo "egress prefilter drops: $pd (ech=$pe, malformed=$pm, other=$((pd - pe - pm)))"
else
  echo "INCONCLUSIVE: could not read the squid / prefilter journal for the egress tally"; inconclusive=1
fi
rm -f "$sqlog" "$pflog"

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
elif [ ! -e /etc/studio-agent/env ] && [ ! -e /etc/studio-pgrelay/neon.env ]; then
  echo "PURGED: no agent env and no Neon credentials on this host (--purge-secrets ran); log-level check skipped"; purged=1
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
[ "$purged" -eq 0 ] || { echo "result: PURGED (clean)"; exit 0; }
exit 0
