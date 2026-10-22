#!/usr/bin/env bash
# Rebuild the studio-agent egress layers from the CURRENT upstream DNS answer for the Neon host(s):
#   1. nftables table inet studio_agent:
#        uid studio-agent  -> 127.0.0.1:8888 (ClientHello pre-filter -> squid on :8889, which this table does not open), 127.0.0.1:6432 (pgbouncer relay) and the t4 credential broker (tailnet IP:port) only
#        uid studio-pgrelay -> the pinned Neon IPs on :5432 only
#   2. IPAddressAllow= on studio-pgrelay.service (second layer; the agent unit is static 127.0.0.1/32)
#   3. /run/studio-agent/neon-pins.json  {"<host>": [ipv4..., ipv6...]}  (0640 root:studio-agent)
#   4. the relay's private hosts file /run/studio-agent/relay-hosts (via studio-pgrelay-render --hosts-only) and a reload of the relay when pins changed
# The agent never sees Neon addresses: it only talks to the relay. Serialised with flock.
# Resolution bypasses NSS, /etc/hosts and the resolved cache (resolvectl query --cache=no --synthesize=no, else dig @upstream).
# If any host fails to resolve the script exits 1 and leaves the existing rules and pins as they are.
# After a success it starts the relay and the agent if they are enabled but not running (boot-time retry, see unit Restart=),
# unless an operator stopped them (/run/studio-agent/operator-stop, set by `install-studio-agent.sh --stop`).
#   --print-nft  with --check: print the rendered nft table instead of checking it (tests: allowlist diff).
#   --check   render and `nft -c` only; addresses from $STUDIO_EGRESS_TEST_IPS; changes nothing.
set -euo pipefail

CONF=/etc/studio-agent/egress.conf
EXTRA_HOSTS=/etc/studio-agent/neon-hosts.extra
SVC=studio-agent
RELAY_SVC=studio-pgrelay
PROXY_PORT=8888
RELAY_PORT=6432
RELAY_BIN=/usr/local/sbin/studio-pgrelay-render
RUN_DIR=/run/studio-agent
PINS=$RUN_DIR/neon-pins.json
STAMP=/var/lib/studio-agent-egress-ok
STOP_FLAG=/run/studio-agent/operator-stop
LOCK=/run/lock/studio-agent-egress.lock
CHECK=0 PRINT=0
[ "${1:-}" = "--check" ] && CHECK=1
[ "${2:-}" = "--print-nft" ] && PRINT=1

if [ "$CHECK" = 1 ]; then
  NEON_HOSTS=${NEON_HOSTS:-example.invalid}
  UID_AGENT=$(id -u "$SVC" 2>/dev/null || echo 65000) # users may not exist yet (dry-run)
  UID_RELAY=$(id -u "$RELAY_SVC" 2>/dev/null || echo 65001)
  BROKER_ADDR=100.64.0.1:8765
else
  # shellcheck source=/dev/null
  . "$CONF"
  UID_AGENT=$(id -u "$SVC")
  UID_RELAY=$(id -u "$RELAY_SVC")
  # extra relay-only Neon hosts (one per line), kept apart from egress.conf so an installer run cannot drop them: ops/cdmss/relay-install.sh
  # writes the CDMSS endpoint here. They are pinned and allowed for the relay uid on :5432 exactly like a --neon-host, nothing broader.
  if [ -s "$EXTRA_HOSTS" ]; then
    while read -r h _ || [ -n "$h" ]; do
      if [[ $h =~ ^[A-Za-z0-9.-]+$ ]]; then NEON_HOSTS="$NEON_HOSTS $h"; fi
    done <"$EXTRA_HOSTS"
  fi
  [ -n "${BROKER_ADDR:-}" ] || { echo "BROKER_ADDR missing from $CONF (rerun the installer with --broker)" >&2; exit 1; }
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

BROKER_IP=${BROKER_ADDR%:*}
BROKER_PORT=${BROKER_ADDR##*:}

render_nft() {
  cat <<NFT
table inet studio_agent
delete table inet studio_agent
table inet studio_agent {
  chain out {
    type filter hook output priority 0; policy accept;
    # the ClientHello pre-filter (:$PROXY_PORT) serves the agent and the relay uid only: another local uid cannot hold its connection slots
    tcp dport $PROXY_PORT ip daddr 127.0.0.1 meta skuid != { $UID_AGENT, $UID_RELAY } counter drop
    # replies of the agent's and the relay's own listeners (inbound connections on loopback)
    meta skuid { $UID_AGENT, $UID_RELAY } oifname "lo" ct state established,related accept
    # the agent: the allowlist proxy and the Neon relay on loopback, and the t4 credential broker on the tailnet, nothing else
    meta skuid $UID_AGENT ip daddr 127.0.0.1 tcp dport { $PROXY_PORT, $RELAY_PORT } accept
    meta skuid $UID_AGENT ip daddr $BROKER_IP tcp dport $BROKER_PORT accept
    meta skuid $UID_AGENT limit rate 10/minute log prefix "studio-agent-egress-drop "
    meta skuid $UID_AGENT counter drop
    # the relay: the pinned Neon addresses on 5432, nothing else
NFT
  [ -z "$v4" ] || echo "    meta skuid $UID_RELAY ip daddr { $v4 } tcp dport 5432 accept"
  [ -z "$v6" ] || echo "    meta skuid $UID_RELAY ip6 daddr { $v6 } tcp dport 5432 accept"
  cat <<NFT
    meta skuid $UID_RELAY limit rate 10/minute log prefix "studio-pgrelay-egress-drop "
    meta skuid $UID_RELAY counter drop
  }
}
NFT
}

if [ "$CHECK" = 1 ] && [ "$PRINT" = 1 ]; then
  render_nft
  exit 0
fi
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

# nft first so the new addresses are reachable before the relay sees them
render_nft | nft -f -
allow="127.0.0.1/32"
while read -r a; do allow+=" $a"; done < <(awk 'NF {print $2}' <<<"$pairs" | sort -u)
systemctl set-property "$RELAY_SVC.service" IPAddressAllow= "IPAddressAllow=$allow"

mv -f "$newpins" "$PINS"
"$RELAY_BIN" --hosts-only  # (re)writes the relay's private hosts file in place; it must exist before the relay starts
if [ "$changed" = 1 ] && systemctl is-active --quiet "$RELAY_SVC.service"; then
  # the relay's hosts file is a bind-mounted inode that is only ever replaced (rename), never rewritten: a restart picks up
  # the new one. The agent only Wants the relay, so it is not restarted. --no-block: we may run inside studio-agent-nft.service.
  systemctl --no-block restart "$RELAY_SVC.service" || true
fi
# boot-time retry: once Neon resolves, bring up whatever is enabled but not running
for u in "$RELAY_SVC" "$SVC"; do
  [ ! -e "$STOP_FLAG" ] || continue  # an operator stopped them: stay down
  if systemctl is-enabled --quiet "$u.service" 2>/dev/null && ! systemctl is-active --quiet "$u.service"; then
    systemctl reset-failed "$u.service" 2>/dev/null || true
    systemctl --no-block start "$u.service" || true
  fi
done
date +%s >"$STAMP"  # last-success stamp, read by post-session-check.sh
echo "egress refreshed: $(wc -l <<<"$pairs") neon address(es), pins changed: $changed"
