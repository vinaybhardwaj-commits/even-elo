#!/usr/bin/env bash
# Rebuild the studio-agent egress layers from the current DNS answer for the Neon host(s):
#   1. nftables table inet studio_agent (uid studio-agent: proxy port + Neon:5432 only)
#   2. a marked block in /etc/hosts (the agent uid has no DNS at all)
#   3. systemd IPAddressAllow= on studio-agent.service (independent second layer)
# Runs as root from studio-agent-nft.service (start) and the refresh timer.
# If resolution fails the existing rules are left as they are and the script exits 1.
#   --check   render and `nft -c` only; addresses from $STUDIO_EGRESS_TEST_IPS; changes nothing.
set -euo pipefail

CONF=/etc/studio-agent/egress.conf
SVC=studio-agent
PROXY_PORT=8888
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

if [ "$CHECK" = 1 ]; then
  NEON_HOSTS=${NEON_HOSTS:-example.invalid}
  UID_AGENT=$(id -u "$SVC" 2>/dev/null || echo 65000) # user may not exist yet (dry-run)
else
  # shellcheck source=/dev/null
  . "$CONF"
  UID_AGENT=$(id -u "$SVC")
fi

resolve_hosts() { # prints "host addr" lines, v4-mapped stripped
  local h a
  for h in $NEON_HOSTS; do
    # -s dns: ignore our own /etc/hosts block, otherwise a refresh would re-read stale answers
    getent -s dns ahosts "$h" | awk '{print $1}' | sed 's/^::ffff://' | sort -u | while read -r a; do
      printf '%s %s\n' "$h" "$a"
    done
  done
}

if [ "$CHECK" = 1 ]; then
  pairs=""
  for a in ${STUDIO_EGRESS_TEST_IPS:-192.0.2.10 2001:db8::10}; do pairs+="check.invalid $a"$'\n'; done
else
  pairs=$(resolve_hosts)
fi
[ -n "$pairs" ] || { echo "neon host(s) did not resolve; leaving egress as is" >&2; exit 1; }

v4=$(awk 'NF && $2 !~ /:/ {print $2}' <<<"$pairs" | sort -u | paste -sd, -)
v6=$(awk 'NF && $2 ~ /:/ {print $2}' <<<"$pairs" | sort -u | paste -sd, -)

render_nft() {
  cat <<NFT
table inet studio_agent
delete table inet studio_agent
table inet studio_agent {
  chain out {
    type filter hook output priority 0; policy accept;
    # replies of the agent's own listener (inbound connections from the Funnel proxy)
    meta skuid $UID_AGENT oifname "lo" ct state established,related accept
    # the only loopback destination: the allowlist proxy
    meta skuid $UID_AGENT ip daddr 127.0.0.1 tcp dport $PROXY_PORT accept
NFT
  [ -z "$v4" ] || echo "    meta skuid $UID_AGENT ip daddr { $v4 } tcp dport 5432 accept"
  [ -z "$v6" ] || echo "    meta skuid $UID_AGENT ip6 daddr { $v6 } tcp dport 5432 accept"
  cat <<NFT
    meta skuid $UID_AGENT limit rate 10/minute log prefix "studio-agent-egress-drop "
    meta skuid $UID_AGENT counter drop
  }
}
NFT
}

if [ "$CHECK" = 1 ]; then
  if [ "$(id -u)" = 0 ]; then render_nft | nft -c -f -; else render_nft | unshare -rn nft -c -f -; fi
  echo "nft -c ok"
  exit 0
fi

render_nft | nft -f -

# /etc/hosts marked block (rewritten in place: it may be a bind mount)
tmp=$(mktemp)
sed '/^# BEGIN studio-agent-neon$/,/^# END studio-agent-neon$/d' /etc/hosts >"$tmp"
{
  echo "# BEGIN studio-agent-neon"
  awk '{print $2, $1}' <<<"$pairs"
  echo "# END studio-agent-neon"
} >>"$tmp"
cat "$tmp" >/etc/hosts
rm -f "$tmp"

# second layer: kernel-level IP filter on the unit (independent of nft)
allow="127.0.0.0/8 ::1/128"
while read -r a; do allow+=" $a"; done < <(awk 'NF {print $2}' <<<"$pairs" | sort -u)
systemctl set-property "$SVC.service" IPAddressAllow= "IPAddressAllow=$allow"
date +%s >/var/lib/studio-agent-egress-ok  # last-success stamp, read by post-session-check.sh
echo "egress refreshed: $(wc -l <<<"$pairs") neon address(es)"
