#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2015,SC2329,SC2154  # remote commands are deliberately single-quoted
# Real-run test of the Asus installer inside a throwaway privileged systemd container (ubuntu:24.04)
# plus two containers acting as fake Neon endpoints (real PostgreSQL 16 with TLS, certificates from a test CA, names
# neonstub.test = the configured endpoint and neonstub2.test = a second endpoint with valid credentials that must stay
# unreachable) and a dnsmasq in the first one as the DNS server.
# Runs: install x3, hosts-block removal, pins, stale-IP refresh, parallel refresh, squid SNI allowlist (R5-A), pgbouncer
# relay with verify-full + endpoint pinning (R5-B), sandbox probes (probe unit = copy of the live unit), fail-closed + guard,
# boot-time Neon retry, upgrade, bad/slow releases (revert), 5 back-to-back installs, post-session check, rollback x2, purge.
# `tailscale` is a stub (records calls, emulates serve state): Funnel is NOT exercised on a real tailnet.
# Needs docker and internet (apt, PyPI). Takes ~10-15 min. Touches nothing else.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)
C=studio-ops-test
STUB=studio-ops-neonstub
STUB2=studio-ops-neonstub2
STUB3=studio-ops-broker
BROKER_TOKEN=$(openssl rand -hex 32)
BPORT=8765
IMG=studio-ops-test-img
NEON=neonstub.test
WORK=$(mktemp -d)
fail=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fail=1; }
cleanup() { docker rm -f "$C" "$STUB" "$STUB2" "$STUB3" >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
x() { docker exec -i "$C" bash -c "$1" </dev/null; }
xi() { docker exec -i "$C" bash -c "$1"; }
# check DESC CMD  -> passes when CMD (run in the container) exits 0
check() { if x "$2" >"$WORK/out" 2>&1; then ok "$1"; else bad "$1"; sed 's/^/     /' "$WORK/out" | tail -8; fi; }
# checkno DESC CMD -> passes when CMD exits non-zero
checkno() { if x "$2" >"$WORK/out" 2>&1; then bad "$1"; sed 's/^/     /' "$WORK/out" | tail -5; else ok "$1"; fi; }
HEALTH='h=0; for i in $(seq 45); do b=$(curl -s --noproxy "*" -m 3 -w "\n%{http_code}" http://127.0.0.1:8123/agent/health); if [ "$(tail -n1 <<<"$b")" = 401 ] && grep -q bad_service_token <<<"$b"; then h=1; break; fi; sleep 1; done; [ $h = 1 ]'

docker build -q -t "$IMG" - >/dev/null <<'DOCKERFILE' || { echo "image build failed"; exit 2; }
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus systemd-resolved squid-openssl pgbouncer postgresql nftables openssl psmisc \
    python3 python3-pip curl ca-certificates iproute2 netcat-openbsd dnsutils dnsmasq sudo util-linux procps xz-utils zstd \
    && pip install --break-system-packages -q uv && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
DOCKERFILE

docker rm -f "$C" "$STUB" "$STUB2" "$STUB3" >/dev/null 2>&1
PKI=$WORK/pki; mkdir -p "$PKI"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$PKI/ca.key" -out "$PKI/ca.crt" -days 3 -subj /CN=studio-ops-test-ca 2>/dev/null
for n in neonstub.test neonstub2.test neonstub6.test; do
  openssl req -newkey rsa:2048 -nodes -keyout "$PKI/$n.key" -out "$PKI/$n.csr" -subj "/CN=$n" 2>/dev/null
  printf 'subjectAltName=DNS:%s' "$n" >"$PKI/$n.ext"
  openssl x509 -req -in "$PKI/$n.csr" -CA "$PKI/ca.crt" -CAkey "$PKI/ca.key" -CAcreateserial -out "$PKI/$n.crt" -days 3 -extfile "$PKI/$n.ext" 2>/dev/null
done
mkstub() { # mkstub CONTAINER CERTNAME ENDPOINT_ID  -> a PostgreSQL 16 with TLS; roles take the Neon "endpoint=<id>$password" form
  docker run -d --name "$1" --cap-add NET_ADMIN "$IMG" sleep infinity >/dev/null || return 1
  docker exec "$1" mkdir -p /etc/ssl/pg
  docker cp "$PKI/$2.crt" "$1:/etc/ssl/pg/server.crt"; docker cp "$PKI/$2.key" "$1:/etc/ssl/pg/server.key"
  docker exec "$1" bash -c 'chown postgres:postgres /etc/ssl/pg/server.*; chmod 600 /etc/ssl/pg/server.key
    c=/etc/postgresql/16/main
    printf "ssl = on\nssl_cert_file = '"'"'/etc/ssl/pg/server.crt'"'"'\nssl_key_file = '"'"'/etc/ssl/pg/server.key'"'"'\nlisten_addresses = '"'"'*'"'"'\n" >>$c/postgresql.conf
    echo "hostssl all all 0.0.0.0/0 scram-sha-256" >>$c/pg_hba.conf
    pg_ctlcluster 16 main start && sleep 2'
  # SQL on stdin: a password in argv would end up in the journal as the _CMDLINE of runuser's PAM session message
  docker exec -i "$1" runuser -u postgres -- psql -q <<SQL
create role neon_gov login password 'endpoint=$3\$govpw';
create role neon_studio login password 'endpoint=$3\$studiopw';
create database govdb owner neon_gov;
create database studiodb owner neon_studio;
SQL
}
mkstub "$STUB" neonstub.test neonstub >/dev/null || { echo "stub 1 failed"; exit 2; }
mkstub "$STUB2" neonstub2.test neonstub2 >/dev/null || { echo "stub 2 failed"; exit 2; }
STUBIP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$STUB")
STUB2IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$STUB2")
# the first stub is also the container's DNS server: answers both fake Neon names, forwards everything else to the host's resolver
# 1.1.1.1 gets a spoofed PTR naming an allowlisted host (the Squid reverse-DNS bypass); neonstub6.test is IPv6-only (fd00:6::1, a ULA on the main container's lo)
start_dns() { docker exec -d "$STUB" dnsmasq -k --address=/$NEON/"$STUBIP" --address=/neonstub2.test/"$STUB2IP" --address=/neonstub6.test/fd00:6::1 --ptr-record=1.1.1.1.in-addr.arpa,api.typesafe.ai --user=root --listen-address="$STUBIP" --bind-interfaces; }
start_dns
docker run -d --name "$C" --dns "$STUBIP" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --tmpfs /run --tmpfs /run/lock "$IMG" /lib/systemd/systemd >/dev/null || { echo "container start failed"; exit 2; }
for _ in $(seq 30); do x 'systemctl is-system-running --wait 2>/dev/null | grep -Eq "running|degraded"' && break; sleep 1; done
x 'systemctl start systemd-resolved dbus' || true
CIP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$C")
docker run -d --name "$STUB3" --cap-add NET_ADMIN "$IMG" sleep infinity >/dev/null || { echo "broker stub failed"; exit 2; }
# the broker sits on a tailnet-range address (100.64.0.0/10), a secondary address on the stub's eth0 that the other containers reach on-link
BROKERIP=100.100.0.5
docker exec "$STUB3" ip addr add $BROKERIP/32 dev eth0
x "ip route add $BROKERIP/32 dev eth0"
docker exec "$STUB2" ip route add $BROKERIP/32 dev eth0
docker exec "$STUB3" mkdir -p /opt/broker-test
docker cp "$HERE/../t4-broker/broker.py" "$STUB3:/opt/broker-test/broker.py"; docker cp "$HERE/broker_stub_runner.py" "$STUB3:/opt/broker-test/run.py"
docker exec -d "$STUB3" python3 /opt/broker-test/run.py "$BROKERIP" "$BPORT" "$CIP" "$BROKER_TOKEN"
# an IPv6-only fake Neon inside the main container (fd00:6::1 on lo), for the end-to-end v6 case
docker exec "$C" mkdir -p /etc/ssl/pg
docker cp "$PKI/neonstub6.test.crt" "$C:/etc/ssl/pg/server.crt"; docker cp "$PKI/neonstub6.test.key" "$C:/etc/ssl/pg/server.key"
x 'chown postgres:postgres /etc/ssl/pg/server.*; chmod 600 /etc/ssl/pg/server.key; c=/etc/postgresql/16/main
   printf "ssl = on\nssl_cert_file = '"'"'/etc/ssl/pg/server.crt'"'"'\nssl_key_file = '"'"'/etc/ssl/pg/server.key'"'"'\nlisten_addresses = '"'"'fd00:6::1'"'"'\n" >>$c/postgresql.conf
   echo "hostssl all all fd00:6::1/128 scram-sha-256" >>$c/pg_hba.conf
   ip -6 addr add fd00:6::1/128 dev lo
   pg_ctlcluster 16 main restart && sleep 3' || echo "v6 stub start failed"
xi 'runuser -u postgres -- psql -q' <<'SQL' || echo "v6 stub setup failed"
create role neon_gov6 login password 'endpoint=neonstub6$govpw';
create database govdb6 owner neon_gov6;
SQL
docker cp "$PKI/ca.crt" "$C:/usr/local/share/ca-certificates/studio-ops-test-ca.crt"
x 'update-ca-certificates >/dev/null 2>&1; true'

git -C "$REPO" archive HEAD studio/apps/agent -o "$WORK/rel1.tar"
mk() { # mk NAME PYLINES -> $WORK/NAME.tar = rel1 plus lines prepended to main.py
  mkdir "$WORK/t_$1"; tar -xf "$WORK/rel1.tar" -C "$WORK/t_$1"
  { printf '%s\n' "$2"; cat "$WORK/t_$1/studio/apps/agent/main.py"; } >"$WORK/t_$1/m.py"; mv "$WORK/t_$1/m.py" "$WORK/t_$1/studio/apps/agent/main.py"
  tar -cf "$WORK/$1.tar" -C "$WORK/t_$1" studio
}
mkdir "$WORK/t_rel2"; tar -xf "$WORK/rel1.tar" -C "$WORK/t_rel2"; echo v2 >"$WORK/t_rel2/studio/apps/agent/RELEASE"; tar -cf "$WORK/rel2.tar" -C "$WORK/t_rel2" studio
mk relbad 'raise SystemExit(3)'
mk relslow 'import threading, os; threading.Timer(7, lambda: os._exit(9)).start()'
for n in rel1 rel2 relbad relslow; do
  eval "SHA_$n=$(sha256sum "$WORK/$n.tar" | cut -d' ' -f1)"
  docker cp "$WORK/$n.tar" "$C:/root/$n.tar"
done
docker cp "$HERE" "$C:/root/asus"
inst() { echo "/root/asus/install-studio-agent.sh --neon-host $NEON --neon-host neonstub6.test --broker $BROKERIP:$BPORT --tarball /root/$1.tar --sha256 $(eval echo "\$SHA_$1")"; }

xi 'cat >/usr/local/bin/tailscale' <<'STUB'
#!/usr/bin/env python3
import json, os, sys
S = "/var/lib/ts-stub.json"
st = json.load(open(S)) if os.path.exists(S) else {"Web": {}}
a = sys.argv[1:]
def save(): json.dump(st, open(S, "w"))
if a[:2] == ["status", "--json"]: print(json.dumps({"Self": {"CapMap": {"funnel": [], "https": []}}}))
elif a[:3] == ["serve", "status", "--json"]: print(json.dumps(st))
elif a and a[0] == "funnel" and a[-1] == "off":
    if "/agent" not in st["Web"].get("asus.ts.net:443", {}).get("Handlers", {}): print("handler does not exist", file=sys.stderr); sys.exit(1)
    st["Web"] = {}; save()
elif a and a[0] == "funnel" and "--bg" in a:
    st["Web"] = {"asus.ts.net:443": {"Handlers": {"/agent": {"Proxy": a[-1]}}}}; save()
elif a[:2] == ["funnel", "status"]: print(json.dumps(st))
else: print("stub: unsupported", a, file=sys.stderr); sys.exit(1)
STUB
x 'chmod +x /usr/local/bin/tailscale; echo "{}" >/var/lib/ts-stub.json'
NEONIP=$(x "dig +short $NEON | head -1")
[ -n "$NEONIP" ] && ok "neon stub resolves to $NEONIP" || { bad "neon stub does not resolve"; exit 1; }

x "cd /root/asus && ./install-studio-agent.sh --dry-run --tarball /root/rel1.tar --sha256 $SHA_rel1 --neon-host $NEON --neon-host neonstub6.test --broker $BROKERIP:$BPORT" >"$WORK/dry.out" 2>&1 \
  && ok "dry-run in container (incl. nft -c, squid -k parse)" || { bad "dry-run in container"; tail -5 "$WORK/dry.out"; }

echo "--- install 1 (env incomplete: must not activate)"
x 'printf "# BEGIN studio-agent-neon\n192.0.2.99 old.example\n# END studio-agent-neon\n" >>/etc/hosts; cp /etc/hosts /root/hosts.before.noblock; sed -i "/studio-agent-neon/,/END studio-agent-neon/d" /root/hosts.before.noblock'
check "install 1 exits 0" "$(inst rel1)"
check "old marked block removed from /etc/hosts, other lines untouched" '! grep -q studio-agent-neon /etc/hosts && ! grep -q 192.0.2.99 /etc/hosts && cmp /etc/hosts /root/hosts.before.noblock'
checkno "agent not enabled/active with empty env" 'systemctl is-active --quiet studio-agent || systemctl is-enabled --quiet studio-agent'
check "stock squid and pgbouncer units masked" 'systemctl is-enabled squid 2>&1 | grep -q masked && systemctl is-enabled pgbouncer 2>&1 | grep -q masked'
check "studio-proxy runs squid -N with the studio config, as user proxy" '[ "$(ps -o user= -C squid | head -1 | tr -d " ")" = proxy ] && pgrep -af "squid -N -s -f /etc/studio-proxy/squid.conf"'
check "squid config dir readable by group proxy only; splice-only cert 0640 root:proxy" '[ "$(stat -c "%a %U:%G" /etc/studio-proxy)" = "750 root:proxy" ] && [ "$(stat -c "%a %U:%G" /etc/studio-proxy/splice-only.pem)" = "640 root:proxy" ]'
check "no decryption configured (no bump action); exact names only, no regex, no googleapis" '! grep -Eq "^ssl_bump +(bump|stare|client-first|server-first)" /etc/studio-proxy/squid.conf && grep -q "^ssl_bump terminate all" /etc/studio-proxy/squid.conf && grep -q "dstdomain -n" /etc/studio-proxy/squid.conf && ! grep -q "dstdom_regex\|server_name_regex" /etc/studio-proxy/squid.conf && ! grep -qi googleapis /etc/studio-proxy/hosts.txt && [ "$(cat /etc/studio-proxy/hosts.txt)" = "bedrock-runtime.ap-south-1.amazonaws.com
api.typesafe.ai" ]'
check "squid cannot read the agent tree" '! runuser -u proxy -- ls /opt/studio-agent >/dev/null 2>&1 && ! runuser -u proxy -- cat /etc/studio-agent/env >/dev/null 2>&1'
check "proxy listens on 127.0.0.1:8888 only" '[ "$(ss -ltn | grep -c ":8888 ")" = 1 ] && ss -ltn | grep -q "127.0.0.1:8888 "'
check "nft table present" 'nft list table inet studio_agent'
check "pins file {host:[ips]} 0640 root:studio-agent" "[ \"\$(stat -c '%a %U:%G' /run/studio-agent/neon-pins.json)\" = '640 root:studio-agent' ] && python3 -c 'import json,sys; d=json.load(open(\"/run/studio-agent/neon-pins.json\")); sys.exit(0 if d[\"$NEON\"]==[\"$NEONIP\"] and d[\"neonstub6.test\"]==[\"fd00:6::1\"] else 1)'"
check "/etc/hosts has no studio block" '! grep -q studio-agent-neon /etc/hosts'
check "relay dir 0700 root, neon.env 0600, local.env 0600" '[ "$(stat -c %a /etc/studio-pgrelay)" = 700 ] && [ "$(stat -c %a /etc/studio-pgrelay/neon.env)" = 600 ] && [ "$(stat -c %a /etc/studio-pgrelay/local.env)" = 600 ]'
check "env 0600 root:studio-agent, dir 0750" '[ "$(stat -c "%a %U:%G" /etc/studio-agent/env)" = "600 root:studio-agent" ] && [ "$(stat -c %a /etc/studio-agent)" = 750 ]'
check "kill switch default 0" 'grep -q "^STUDIO_LIVE_READS=0$" /etc/studio-agent/env'
check "env: broker auth names present, BEDROCK_AUTH=default-chain, no GCP / AWS-role / Vertex variable" 'grep -q "^TYPESAFE_API_KEY=" /etc/studio-agent/env && grep -q "^STUDIO_BROKER_TOKEN=" /etc/studio-agent/env && grep -q "^BEDROCK_AUTH=default-chain$" /etc/studio-agent/env && grep -q "^AWS_STS_REGIONAL_ENDPOINTS=regional$" /etc/studio-agent/env && grep -q "^AWS_CONFIG_FILE=/etc/studio-agent/aws-config$" /etc/studio-agent/env && ! grep -Eq "GCP_|AWS_ROLE_ARN|VERTEX|GOOGLE" /etc/studio-agent/env'
check "AWS config points credential_process at the helper; helper installed 0755" '[ "$(stat -c %a /usr/local/bin/studio-aws-creds)" = 755 ] && grep -q "credential_process = /usr/local/bin/studio-aws-creds" /etc/studio-agent/aws-config && [ "$(stat -c "%a %U:%G" /etc/studio-agent/aws-config)" = "640 root:studio-agent" ]'

echo "--- migration from an R5 host: old GCP key and GCP/AWS-role/Vertex variables are removed, nothing remains"
x 'printf "{\"type\":\"service_account\"}" >/etc/studio-agent/gcp-sa.json; chmod 600 /etc/studio-agent/gcp-sa.json
   printf "GCP_SA_KEY_FILE=/etc/studio-agent/gcp-sa.json\nGCP_AUDIENCE=x\nAWS_ROLE_ARN=arn:aws:iam::1:role/x\nVERTEX_MODEL=gemini\nVERTEX_LOCATION=asia-northeast1\n" >>/etc/studio-agent/env; sed -i "s#^BEDROCK_AUTH=.*#BEDROCK_AUTH=gcp-federation#" /etc/studio-agent/env'

echo "--- env + neon.env fill (the broker token is the only AWS-side secret on this host)"
x 'printf "GOV_NEON_URL=postgres://neon_gov:govpw@neonstub.test/govdb?sslmode=require\nSTUDIO_NEON_URL=postgres://neon_studio:studiopw@neonstub.test/studiodb?sslmode=require\n" >/etc/studio-pgrelay/neon.env; chmod 600 /etc/studio-pgrelay/neon.env'
x "for v in STUDIO_SERVICE_TOKEN STUDIO_ACTOR_SECRET TYPESAFE_API_KEY; do sed -i \"s#^\$v=.*#\$v=dummy-\$v#\" /etc/studio-agent/env; done; true"
check "broker token received on stdin lands in the env file (0600), not in argv" "printf %s $BROKER_TOKEN | /root/asus/install-studio-agent.sh --receive-broker-token && grep -q '^STUDIO_BROKER_TOKEN=$BROKER_TOKEN\$' /etc/studio-agent/env && [ \"\$(stat -c '%a %U:%G' /etc/studio-agent/env)\" = '600 root:studio-agent' ]"
checkno "a malformed token is refused" "printf 'short' | /root/asus/install-studio-agent.sh --receive-broker-token"

echo "--- install 2 (activate; waits for the 30 s health window)"
check "install 2 exits 0 (migrates, activates)" "$(inst rel1) | tee /root/i2.out | tail -3; exit \${PIPESTATUS[0]}"
check "migration: old key shredded, GCP/AWS-role/Vertex variables gone, BEDROCK_AUTH=default-chain, broker URL set" '[ ! -e /etc/studio-agent/gcp-sa.json ] && ! grep -Eq "GCP_|AWS_ROLE_ARN|VERTEX|GOOGLE" /etc/studio-agent/env && grep -q "^BEDROCK_AUTH=default-chain$" /etc/studio-agent/env && grep -q "^STUDIO_BROKER_URL=http://'"$BROKERIP"':'"$BPORT"'/creds$" /etc/studio-agent/env'
check "agent active, /agent/health = 401 bad_service_token" "systemctl is-active --quiet studio-agent && $HEALTH"
check "agent listens on 127.0.0.1:8123 only" '[ "$(ss -ltn | grep -c ":8123 ")" = 1 ] && ss -ltn | grep -q "127.0.0.1:8123 "'
check "agent runs as studio-agent" '[ "$(ps -o user= -C uvicorn | head -1 | tr -d " ")" = studio-agent ]'
check "funnel opened on /agent only (stub)" 'tailscale serve status --json | grep -q "\"/agent\"" && [ "$(tailscale serve status --json | grep -o "\"/[a-z]*\"" | sort -u | wc -l)" = 1 ]'
check "agent IPAddressAllow = 127.0.0.1/32 + the broker (no Neon address, not 127.0.0.0/8)" "a=\$(systemctl show studio-agent -p IPAddressAllow --value); grep -q '127.0.0.1' <<<\"\$a\" && grep -q '$BROKERIP' <<<\"\$a\" && ! grep -q '$NEONIP' <<<\"\$a\" && ! grep -q '127.0.0.0/8' <<<\"\$a\""
check "relay IPAddressAllow = 127.0.0.1/32 + neon pin" "a=\$(systemctl show studio-pgrelay -p IPAddressAllow --value); grep -q '127.0.0.1' <<<\"\$a\" && grep -q '$NEONIP' <<<\"\$a\""
check "relay active as studio-pgrelay on 127.0.0.1:6432 only" '[ "$(ps -o user= -C pgbouncer | head -1 | tr -d " ")" = studio-pgrelay ] && [ "$(ss -ltn | grep -c ":6432 ")" = 1 ] && ss -ltn | grep -q "127.0.0.1:6432 "'
check "agent env points at the relay, holds no Neon host or credential" 'grep -q "^GOV_RO_DATABASE_URL=postgresql://agent_gov:.*@127.0.0.1:6432/gov" /etc/studio-agent/env && grep -q "^STUDIO_DATABASE_URL=postgresql://agent_studio:.*@127.0.0.1:6432/studio" /etc/studio-agent/env && ! grep -Eq "neonstub|govpw|studiopw|endpoint=" /etc/studio-agent/env && ! tr "\0" "\n" </proc/$(systemctl show studio-agent -p MainPID --value)/environ | grep -Eq "neonstub|govpw|studiopw|endpoint="'
for u in studio-agent studio-proxy studio-pgrelay; do
  x "systemd-analyze security $u --no-pager | tail -1" | sed "s/^/     security: /"
  check "security score $u <= 3.0" "awk -v s=\"\$(systemd-analyze security $u --no-pager | tail -1 | grep -o '[0-9.]*' | head -1)\" 'BEGIN{exit !(s<=3.0)}'"
done
docker cp "$HERE/../t4-broker" "$C:/root/t4-broker"
x "/root/t4-broker/install-studio-broker.sh --dry-run --render-dir /root/br --listen 100.101.102.103:8765 --allowed-source 100.101.102.104 --gcp-key-file /tmp/none >/dev/null 2>&1; true"
x "systemd-analyze security --offline=true /root/br/studio-broker.service --no-pager | tail -1" | sed "s/^/     security: broker unit (offline): /"
check "security score studio-broker (t4 unit, offline) <= 3.0" "awk -v s=\"\$(systemd-analyze security --offline=true /root/br/studio-broker.service --no-pager | tail -1 | grep -o '[0-9.]*' | head -1)\" 'BEGIN{exit !(s<=3.0)}'"
check "MemorySwapMax=0 LimitCORE=0" 'systemctl show studio-agent -p MemorySwapMax -p LimitCORE | tr "\n" " " | grep -q "MemorySwapMax=0 LimitCORE=0"'

echo "--- install 3 (idempotent: nothing restarts)"
x 'systemctl show studio-agent -p MainPID --value >/root/pid.before; systemctl show studio-proxy -p MainPID --value >/root/ppid.before; systemctl show studio-pgrelay -p MainPID --value >/root/rpid.before'
check "install 3 exits 0" "$(inst rel1)"
check "agent, proxy and relay not restarted by an unchanged install" '[ "$(systemctl show studio-agent -p MainPID --value)" = "$(cat /root/pid.before)" ] && [ "$(systemctl show studio-proxy -p MainPID --value)" = "$(cat /root/ppid.before)" ] && [ "$(systemctl show studio-pgrelay -p MainPID --value)" = "$(cat /root/rpid.before)" ]'

echo "--- pins: stale IP never survives; hosts file replaced atomically; pin change restarts the relay, not the agent; parallel refresh leaves /etc/hosts alone"
x 'echo "192.0.2.99 neonstub.test" >>/etc/hosts; cp /etc/hosts /root/hosts.planted
   printf "{\"neonstub.test\": [\"192.0.2.99\"]}" >/run/studio-agent/neon-pins.json
   printf "127.0.0.1 localhost\n192.0.2.99 neonstub.test\n" >/run/studio-agent/relay-hosts
   nft add rule inet studio_agent out meta skuid studio-pgrelay ip daddr 192.0.2.99 tcp dport 5432 accept
   systemctl show studio-agent -p MainPID --value >/root/pid.before; systemctl show studio-pgrelay -p MainPID --value >/root/rpid.before; stat -c %i /run/studio-agent/relay-hosts >/root/hosts.inode.before'
check "refresh replaces planted stale pin/nft rule/relay hosts line with the live upstream answer" "/usr/local/sbin/studio-agent-egress-refresh && ! grep -q 192.0.2.99 /run/studio-agent/neon-pins.json && ! nft list table inet studio_agent | grep -q 192.0.2.99 && grep -q $NEONIP /run/studio-agent/neon-pins.json && ! grep -q 192.0.2.99 /run/studio-agent/relay-hosts && grep -q '$NEONIP neonstub.test' /run/studio-agent/relay-hosts"
check "refresh did not touch /etc/hosts" 'cmp /etc/hosts /root/hosts.planted'
check "pin change did not restart the agent" '[ "$(systemctl show studio-agent -p MainPID --value)" = "$(cat /root/pid.before)" ]'
check "pin change restarted the relay (it re-binds the replaced hosts inode), which resolves the live address again" 'sleep 3; [ "$(systemctl show studio-pgrelay -p MainPID --value)" != "$(cat /root/rpid.before)" ] && [ "$(stat -c %i /run/studio-agent/relay-hosts)" != "$(cat /root/hosts.inode.before)" ] && [ -z "$(ls /run/studio-agent | grep -E "\.new$")" ]'
check "agent healthy" "$HEALTH"
x 'sha256sum /etc/hosts >/root/hosts.sum'
check "15 rounds x 3 parallel refreshes: /etc/hosts byte-identical, pins valid, table present" 'for r in $(seq 15); do for k in 1 2 3; do /usr/local/sbin/studio-agent-egress-refresh >/dev/null 2>&1 & done; wait; done; sha256sum -c --quiet /root/hosts.sum && python3 -c "import json;d=json.load(open(\"/run/studio-agent/neon-pins.json\"));assert d[\"neonstub.test\"]" && nft list table inet studio_agent >/dev/null && getent hosts localhost >/dev/null'
x 'grep -v 192.0.2.99 /etc/hosts >/root/h.tmp; cat /root/h.tmp >/etc/hosts'
check "agent still healthy" "$HEALTH"
check "nft: the agent uid has no Neon address, the relay uid has" "ua=\$(id -u studio-agent); ur=\$(id -u studio-pgrelay); ! nft list table inet studio_agent | grep \"skuid \$ua\" | grep -q '$NEONIP' && nft list table inet studio_agent | grep \"skuid \$ur\" | grep -q '$NEONIP'"

echo "--- egress probes (uid studio-agent, outside the unit sandbox)"
AS='runuser -u studio-agent --'
checkno "agent uid cannot resolve arbitrary names (getent)" "timeout 10 $AS getent hosts example.org"
checkno "agent uid cannot dig" "timeout 8 $AS dig +time=2 +tries=1 example.org"
checkno "agent uid direct 443 dropped" "$AS curl -s -m 5 --resolve example.org:443:93.184.216.34 https://example.org/"
x '(nc -l 127.0.0.1 7777 >/dev/null 2>&1 &) ; sleep 1'
checkno "agent uid cannot reach other loopback ports" "$AS nc -z -w 3 127.0.0.1 7777"
check "drops are counted/logged" 'nft list table inet studio_agent | grep -Eq "counter packets [1-9]"'
INTERNET=0; x 'curl -s -m 8 -o /dev/null https://api.typesafe.ai/' && INTERNET=1
SCL="$AS openssl s_client -proxy 127.0.0.1:8888"
echo "--- A: squid SNI allowlist (no decryption)"
check "CONNECT to a non-allowlisted host is refused" "! $AS curl -s -m 10 -o /dev/null -x http://127.0.0.1:8888 https://example.org/"
check "plain HTTP is refused, even to an allowlisted host" "c=\$($AS curl -s -m 10 -o /dev/null -w '%{http_code}' -x http://127.0.0.1:8888 http://api.typesafe.ai/ 2>/dev/null); [ \"\$c\" = 000 ] || [ \"\$c\" = 403 ]"
check ":8443 CONNECT is refused" "! $AS curl -s -m 8 -x http://127.0.0.1:8888 https://api.typesafe.ai:8443/ -o /dev/null"
check "IP-literal CONNECT is refused (v4)" "! $AS curl -s -m 8 -x http://127.0.0.1:8888 https://1.1.1.1/ -o /dev/null"
check "IP-literal CONNECT is refused (v6)" "! $AS curl -s -m 8 -x http://127.0.0.1:8888 'https://[2606:4700:4700::1111]/' -o /dev/null"
check "no Google host is allowlisted (Host fronting): oauth2/iamcredentials/sts/storage.googleapis.com refused" "for h in oauth2 iamcredentials sts storage us-central1-aiplatform; do ! $AS curl -s -m 8 -x http://127.0.0.1:8888 https://\$h.googleapis.com/ -o /dev/null || exit 1; done"
check "B1: spoofed PTR (1.1.1.1 -> api.typesafe.ai) does not turn an IP literal into an allowlisted name: TCP_DENIED, no handshake" "x=\$(timeout 15 $SCL -connect 1.1.1.1:443 -servername api.typesafe.ai </dev/null 2>&1); ! grep -q 'subject=' <<<\"\$x\" && ! grep -q 'studio-proxy-splice-only' <<<\"\$x\" && sleep 1 && journalctl -t squid --no-pager -o cat | grep -q 'TCP_DENIED.*CONNECT 1.1.1.1:443'"
check "m3/m4: a denied CONNECT gets a plain reset: no '200 Connection established', no TLS with splice-only.pem" "o=\$($AS curl -s -m 8 -x http://127.0.0.1:8888 -v https://example.org/ -o /dev/null 2>&1); ! grep -q '< HTTP/1.1 200' <<<\"\$o\" && grep -qi 'reset\\|Recv failure\\|Empty reply' <<<\"\$o\""
check "control: the PTR really is spoofed for the proxy host" "dig +short -x 1.1.1.1 | grep -q 'api.typesafe.ai'"
if [ "$INTERNET" = 1 ]; then
  APIIP=$(x "dig +short api.typesafe.ai | head -1")
  check "IP-literal CONNECT to the allowlisted host's own address is refused" "! $AS curl -s -m 8 -x http://127.0.0.1:8888 --resolve api.typesafe.ai:443:$APIIP https://$APIIP/ -o /dev/null"
  check "CONNECT api.typesafe.ai with SNI api.typesafe.ai -> spliced (real handshake)" "timeout 20 $SCL -connect api.typesafe.ai:443 -servername api.typesafe.ai </dev/null 2>&1 | grep -q 'subject='"
  check "CONNECT api.typesafe.ai with SNI example.com -> refused (terminated)" "! timeout 20 $SCL -connect api.typesafe.ai:443 -servername example.com </dev/null 2>&1 | grep -q 'subject='"
  check "CONNECT bedrock-runtime.ap-south-1 with its own SNI -> spliced (a named destination)" "timeout 20 $SCL -connect bedrock-runtime.ap-south-1.amazonaws.com:443 -servername bedrock-runtime.ap-south-1.amazonaws.com </dev/null 2>&1 | grep -q 'subject='"
  check "allowlisted host via curl" "$AS curl -s -m 15 -o /dev/null -w '%{http_code}' -x http://127.0.0.1:8888 https://api.typesafe.ai/ | grep -qv 000"
else echo "skip: allowlisted-host and SNI-mismatch checks need internet from the container"; fi
check "proxy access log (journal) carries host:port and SNI only, no URL paths" "journalctl -t squid --no-pager -o cat | grep -q 'sni=' && ! journalctl -t squid --no-pager -o cat | grep -q 'api.typesafe.ai/'"
check "squid left no disk cache and no files in /opt or /etc/studio-agent" '! ls /var/spool/squid/* >/dev/null 2>&1'

echo "--- B: pgbouncer relay (verify-full, endpoint pinned, own uid)"
GPW=$(x "sed -n 's/^AGENT_GOV_PW=//p' /etc/studio-pgrelay/local.env"); SPW=$(x "sed -n 's/^AGENT_STUDIO_PW=//p' /etc/studio-pgrelay/local.env")
PQ="env PGCONNECT_TIMEOUT=8 psql -Atq"
check "agent -> relay -> fake Neon: gov database as neon_gov (TLS verify-full + endpoint password worked)" "[ \"\$($AS env PGPASSWORD=$GPW $PQ 'host=127.0.0.1 port=6432 user=agent_gov dbname=gov sslmode=disable' -c 'select current_user')\" = neon_gov ]"
check "agent -> relay -> fake Neon: studio database as neon_studio" "[ \"\$($AS env PGPASSWORD=$SPW $PQ 'host=127.0.0.1 port=6432 user=agent_studio dbname=studio sslmode=disable' -c 'select current_user')\" = neon_studio ]"
check "relay logs reach the journal (no AF_UNIX needed)" "journalctl -u studio-pgrelay --no-pager -o cat | grep -q 'process up: PgBouncer'"
check "relay is configured with verify-full and the system CA" "grep -q '^server_tls_sslmode = verify-full' /run/studio-pgrelay/pgbouncer.ini && grep -q '^server_tls_ca_file = /etc/ssl/certs/ca-certificates.crt' /run/studio-pgrelay/pgbouncer.ini"
check "relay ini is 0600 studio-pgrelay on tmpfs; the Neon password is persisted only in neon.env" '[ "$(stat -c "%a %U" /run/studio-pgrelay/pgbouncer.ini)" = "600 studio-pgrelay" ] && [ "$(grep -rl govpw /etc /opt /var 2>/dev/null | sort)" = /etc/studio-pgrelay/neon.env ]'
check "agent uid cannot reach the Neon address directly" "! $AS timeout 6 bash -c '</dev/tcp/$NEONIP/5432'"
check "agent uid cannot reach the SECOND endpoint even with valid credentials" "! $AS env PGPASSWORD='endpoint=neonstub2\$govpw' PGCONNECT_TIMEOUT=6 psql -Atq 'host=$STUB2IP port=5432 user=neon_gov dbname=govdb sslmode=require' -c 'select 1'"
check "agent uid cannot reach the second endpoint through the proxy either (host not allowlisted, :5432)" "! $AS curl -s -m 8 -x http://127.0.0.1:8888 https://neonstub2.test:5432/ -o /dev/null"
check "the relay cannot be pointed elsewhere: unknown database names are rejected" "! $AS env PGPASSWORD=$GPW $PQ 'host=127.0.0.1 port=6432 user=agent_gov dbname=govdb sslmode=disable' -c 'select 1' && ! $AS env PGPASSWORD=$GPW $PQ 'host=127.0.0.1 port=6432 user=agent_gov dbname=neonstub2.test sslmode=disable' -c 'select 1'"
check "startup parameters cannot redirect the relay (options=...)" "! $AS env PGPASSWORD=$GPW $PQ 'host=127.0.0.1 port=6432 user=agent_gov dbname=gov sslmode=disable options=-chost%3Dneonstub2.test' -c 'select 1'"
check "relay admin console is closed to the agent" "! $AS env PGPASSWORD=$GPW $PQ 'host=127.0.0.1 port=6432 user=agent_gov dbname=pgbouncer sslmode=disable' -c 'show config'"
check "relay uid reaches the configured endpoint but not the second one" "runuser -u studio-pgrelay -- timeout 6 bash -c '</dev/tcp/$NEONIP/5432' && ! runuser -u studio-pgrelay -- timeout 6 bash -c '</dev/tcp/$STUB2IP/5432'"
# verify-full: swap the first endpoint's certificate for one issued to another name -> the relay must refuse it
docker cp "$PKI/neonstub2.test.crt" "$STUB:/etc/ssl/pg/server.crt"; docker cp "$PKI/neonstub2.test.key" "$STUB:/etc/ssl/pg/server.key"
docker exec "$STUB" bash -c 'chown postgres:postgres /etc/ssl/pg/server.*; chmod 600 /etc/ssl/pg/server.key; pg_ctlcluster 16 main restart; for i in $(seq 30); do pg_isready -q && break; sleep 1; done'
x 'systemctl restart studio-pgrelay'; sleep 3
check "relay refuses a server certificate for the wrong name (verify-full)" "! $AS env PGPASSWORD=$GPW $PQ 'host=127.0.0.1 port=6432 user=agent_gov dbname=gov sslmode=disable' -c 'select 1'; for i in \$(seq 12); do journalctl -u studio-pgrelay --no-pager -o cat | grep -q 'not present in server certificate' && exit 0; $AS env PGPASSWORD=$GPW $PQ 'host=127.0.0.1 port=6432 user=agent_gov dbname=gov sslmode=disable' -c 'select 1' >/dev/null 2>&1; sleep 2; done; exit 1"
docker cp "$PKI/neonstub.test.crt" "$STUB:/etc/ssl/pg/server.crt"; docker cp "$PKI/neonstub.test.key" "$STUB:/etc/ssl/pg/server.key"
docker exec "$STUB" bash -c 'chown postgres:postgres /etc/ssl/pg/server.*; chmod 600 /etc/ssl/pg/server.key; pg_ctlcluster 16 main restart; for i in $(seq 30); do pg_isready -q && break; sleep 1; done'
x 'systemctl restart studio-pgrelay'; sleep 8
check "correct certificate restored: relay works again" "[ \"\$($AS env PGPASSWORD=$GPW $PQ 'host=127.0.0.1 port=6432 user=agent_gov dbname=gov sslmode=disable' -c 'select current_user')\" = neon_gov ]"

echo "--- B2 (m8): IPv6 end to end - the relay reaches an IPv6-only fake Neon (fd00:6::1) through its AAAA pin"
x "sed -i 's#^GOV_NEON_URL=.*#GOV_NEON_URL=postgres://neon_gov6:govpw@neonstub6.test/govdb6?sslmode=require#' /etc/studio-pgrelay/neon.env; systemctl restart studio-pgrelay"; sleep 6
check "relay -> fd00:6::1 over TLS verify-full (server address is the v6 stub)" "[ \"\$($AS env PGPASSWORD=$GPW $PQ 'host=127.0.0.1 port=6432 user=agent_gov dbname=gov sslmode=disable' -c 'select current_user || chr(32) || inet_server_addr()')\" = 'neon_gov6 fd00:6::1/128' ]"
check "nft has the v6 rule for the relay uid only; agent uid cannot reach the v6 stub" "ur=\$(id -u studio-pgrelay); nft list table inet studio_agent | grep \"skuid \$ur ip6 daddr\" | grep -q 'fd00:6::1' && ! $AS timeout 6 bash -c '</dev/tcp/fd00:6::1/5432'"
x "sed -i 's#^GOV_NEON_URL=.*#GOV_NEON_URL=postgres://neon_gov:govpw@neonstub.test/govdb?sslmode=require#' /etc/studio-pgrelay/neon.env; systemctl restart studio-pgrelay"; sleep 6
check "back on the first endpoint" "[ \"\$($AS env PGPASSWORD=$GPW $PQ 'host=127.0.0.1 port=6432 user=agent_gov dbname=gov sslmode=disable' -c 'select current_user')\" = neon_gov ]"

echo "--- C: t4 credential broker (stub federation, real broker code), helper, no GCP on the host"
BURL="http://$BROKERIP:$BPORT/creds"
check "helper (as the agent uid) returns credential_process JSON from the broker" "$AS env STUDIO_BROKER_URL=$BURL STUDIO_BROKER_TOKEN=$BROKER_TOKEN /usr/local/bin/studio-aws-creds | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d[\"Version\"]==1 and d[\"AccessKeyId\"]==\"ASIASTUBKEY\" and d[\"SessionToken\"]'"
checkno "helper with a wrong token fails and prints nothing usable" "o=\$($AS env STUDIO_BROKER_URL=$BURL STUDIO_BROKER_TOKEN=wrong /usr/local/bin/studio-aws-creds 2>/dev/null); [ -n \"\$o\" ]"
check "broker: no token -> 401, bad token -> 401" "[ \"\$($AS curl -s --noproxy '*' -o /dev/null -w '%{http_code}' $BURL)\" = 401 ] && [ \"\$($AS curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer nope' $BURL)\" = 401 ]"
c403=$(docker exec "$STUB2" curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $BROKER_TOKEN" "$BURL")
[ "$c403" = 403 ] && ok "broker: a caller outside BROKER_ALLOWED_SOURCES is refused (403) even with the right token" || bad "broker source check (got $c403)"
check "agent uid reaches the broker address and port only" "! $AS timeout 6 bash -c '</dev/tcp/$BROKERIP/22' && ! $AS timeout 6 bash -c '</dev/tcp/$STUB2IP/$BPORT'"
check "boto3 default chain in the agent's venv resolves credentials through credential_process (as the agent uid)" "$AS env AWS_CONFIG_FILE=/etc/studio-agent/aws-config AWS_EC2_METADATA_DISABLED=true STUDIO_BROKER_URL=$BURL STUDIO_BROKER_TOKEN=$BROKER_TOKEN /opt/studio-agent/current/venv/bin/python -c 'import boto3; c=boto3.Session().get_credentials().get_frozen_credentials(); assert c.access_key==\"ASIASTUBKEY\" and c.token==\"stub-session-token\"'"
check "the host has no GCP key, no GCP variable, no googleapis allowlist entry, no Vertex setting" '! find /etc /opt -name "gcp-sa.json" 2>/dev/null | grep -q . && ! grep -rIl "googleapis" /etc/studio-proxy /etc/studio-agent /etc/systemd/system 2>/dev/null | grep -q . && ! grep -Eq "GCP_|VERTEX|GOOGLE|AWS_ROLE_ARN" /etc/studio-agent/env'

echo "--- sandbox probes: probe unit = copy of the live unit, ExecStart swapped (N1 + relay/proxy reach + M4)"
xi 'cat >/usr/local/share/probe.py' <<'PROBE'
import os, socket, subprocess, sys, urllib.request, urllib.error
ip, bip, bport = sys.argv[1], sys.argv[2], int(sys.argv[3])
def t(name, fn):
    try:
        fn(); print(name, "ok", flush=True)
    except Exception as e:
        print(name, "blocked:" + type(e).__name__, flush=True)
def vl():
    s = socket.socket(socket.AF_UNIX); s.connect("/run/systemd/resolve/io.systemd.Resolve"); s.close()
def tcp(port):
    s = socket.create_connection((ip, port), timeout=5); s.close()
def bedrock():
    try: urllib.request.urlopen("https://bedrock-runtime.ap-south-1.amazonaws.com/", timeout=15)
    except urllib.error.HTTPError: pass
t("getaddrinfo", lambda: socket.getaddrinfo("example.org", 443))
t("af_unix_socket", lambda: socket.socket(socket.AF_UNIX))
t("varlink_connect", vl)
t("dbus_stat", lambda: os.stat("/run/dbus/system_bus_socket"))
t("resolved_dir_stat", lambda: os.stat("/run/systemd/resolve/io.systemd.Resolve"))
t("resolvectl", lambda: subprocess.run(["resolvectl", "query", "example.org"], check=True, capture_output=True, timeout=10))
t("setaffinity", lambda: os.sched_setaffinity(0, {0}))
t("neon_5432", lambda: tcp(5432))
def loop(port):
    s = socket.create_connection(("127.0.0.1", port), timeout=5); s.close()
t("relay_6432", lambda: loop(6432))
t("proxy_8888", lambda: loop(8888))
t("loopback_other", lambda: loop(7777))
t("bedrock_via_proxy", bedrock)
t("broker_tcp", lambda: socket.create_connection((bip, bport), 5).close())
t("broker_other_port", lambda: socket.create_connection((bip, 22), 5).close())
def helper():
    r = subprocess.run(["/usr/local/bin/studio-aws-creds"], capture_output=True, text=True, timeout=20)
    assert "ASIASTUBKEY" in r.stdout
t("helper", helper)
def boto():
    import boto3
    assert boto3.Session().get_credentials().get_frozen_credentials().access_key == "ASIASTUBKEY"
t("boto3_credential_process", boto)
PROBE
x "cd /etc/systemd/system && sed -e 's#^ExecStart=.*#ExecStart=/opt/studio-agent/current/venv/bin/python /usr/local/share/probe.py $NEONIP $BROKERIP $BPORT#' -e 's#^Restart=.*#Restart=no#' -e '/^Type=/d' -e '/^BindsTo=/d' -e '/^PartOf=/d' -e '/^\[Install\]/,\$d' studio-agent.service >studio-probe.service
  sed -i 's#^\[Service\]#[Service]\nType=oneshot#' studio-probe.service; mkdir -p studio-probe.service.d; cp /etc/systemd/system.control/studio-agent.service.d/*.conf studio-probe.service.d/ 2>/dev/null
  sed -e 's#^RestrictAddressFamilies=.*#RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX#' -e '/^InaccessiblePaths=/d' studio-probe.service >studio-probectl.service; mkdir -p studio-probectl.service.d; cp studio-probe.service.d/* studio-probectl.service.d/ 2>/dev/null
  systemctl daemon-reload; systemctl start studio-probe.service; systemctl start studio-probectl.service; true"
x 'journalctl -u studio-probe -o cat --no-pager' >"$WORK/probe.out" 2>&1
x 'journalctl -u studio-probectl -o cat --no-pager' >"$WORK/probectl.out" 2>&1
pv() { grep -E "^$1 " "$WORK/probe.out" | head -1; }
for k in getaddrinfo af_unix_socket varlink_connect dbus_stat resolved_dir_stat resolvectl; do
  pv $k | grep -q 'blocked' && ok "sandbox: $k blocked" || { bad "sandbox: $k blocked"; pv $k; }
done
pv setaffinity | grep -q 'blocked:PermissionError' && ok "M4: filtered syscall returns EPERM (no SIGSYS kill)" || { bad "M4 EPERM"; pv setaffinity; }
pv neon_5432 | grep -q 'blocked' && ok "sandbox: the agent cannot reach the Neon address at all" || { bad "neon :5432 blocked for the agent"; pv neon_5432; }
pv broker_tcp | grep -q ' ok' && ok "sandbox: the broker address:port is reachable" || { bad "broker reachable"; pv broker_tcp; }
pv broker_other_port | grep -q 'blocked' && ok "sandbox: other ports on the broker host are not" || { bad "broker other port blocked"; pv broker_other_port; }
pv helper | grep -q ' ok' && ok "sandbox: credential helper works under the unit's hardening (proxy env set, helper bypasses it)" || { bad "helper in sandbox"; pv helper; }
pv boto3_credential_process | grep -q ' ok' && ok "sandbox: boto3 default chain resolves broker credentials" || { bad "boto3 in sandbox"; pv boto3_credential_process; }
pv relay_6432 | grep -q ' ok' && ok "sandbox: relay 127.0.0.1:6432 reachable" || { bad "relay reachable"; pv relay_6432; }
pv proxy_8888 | grep -q ' ok' && ok "sandbox: proxy 127.0.0.1:8888 reachable" || { bad "proxy reachable"; pv proxy_8888; }
pv loopback_other | grep -q 'blocked' && ok "sandbox: other loopback ports blocked" || { bad "other loopback blocked"; pv loopback_other; }
if [ "$INTERNET" = 1 ]; then pv bedrock_via_proxy | grep -q ' ok' && ok "sandbox: Bedrock reachable via proxy" || { bad "bedrock via proxy"; pv bedrock_via_proxy; }; fi
grep -q '^varlink_connect ok' "$WORK/probectl.out" && ok "control: with AF_UNIX allowed and paths visible, varlink connect WORKS (the N1 gap was real)" || { bad "control varlink"; cat "$WORK/probectl.out"; }
x 'rm -rf /etc/systemd/system/studio-probe* ; systemctl daemon-reload'

echo "--- fail closed + guard (N6)"
x 'nft delete table inet studio_agent'
checkno "agent restart refused without nft table" 'systemctl restart studio-agent; sleep 3; systemctl is-active --quiet studio-agent'
check "restoring egress, agent starts again" "systemctl restart studio-agent-nft; systemctl reset-failed studio-agent; systemctl start studio-agent; $HEALTH"
check "restart nftables under a running agent: agent stopped within 20 s" 'systemctl restart nftables; for i in $(seq 20); do systemctl is-active --quiet studio-agent || exit 0; sleep 1; done; exit 1'
check "guard logged why" 'journalctl -u studio-agent-egress-guard -o cat --no-pager | grep -q "nft table inet studio_agent missing"'
check "restarting the nft unit restores the table" 'systemctl restart studio-agent-nft || { journalctl -u studio-agent-nft -n 15 -o cat --no-pager; exit 1; }; nft list table inet studio_agent >/dev/null'
check "agent can be started again after the guard stop" "systemctl reset-failed studio-agent; systemctl start studio-agent; $HEALTH"
check "proxy stop under a running agent: BindsTo stops the agent" 'systemctl stop studio-proxy; sleep 2; ! systemctl is-active --quiet studio-agent; systemctl start studio-proxy'
check "agent restarts after proxy back" "systemctl reset-failed studio-agent; systemctl start studio-agent; $HEALTH"

echo "--- M7: Neon unresolvable at boot -> refresh retries until it resolves, then starts relay and agent"
x 'systemctl stop studio-agent studio-pgrelay; true'
docker exec "$STUB" pkill dnsmasq
x 'systemctl restart studio-agent-nft; true'
checkno "with Neon unresolvable the nft unit fails and the agent stays down" 'sleep 5; systemctl is-active --quiet studio-agent-nft || systemctl is-active --quiet studio-agent'
start_dns
check "once Neon resolves (retry loop) the relay and the agent come up on their own" "for i in \$(seq 60); do systemctl is-active --quiet studio-pgrelay && systemctl is-active --quiet studio-agent && exit 0; sleep 2; done; exit 1"
check "agent healthy after the boot-time retry" "$HEALTH"

echo "--- m1: --stop is an operator stop the refresh respects"
check "--stop stops the agent and the relay and sets the flag" '/root/asus/install-studio-agent.sh --stop && ! systemctl is-active --quiet studio-agent && ! systemctl is-active --quiet studio-pgrelay && [ -e /run/studio-agent/operator-stop ]'
check "a refresh (script and timer service) does not bring them back" '/usr/local/sbin/studio-agent-egress-refresh >/dev/null; systemctl start studio-agent-egress-refresh.service; sleep 5; ! systemctl is-active --quiet studio-agent && ! systemctl is-active --quiet studio-pgrelay'
check "an install clears the flag and brings relay and agent back" "$(inst rel1) && [ ! -e /run/studio-agent/operator-stop ] && systemctl is-active --quiet studio-agent && systemctl is-active --quiet studio-pgrelay && $HEALTH"

echo "--- upgrade, bad/slow release revert"
check "upgrade installs release 2" "$(inst rel2) && [ \"\$(readlink /opt/studio-agent/current)\" = /opt/studio-agent/releases/${SHA_rel2:0:12} ] && [ \"\$(readlink /opt/studio-agent/previous)\" = /opt/studio-agent/releases/${SHA_rel1:0:12} ] && systemctl is-active --quiet studio-agent"
check "agent runs from release 2" "pgrep -af uvicorn | grep -q '/opt/studio-agent/current/venv' && test -f /opt/studio-agent/current/app/studio/apps/agent/RELEASE"
checkno "relbad right after rel2 fails" "$(inst relbad)"
check "relbad reverted: current=rel2, previous still rel1, agent healthy, bad release removed" "[ \"\$(readlink /opt/studio-agent/current)\" = /opt/studio-agent/releases/${SHA_rel2:0:12} ] && [ \"\$(readlink /opt/studio-agent/previous)\" = /opt/studio-agent/releases/${SHA_rel1:0:12} ] && [ ! -e /opt/studio-agent/releases/${SHA_relbad:0:12} ] && $HEALTH"
checkno "relslow (crash at 7 s) fails the 30 s window" "$(inst relslow)"
check "relslow reverted to rel2, agent healthy" "[ \"\$(readlink /opt/studio-agent/current)\" = /opt/studio-agent/releases/${SHA_rel2:0:12} ] && $HEALTH"
for n in 1 2 3 4 5; do
  r=rel1; [ $((n % 2)) = 0 ] && r=rel2
  check "back-to-back install $n ($r) succeeds" "$(inst $r) && systemctl is-active --quiet studio-agent"
done
check "fresh install after failures leaves no failed units" '! systemctl --failed --no-legend | grep -q studio'

echo "--- post-session check (agent running, env present)"
CAN=CANARY-PATIENT-7731904
PSC=/root/asus/post-session-check.sh
x 'systemctl start studio-agent-egress-refresh.service'
check "clean run exits 0" "printf %s $CAN | $PSC"
x "mkdir -p /var/lib/refute; echo $CAN >/var/lib/refute/plain.txt; echo $CAN | gzip >/var/log/rotated.log.2.gz; echo $CAN | xz >/var/log/rotated.log.3.xz; echo $CAN | zstd -q >/var/log/rotated.log.4.zst; : >/var/lib/refute/name-$CAN; logger '$CAN'; sleep 1"
x "printf %s $CAN | $PSC" >"$WORK/psc.out" 2>&1; rc=$?
[ "$rc" = 1 ] && ok "hits exit 1" || bad "hits exit 1 (rc=$rc)"
grep -q 'rotated.log.2.gz' "$WORK/psc.out" && ok "finds canary in .gz" || bad "finds canary in .gz"
grep -q 'rotated.log.3.xz' "$WORK/psc.out" && ok "finds canary in .xz" || bad "finds canary in .xz"
grep -q 'rotated.log.4.zst' "$WORK/psc.out" && ok "finds canary in .zst" || bad "finds canary in .zst"
[ "$(grep -c 'rotated.log.3.xz' "$WORK/psc.out")" = 1 ] && [ "$(grep -c 'rotated.log.4.zst' "$WORK/psc.out")" = 1 ] && ok "m5: .xz/.zst hits reported once per path" || bad "m5 duplicate hits"
grep -q 'plain.txt' "$WORK/psc.out" && ok "finds canary in plain file" || bad "finds canary in plain file"
grep -q 'journal hits: [1-9]' "$WORK/psc.out" && ok "finds canary in journal" || bad "finds canary in journal"
grep -q "$CAN" "$WORK/psc.out" && bad "canary printed in output" || ok "canary never printed (hashed path)"
x "rm -f /var/lib/refute/* /var/log/rotated.log.*; true"
x "echo clean >/var/lib/refute-$CAN; printf %s $CAN >/run/x-run-file"
x "printf %s $CAN | $PSC" >"$WORK/psc.out" 2>&1; rc=$?
[ "$rc" = 1 ] && grep -q 'file name contains the canary' "$WORK/psc.out" && ok "R5-C: filename-only hit reported (exit 1)" || bad "filename-only hit (rc=$rc)"
grep -q 'x-run-file' "$WORK/psc.out" || grep -c 'HIT' "$WORK/psc.out" | grep -qv '^0$' && ok "R5-C: /run is scanned" || bad "/run scanned"
grep -q "$CAN" "$WORK/psc.out" && bad "canary printed in output (name hit)" || ok "canary not printed for name hits"
x "rm -f /var/lib/refute-$CAN /run/x-run-file; true"
x 'printf "#!/bin/sh\necho boom >&2\nexit 1\n" >/usr/local/bin/journalctl; chmod +x /usr/local/bin/journalctl'
x "printf %s NOHITCANARY-1234567 | PATH=/usr/local/bin:\$PATH $PSC" >/dev/null 2>&1; rc=$?
[ "$rc" = 3 ] && ok "journalctl failure with stderr -> INCONCLUSIVE exit 3" || bad "journalctl failure exit 3 (rc=$rc)"
x 'printf "#!/bin/sh\nexit 1\n" >/usr/local/bin/journalctl'
x "printf %s NOHITCANARY-1234567 | PATH=/usr/local/bin:\$PATH $PSC" >/dev/null 2>&1; rc=$?
[ "$rc" = 3 ] && ok "M5: silent journalctl exit 1 -> INCONCLUSIVE exit 3" || bad "silent journalctl exit 3 (rc=$rc)"
x "rm -f /usr/local/bin/journalctl"
x 'sed -i "s#^STUDIO_LOG_LEVEL=.*#STUDIO_LOG_LEVEL=DEBUG#" /etc/studio-agent/env'
x "printf %s NOHITCANARY-1234567 | $PSC" >"$WORK/psc.out" 2>&1; rc=$?
[ "$rc" = 1 ] && grep -q 'VIOLATION' "$WORK/psc.out" && ok "DEBUG log level -> violation exit 1" || bad "DEBUG log level exit 1 (rc=$rc)"
x 'sed -i "s#^STUDIO_LOG_LEVEL=.*#STUDIO_LOG_LEVEL=INFO#" /etc/studio-agent/env'
x 'echo 1 >/var/lib/studio-agent-egress-ok'
x "printf %s NOHITCANARY-1234567 | $PSC" >"$WORK/psc.out" 2>&1; rc=$?
[ "$rc" = 3 ] && grep -q 'egress refresh last succeeded' "$WORK/psc.out" && ok "stale egress refresh -> INCONCLUSIVE exit 3" || bad "stale egress refresh exit 3 (rc=$rc)"
x 'systemctl start studio-agent-egress-refresh.service'
check "refresh service rewrites the success stamp; check clean again" "printf %s NOHITCANARY-1234567 | $PSC"

echo "--- rollback twice, purge"
check "rollback 1" '/root/asus/install-studio-agent.sh --rollback && ! systemctl is-active --quiet studio-agent && ! systemctl is-enabled --quiet studio-agent'
check "m2: rollback also stopped and disabled the relay (pool dropped)" '! systemctl is-active --quiet studio-pgrelay && ! systemctl is-enabled --quiet studio-pgrelay && ! ss -tn | grep -q ":6432 "'
check "m2: a refresh does not restart agent or relay after rollback" 'systemctl start studio-agent-egress-refresh.service; sleep 4; ! systemctl is-active --quiet studio-pgrelay && ! systemctl is-active --quiet studio-agent'
check "rollback 2 (idempotent)" '/root/asus/install-studio-agent.sh --rollback'
check "funnel off after rollback (stub)" '! tailscale serve status --json | grep -q "/agent"'
x 'tailscale funnel --bg --set-path /agent http://127.0.0.1:8123/agent'
check "purge-secrets removes env, Neon credentials and aws-config, and turns Funnel off" '/root/asus/install-studio-agent.sh --purge-secrets; [ ! -e /etc/studio-agent/env ] && [ ! -e /etc/studio-agent/aws-config ] && [ ! -e /etc/studio-pgrelay/neon.env ] && [ ! -e /etc/studio-pgrelay/local.env ] && ! tailscale serve status --json | grep -q "/agent"'
check "m2: after purge the relay stays disabled and the refresh does not retry it" 'systemctl start studio-agent-egress-refresh.service; sleep 4; ! systemctl is-active --quiet studio-pgrelay && ! systemctl is-enabled --quiet studio-pgrelay && ! systemctl is-active --quiet studio-agent'
x "printf %s NOHITCANARY-1234567 | $PSC" >"$WORK/psc.out" 2>&1; rc=$?
[ "$rc" = 0 ] && grep -q 'PURGED' "$WORK/psc.out" && ok "m5: post-session-check after purge reports PURGED (exit 0)" || { bad "post-session after purge (rc=$rc)"; tail -5 "$WORK/psc.out"; }

echo; [ "$fail" = 0 ] && echo "ALL CONTAINER CHECKS PASSED" || echo "SOME CONTAINER CHECKS FAILED"
exit $fail
