#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2015,SC2329  # remote commands are deliberately single-quoted
# Real-run test of the Asus installer inside a throwaway privileged systemd container (ubuntu:24.04).
# Runs: install twice, upgrade, failed upgrade, fail-closed egress, egress probes, rollback twice,
# purge, post-session check. `tailscale` is a stub (records calls, emulates serve state): Funnel is
# NOT exercised against a real tailnet. Needs docker and internet (apt, PyPI). Touches nothing else.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)
C=studio-ops-test
IMG=studio-ops-test-img
WORK=$(mktemp -d)
fail=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fail=1; }
cleanup() { docker rm -f "$C" >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
x() { docker exec -i "$C" bash -c "$1" </dev/null; }
xi() { docker exec -i "$C" bash -c "$1"; }
# check DESC CMD  -> passes when CMD (run in the container) exits 0
check() { if x "$2" >"$WORK/out" 2>&1; then ok "$1"; else bad "$1"; sed 's/^/     /' "$WORK/out" | tail -8; fi; }
# checkno DESC CMD -> passes when CMD exits non-zero
checkno() { if x "$2" >"$WORK/out" 2>&1; then bad "$1"; sed 's/^/     /' "$WORK/out" | tail -5; else ok "$1"; fi; }

docker build -q -t "$IMG" - >/dev/null <<'DOCKERFILE' || { echo "image build failed"; exit 2; }
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus tinyproxy nftables \
    python3 python3-pip curl ca-certificates iproute2 netcat-openbsd dnsutils sudo util-linux procps \
    && pip install --break-system-packages -q uv && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
DOCKERFILE

docker rm -f "$C" >/dev/null 2>&1
docker run -d --name "$C" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --tmpfs /run --tmpfs /run/lock "$IMG" /lib/systemd/systemd >/dev/null || { echo "container start failed"; exit 2; }
for _ in $(seq 30); do x 'systemctl is-system-running --wait 2>/dev/null | grep -Eq "running|degraded"' && break; sleep 1; done

git -C "$REPO" archive HEAD studio/apps/agent -o "$WORK/rel1.tar"
SHA1=$(sha256sum "$WORK/rel1.tar" | cut -d' ' -f1)
# release 2: same tree plus a marker; release 3: broken lockfile
mkdir "$WORK/t2" "$WORK/t3"
tar -xf "$WORK/rel1.tar" -C "$WORK/t2"; echo v2 >"$WORK/t2/studio/apps/agent/RELEASE"; tar -cf "$WORK/rel2.tar" -C "$WORK/t2" studio
tar -xf "$WORK/rel1.tar" -C "$WORK/t3"; echo "garbage = [" >>"$WORK/t3/studio/apps/agent/uv.lock"; tar -cf "$WORK/rel3.tar" -C "$WORK/t3" studio
SHA2=$(sha256sum "$WORK/rel2.tar" | cut -d' ' -f1)
SHA3=$(sha256sum "$WORK/rel3.tar" | cut -d' ' -f1)
docker cp "$HERE" "$C:/root/asus"
for n in 1 2 3; do docker cp "$WORK/rel$n.tar" "$C:/root/rel$n.tar"; done
printf '%s' '{"type":"service_account","client_email":"t@t.iam"}' >"$WORK/key.json"
docker cp "$WORK/key.json" "$C:/root/key.json"

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

INST="/root/asus/install-studio-agent.sh --neon-host example.com"
x "cd /root/asus && ./install-studio-agent.sh --dry-run --tarball /root/rel1.tar --sha256 $SHA1 --neon-host example.com" >"$WORK/dry.out" 2>&1 \
  && ok "dry-run in container (incl. nft -c, tinyproxy check)" || { bad "dry-run in container"; tail -5 "$WORK/dry.out"; }

echo "--- install 1 (env incomplete: must not activate)"
check "install 1 exits 0" "$INST --tarball /root/rel1.tar --sha256 $SHA1"
checkno "agent not enabled/active with empty env" 'systemctl is-active --quiet studio-agent || systemctl is-enabled --quiet studio-agent'
check "stock tinyproxy masked" 'systemctl is-enabled tinyproxy 2>&1 | grep -q masked'
check "studio-proxy runs tinyproxy -c studio config" 'pgrep -af "tinyproxy -d -c /etc/studio-agent/tinyproxy.conf"'
check "proxy listens on 127.0.0.1:8888 only" '[ "$(ss -ltn | grep -c ":8888 ")" = 1 ] && ss -ltn | grep -q "127.0.0.1:8888 "'
check "nft table present" 'nft list table inet studio_agent'
check "neon hosts block written" 'grep -q "BEGIN studio-agent-neon" /etc/hosts && grep -q example.com /etc/hosts'
check "env 0600 root:studio-agent, dir 0750" '[ "$(stat -c "%a %U:%G" /etc/studio-agent/env)" = "600 root:studio-agent" ] && [ "$(stat -c %a /etc/studio-agent)" = 750 ]'
check "kill switch default 0" 'grep -q "^STUDIO_LIVE_READS=0$" /etc/studio-agent/env'
check "env has TYPESAFE_API_KEY, VERTEX_MODEL, JEV_MODEL" 'grep -q "^TYPESAFE_API_KEY=" /etc/studio-agent/env && grep -q "^VERTEX_MODEL=" /etc/studio-agent/env && grep -q "^JEV_MODEL=" /etc/studio-agent/env'

echo "--- key + env fill"
check "receive key via stdin" 'cat /root/key.json | /root/asus/install-studio-agent.sh --receive-gcp-key'
check "key 0600 studio-agent" '[ "$(stat -c "%a %U" /etc/studio-agent/gcp-sa.json)" = "600 studio-agent" ]'
x 'for v in GOV_RO_DATABASE_URL STUDIO_DATABASE_URL; do sed -i "s#^$v=.*#$v=postgres://u:p@example.com/db#" /etc/studio-agent/env; done
   for v in STUDIO_SERVICE_TOKEN STUDIO_ACTOR_SECRET AWS_ROLE_ARN GCP_AUDIENCE TYPESAFE_API_KEY VERTEX_MODEL; do sed -i "s#^$v=.*#$v=dummy-$v#" /etc/studio-agent/env; done'

echo "--- install 2 (activate)"
check "install 2 exits 0" "$INST --tarball /root/rel1.tar --sha256 $SHA1"
check "agent active" 'systemctl is-active --quiet studio-agent'
check "agent listens on 127.0.0.1:8123 only" '[ "$(ss -ltn | grep -c ":8123 ")" = 1 ] && ss -ltn | grep -q "127.0.0.1:8123 "'
check "agent runs as studio-agent" '[ "$(ps -o user= -C uvicorn | head -1 | tr -d " ")" = studio-agent ]'
check "funnel opened on /agent only (stub)" 'tailscale serve status --json | grep -q "\"/agent\"" && [ "$(tailscale serve status --json | grep -o "\"/[a-z]*\"" | sort -u | wc -l)" = 1 ]'
check "IPAddressAllow layer includes neon ip" 'systemctl show studio-agent -p IPAddressAllow --value | grep -Eq "[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+"'
x 'systemd-analyze security studio-agent --no-pager | tail -1' | sed 's/^/     security: /'
check "security score <= 3.0" 'awk -v s="$(systemd-analyze security studio-agent --no-pager | tail -1 | grep -o "[0-9.]*" | head -1)" "BEGIN{exit !(s<=3.0)}"'
check "MemorySwapMax=0 LimitCORE=0" 'systemctl show studio-agent -p MemorySwapMax -p LimitCORE | tr "\n" " " | grep -q "MemorySwapMax=0 LimitCORE=0"'
check "agent answers on 127.0.0.1:8123 (any HTTP status)" 'for i in 1 2 3 4 5 6; do c=$(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:8123/agent/health); [ "$c" != 000 ] && exit 0; sleep 2; done; exit 1'

echo "--- install 3 (idempotent)"
check "install 3 exits 0, agent still active" "$INST --tarball /root/rel1.tar --sha256 $SHA1 && systemctl is-active --quiet studio-agent"

echo "--- egress probes (uid studio-agent)"
AS='runuser -u studio-agent --'
checkno "agent uid cannot resolve arbitrary names (getent)" "timeout 10 $AS getent hosts example.org"
check "agent uid resolves the neon host from the hosts block" "$AS getent hosts example.com"
checkno "agent uid cannot dig" "timeout 8 $AS dig +time=2 +tries=1 example.org"
checkno "agent uid direct 443 dropped" "$AS curl -s -m 5 --resolve example.org:443:93.184.216.34 https://example.org/"
x '(nc -l 127.0.0.1 7777 >/dev/null 2>&1 &) ; sleep 1'
checkno "agent uid cannot reach other loopback ports" "$AS nc -z -w 3 127.0.0.1 7777"
check "drops are counted/logged" 'nft list table inet studio_agent | grep -Eq "counter packets [1-9]"'
check "proxy refuses non-allowlisted host (403/refused)" "c=\$($AS curl -s -m 10 -o /dev/null -w '%{http_code}' -x http://127.0.0.1:8888 https://example.org/ 2>/dev/null); [ \"\$c\" != 200 ]"
check "proxy refuses non-443 CONNECT" "! $AS curl -s -m 8 -x http://127.0.0.1:8888 https://api.typesafe.ai:8443/ -o /dev/null"
if x 'curl -s -m 8 -o /dev/null https://api.typesafe.ai/'; then
  check "proxy passes allowlisted host" "$AS curl -s -m 15 -o /dev/null -w '%{http_code}' -x http://127.0.0.1:8888 https://api.typesafe.ai/ | grep -qv 000"
else echo "skip proxy allowlisted-host pass (no internet from container)"; fi

echo "--- fail closed"
x 'nft delete table inet studio_agent'
checkno "agent restart refused without nft table" 'systemctl restart studio-agent; sleep 3; systemctl is-active --quiet studio-agent'
check "restoring egress restores agent" 'systemctl restart studio-agent-nft; sleep 5; systemctl is-active --quiet studio-agent'

echo "--- upgrade, failed upgrade"
check "upgrade installs release 2" "$INST --tarball /root/rel2.tar --sha256 $SHA2 && [ \"\$(readlink /opt/studio-agent/current)\" = /opt/studio-agent/releases/${SHA2:0:12} ] && [ -e /opt/studio-agent/previous ] && systemctl is-active --quiet studio-agent"
check "agent runs from release 2" "pgrep -af uvicorn | grep -q '/opt/studio-agent/current/venv' && test -f /opt/studio-agent/current/app/studio/apps/agent/RELEASE"
checkno "broken release fails" "$INST --tarball /root/rel3.tar --sha256 $SHA3"
check "failed upgrade leaves current and the old release running" "[ \"\$(readlink /opt/studio-agent/current)\" = /opt/studio-agent/releases/${SHA2:0:12} ] && [ ! -e /opt/studio-agent/releases/${SHA3:0:12} ] && systemctl is-active --quiet studio-agent"

echo "--- post-session check (agent running, env present)"
CAN=CANARY-PATIENT-7731904
PSC=/root/asus/post-session-check.sh
check "clean run exits 0" "printf %s $CAN | $PSC"
x "mkdir -p /var/lib/refute; echo $CAN >/var/lib/refute/plain.txt; echo $CAN | gzip >/var/log/rotated.log.2.gz; : >/var/lib/refute/name-$CAN; logger '$CAN'; sleep 1"
x "printf %s $CAN | $PSC" >"$WORK/psc.out" 2>&1; rc=$?
[ "$rc" = 1 ] && ok "hits exit 1" || bad "hits exit 1 (rc=$rc)"
grep -q 'rotated.log.2.gz' "$WORK/psc.out" && ok "finds canary in .gz" || bad "finds canary in .gz"
grep -q 'plain.txt' "$WORK/psc.out" && ok "finds canary in plain file" || bad "finds canary in plain file"
grep -q 'journal hits: [1-9]' "$WORK/psc.out" && ok "finds canary in journal" || bad "finds canary in journal"
grep -q "$CAN" "$WORK/psc.out" && bad "canary printed in output" || ok "canary never printed (hashed path)"
x 'printf "#!/bin/sh\necho boom >&2\nexit 1\n" >/usr/local/bin/journalctl; chmod +x /usr/local/bin/journalctl'
x "rm -f /var/lib/refute/* /var/log/rotated.log.2.gz; printf %s NOHITCANARY-1234567 | PATH=/usr/local/bin:\$PATH $PSC" >/dev/null 2>&1; rc=$?
[ "$rc" = 3 ] && ok "journalctl failure -> INCONCLUSIVE exit 3" || bad "journalctl failure exit 3 (rc=$rc)"
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
check "env template pins AWS_STS_REGIONAL_ENDPOINTS=regional" 'grep -q "^AWS_STS_REGIONAL_ENDPOINTS=regional$" /etc/studio-agent/env'

echo "--- rollback twice, purge"
check "rollback 1" '/root/asus/install-studio-agent.sh --rollback && ! systemctl is-active --quiet studio-agent && ! systemctl is-enabled --quiet studio-agent'
check "rollback 2 (idempotent)" '/root/asus/install-studio-agent.sh --rollback'
check "funnel off after rollback (stub)" '! tailscale serve status --json | grep -q "/agent"'
check "purge-secrets removes env and key" '/root/asus/install-studio-agent.sh --purge-secrets; [ ! -e /etc/studio-agent/env ] && [ ! -e /etc/studio-agent/gcp-sa.json ]'

echo; [ "$fail" = 0 ] && echo "ALL CONTAINER CHECKS PASSED" || echo "SOME CONTAINER CHECKS FAILED"
exit $fail
