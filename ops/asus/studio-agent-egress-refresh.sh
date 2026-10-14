#!/usr/bin/env bash
# Rebuild the studio-agent egress layers from the CURRENT upstream DNS answer for the Neon host(s):
#   1. nftables table inet studio_agent (uid studio-agent: proxy port + Neon:5432 only)
#   2. systemd IPAddressAllow= on studio-agent.service (independent second layer)
#   3. /run/studio-agent/neon-pins.json  {"<host>": [ipv4..., ipv6...]}  (0640 root:studio-agent)
#      The agent connects with hostaddr= taken from this file; the agent uid has no DNS and /etc/hosts is not touched.
# Serialised with flock. The agent is restarted only when the pins changed.
# Resolution bypasses NSS, /etc/hosts and the resolved cache (resolvectl query --cache=no --synthesize=no, else dig @upstream).
# If any host fails to resolve the script exits 1 and leaves the existing rules and pins as they are.
#   --check   render and `nft -c` only; addresses from $STUDIO_EGRESS_TEST_IPS; changes nothing.
set -euo pipefail

CONF=/etc/studio-agent/egress.conf
SVC=studio-agent
PROXY_PORT=8888
RUN_DIR=/run/studio-agent
PINS=$RUN_DIR/neon-pins.json
STAMP=/var/lib/studio-agent-egress-ok
LOCK=/run/lock/studio-agent-egress.lock
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

if [ "$CHECK" = 1 ]; then
  NEON_HOSTS=${NEON_HOSTS:-example.invalid}
  UID_AGENT=$(id -u "$SVC" 2>/dev/null || echo 65000) # user may not exist yet (dry-run)
else
  # shellcheck source=/dev/null
  . "$CONF"
  UID_AGENT=$(id -u "$SVC")
  mkdir -p "$(dirname "$LOCK")"
  exec 9>"$LOCK"
  flock 9
fi

resolve_pairs() { # prints "host addr" lines
  NEON_HOSTS="$NEON_HOSTS" python3 - <<'PY'
import ipaddress, json, os, subprocess, sys

def via_resolved(host, rtype):
    # hostname-mode query (-4/-6): --cache=no skips the resolved cache, --synthesize=no ignores /etc/hosts
    fam = "-4" if rtype == "A" else "-6"
    r = subprocess.run(["resolvectl", "query", fam, "--legend=no", "--cache=no", "--synthesize=no", host],
                       capture_output=True, text=True, timeout=20)
    out = []
    for tok in r.stdout.replace(host + ":", " ").split():
        try:
            out.append(str(ipaddress.ip_address(tok.split("%")[0])))
        except ValueError:
            pass
    return out

def upstreams():
    ns = []
    try:
        for line in open("/etc/resolv.conf"):
            p = line.split()
            if len(p) >= 2 and p[0] == "nameserver" and p[1] != "127.0.0.53":
                ns.append(p[1])
    except OSError:
        pass
    return ns

def via_dig(host, rtype):
    out = []
    for ns in upstreams():
        r = subprocess.run(["dig", "@" + ns, "+short", "+time=3", "+tries=1", rtype, host],
                           capture_output=True, text=True, timeout=20)
        for line in r.stdout.split():
            try:
                out.append(str(ipaddress.ip_address(line)))
            except ValueError:
                pass
        if out:
            break
    return out

use_resolved = subprocess.run(["resolvectl", "status"], capture_output=True).returncode == 0 \
    if subprocess.run(["which", "resolvectl"], capture_output=True).returncode == 0 else False
rc = 0
for host in os.environ["NEON_HOSTS"].split():
    addrs = []
    for rtype in ("A", "AAAA"):
        addrs += (via_resolved if use_resolved else via_dig)(host, rtype)
    if not addrs:
        print("no address for " + host, file=sys.stderr)
        rc = 1
    for a in sorted(set(addrs)):
        print(host, a)
sys.exit(rc)
PY
}

if [ "$CHECK" = 1 ]; then
  pairs=""
  for a in ${STUDIO_EGRESS_TEST_IPS:-192.0.2.10 2001:db8::10}; do pairs+="check.invalid $a"$'\n'; done
else
  pairs=$(resolve_pairs) || { echo "neon host(s) did not resolve upstream; leaving egress and pins as they are" >&2; exit 1; }
fi
[ -n "$pairs" ] || { echo "no neon addresses; leaving egress as is" >&2; exit 1; }

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

install -d -o root -g "$SVC" -m 0750 "$RUN_DIR"
newpins=$(mktemp "$RUN_DIR/.pins.XXXXXX")
PAIRS="$pairs" python3 - "$newpins" <<'PY' || { rm -f "$newpins"; exit 1; }
import json, os, sys
pins = {}
for line in os.environ["PAIRS"].splitlines():
    p = line.split()
    if len(p) == 2:
        pins.setdefault(p[0], []).append(p[1])
out = {h: sorted((a for a in v if ":" not in a)) + sorted((a for a in v if ":" in a)) for h, v in pins.items()}
json.dump(out, open(sys.argv[1], "w"), indent=1, sort_keys=True)
PY
chown "root:$SVC" "$newpins"
chmod 0640 "$newpins"

changed=1
if [ -f "$PINS" ] && cmp -s "$PINS" "$newpins"; then changed=0; fi

# nft first so the new addresses are reachable before any agent sees them in the pins file
render_nft | nft -f -
allow="127.0.0.1/32"
while read -r a; do allow+=" $a"; done < <(awk 'NF {print $2}' <<<"$pairs" | sort -u)
systemctl set-property "$SVC.service" IPAddressAllow= "IPAddressAllow=$allow"

mv -f "$newpins" "$PINS"
if [ "$changed" = 1 ]; then
  # --no-block: at boot/install we run inside studio-agent-nft.service, which the agent is ordered after
  systemctl --no-block try-restart "$SVC.service" || true
fi
date +%s >"$STAMP"  # last-success stamp, read by post-session-check.sh
echo "egress refreshed: $(wc -l <<<"$pairs") neon address(es), pins changed: $changed"
