#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2015,SC2329,SC2154  # remote commands are deliberately single-quoted
# Real-run test of the Asus installer inside a throwaway privileged systemd container (ubuntu:24.04)
# plus a second container acting as the Neon stub (nc listeners on 5432/5433, DNS alias neonstub.test).
# Runs: install x3, hosts-block removal, pins, stale-IP refresh, parallel refresh, sandbox probes
# (probe unit = copy of the live unit), fail-closed + guard, upgrade, bad/slow releases (revert),
# 5 back-to-back installs, rollback x2, purge, post-session check.
# `tailscale` is a stub (records calls, emulates serve state): Funnel is NOT exercised on a real tailnet.
# Needs docker and internet (apt, PyPI). Takes ~10-15 min. Touches nothing else.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)
C=studio-ops-test
STUB=studio-ops-neonstub
IMG=studio-ops-test-img
NEON=neonstub.test
WORK=$(mktemp -d)
fail=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fail=1; }
cleanup() { docker rm -f "$C" "$STUB" >/dev/null 2>&1; rm -rf "$WORK"; }
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
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus systemd-resolved tinyproxy nftables \
    python3 python3-pip curl ca-certificates iproute2 netcat-openbsd dnsutils dnsmasq sudo util-linux procps xz-utils zstd \
    && pip install --break-system-packages -q uv && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
DOCKERFILE

docker rm -f "$C" "$STUB" >/dev/null 2>&1
docker run -d --name "$STUB" "$IMG" sh -c 'nc -lk -p 5432 >/dev/null & nc -lk -p 5433 >/dev/null & sleep infinity' >/dev/null || { echo "stub start failed"; exit 2; }
STUBIP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$STUB")
# the stub is also the container's DNS server: answers neonstub.test, forwards everything else to the host's resolver
docker exec -d "$STUB" dnsmasq -k --address=/$NEON/"$STUBIP" --user=root --listen-address="$STUBIP" --bind-interfaces
docker run -d --name "$C" --dns "$STUBIP" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --tmpfs /run --tmpfs /run/lock "$IMG" /lib/systemd/systemd >/dev/null || { echo "container start failed"; exit 2; }
for _ in $(seq 30); do x 'systemctl is-system-running --wait 2>/dev/null | grep -Eq "running|degraded"' && break; sleep 1; done
x 'systemctl start systemd-resolved dbus' || true

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
printf '%s' '{"type":"service_account","client_email":"t@t.iam"}' >"$WORK/key.json"
docker cp "$WORK/key.json" "$C:/root/key.json"
inst() { echo "/root/asus/install-studio-agent.sh --neon-host $NEON --tarball /root/$1.tar --sha256 $(eval echo "\$SHA_$1")"; }

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

x "cd /root/asus && ./install-studio-agent.sh --dry-run --tarball /root/rel1.tar --sha256 $SHA_rel1 --neon-host $NEON" >"$WORK/dry.out" 2>&1 \
  && ok "dry-run in container (incl. nft -c, tinyproxy check)" || { bad "dry-run in container"; tail -5 "$WORK/dry.out"; }

echo "--- install 1 (env incomplete: must not activate)"
x 'printf "# BEGIN studio-agent-neon\n192.0.2.99 old.example\n# END studio-agent-neon\n" >>/etc/hosts; cp /etc/hosts /root/hosts.before.noblock; sed -i "/studio-agent-neon/,/END studio-agent-neon/d" /root/hosts.before.noblock'
check "install 1 exits 0" "$(inst rel1)"
check "old marked block removed from /etc/hosts, other lines untouched" '! grep -q studio-agent-neon /etc/hosts && ! grep -q 192.0.2.99 /etc/hosts && cmp /etc/hosts /root/hosts.before.noblock'
checkno "agent not enabled/active with empty env" 'systemctl is-active --quiet studio-agent || systemctl is-enabled --quiet studio-agent'
check "stock tinyproxy masked" 'systemctl is-enabled tinyproxy 2>&1 | grep -q masked'
check "studio-proxy runs tinyproxy -c studio config" 'pgrep -af "tinyproxy -d -c /etc/studio-agent/tinyproxy.conf"'
check "proxy listens on 127.0.0.1:8888 only" '[ "$(ss -ltn | grep -c ":8888 ")" = 1 ] && ss -ltn | grep -q "127.0.0.1:8888 "'
check "nft table present" 'nft list table inet studio_agent'
check "pins file {host:[ips]} 0640 root:studio-agent" "[ \"\$(stat -c '%a %U:%G' /run/studio-agent/neon-pins.json)\" = '640 root:studio-agent' ] && python3 -c 'import json,sys; d=json.load(open(\"/run/studio-agent/neon-pins.json\")); sys.exit(0 if d[\"$NEON\"]==[\"$NEONIP\"] else 1)'"
check "/etc/hosts has no studio block" '! grep -q studio-agent-neon /etc/hosts'
check "env 0600 root:studio-agent, dir 0750" '[ "$(stat -c "%a %U:%G" /etc/studio-agent/env)" = "600 root:studio-agent" ] && [ "$(stat -c %a /etc/studio-agent)" = 750 ]'
check "kill switch default 0" 'grep -q "^STUDIO_LIVE_READS=0$" /etc/studio-agent/env'
check "env has TYPESAFE_API_KEY, VERTEX_MODEL, JEV_MODEL, AWS_STS_REGIONAL_ENDPOINTS=regional" 'grep -q "^TYPESAFE_API_KEY=" /etc/studio-agent/env && grep -q "^VERTEX_MODEL=" /etc/studio-agent/env && grep -q "^JEV_MODEL=" /etc/studio-agent/env && grep -q "^AWS_STS_REGIONAL_ENDPOINTS=regional$" /etc/studio-agent/env'

echo "--- key + env fill (VERTEX_MODEL left empty: optional)"
check "receive key via stdin" 'cat /root/key.json | /root/asus/install-studio-agent.sh --receive-gcp-key'
check "key 0600 studio-agent" '[ "$(stat -c "%a %U" /etc/studio-agent/gcp-sa.json)" = "600 studio-agent" ]'
x 'for v in GOV_RO_DATABASE_URL STUDIO_DATABASE_URL; do sed -i "s#^$v=.*#$v=postgres://u:p@neonstub.test/db#" /etc/studio-agent/env; done
   for v in STUDIO_SERVICE_TOKEN STUDIO_ACTOR_SECRET AWS_ROLE_ARN GCP_AUDIENCE TYPESAFE_API_KEY; do sed -i "s#^$v=.*#$v=dummy-$v#" /etc/studio-agent/env; done'

echo "--- install 2 (activate; waits for the 30 s health window)"
check "install 2 exits 0 (VERTEX_MODEL unset only warns)" "$(inst rel1) | tee /root/i2.out | tail -3; grep -q 'WARNING: VERTEX_MODEL' /root/i2.out; exit \${PIPESTATUS[0]}"
check "agent active, /agent/health = 401 bad_service_token" "systemctl is-active --quiet studio-agent && $HEALTH"
check "agent listens on 127.0.0.1:8123 only" '[ "$(ss -ltn | grep -c ":8123 ")" = 1 ] && ss -ltn | grep -q "127.0.0.1:8123 "'
check "agent runs as studio-agent" '[ "$(ps -o user= -C uvicorn | head -1 | tr -d " ")" = studio-agent ]'
check "funnel opened on /agent only (stub)" 'tailscale serve status --json | grep -q "\"/agent\"" && [ "$(tailscale serve status --json | grep -o "\"/[a-z]*\"" | sort -u | wc -l)" = 1 ]'
check "IPAddressAllow = 127.0.0.1/32 + neon pin (not 127.0.0.0/8)" "a=\$(systemctl show studio-agent -p IPAddressAllow --value); grep -q '127.0.0.1' <<<\"\$a\" && grep -q '$NEONIP' <<<\"\$a\" && ! grep -q '127.0.0.0/8' <<<\"\$a\""
x 'systemd-analyze security studio-agent --no-pager | tail -1' | sed 's/^/     security: /'
check "security score <= 3.0" 'awk -v s="$(systemd-analyze security studio-agent --no-pager | tail -1 | grep -o "[0-9.]*" | head -1)" "BEGIN{exit !(s<=3.0)}"'
check "MemorySwapMax=0 LimitCORE=0" 'systemctl show studio-agent -p MemorySwapMax -p LimitCORE | tr "\n" " " | grep -q "MemorySwapMax=0 LimitCORE=0"'

echo "--- install 3 (idempotent: nothing restarts)"
x 'systemctl show studio-agent -p MainPID --value >/root/pid.before; systemctl show studio-proxy -p MainPID --value >/root/ppid.before'
check "install 3 exits 0" "$(inst rel1)"
check "agent and proxy not restarted by an unchanged install" '[ "$(systemctl show studio-agent -p MainPID --value)" = "$(cat /root/pid.before)" ] && [ "$(systemctl show studio-proxy -p MainPID --value)" = "$(cat /root/ppid.before)" ]'

echo "--- pins: stale IP never survives; parallel refresh keeps /etc/hosts byte-identical"
x 'echo "192.0.2.99 neonstub.test" >>/etc/hosts; cp /etc/hosts /root/hosts.planted
   printf "{\"neonstub.test\": [\"192.0.2.99\"]}" >/run/studio-agent/neon-pins.json
   nft add rule inet studio_agent out meta skuid studio-agent ip daddr 192.0.2.99 tcp dport 5432 accept'
check "refresh replaces planted stale pin/nft rule with the live upstream answer" "/usr/local/sbin/studio-agent-egress-refresh && ! grep -q 192.0.2.99 /run/studio-agent/neon-pins.json && ! nft list table inet studio_agent | grep -q 192.0.2.99 && grep -q $NEONIP /run/studio-agent/neon-pins.json"
check "refresh did not touch /etc/hosts" 'cmp /etc/hosts /root/hosts.planted'
check "agent healthy after the pin change restart" "$HEALTH"
x 'sha256sum /etc/hosts >/root/hosts.sum'
check "15 rounds x 3 parallel refreshes: /etc/hosts byte-identical, pins valid, table present" 'for r in $(seq 15); do for k in 1 2 3; do /usr/local/sbin/studio-agent-egress-refresh >/dev/null 2>&1 & done; wait; done; sha256sum -c --quiet /root/hosts.sum && python3 -c "import json;d=json.load(open(\"/run/studio-agent/neon-pins.json\"));assert d[\"neonstub.test\"]" && nft list table inet studio_agent >/dev/null && getent hosts localhost >/dev/null'
x 'grep -v 192.0.2.99 /etc/hosts >/root/h.tmp; cat /root/h.tmp >/etc/hosts'
check "agent still healthy" "$HEALTH"

echo "--- egress probes (uid studio-agent, outside the unit sandbox)"
AS='runuser -u studio-agent --'
checkno "agent uid cannot resolve arbitrary names (getent)" "timeout 10 $AS getent hosts example.org"
checkno "agent uid cannot dig" "timeout 8 $AS dig +time=2 +tries=1 example.org"
checkno "agent uid direct 443 dropped" "$AS curl -s -m 5 --resolve example.org:443:93.184.216.34 https://example.org/"
x '(nc -l 127.0.0.1 7777 >/dev/null 2>&1 &) ; sleep 1'
checkno "agent uid cannot reach other loopback ports" "$AS nc -z -w 3 127.0.0.1 7777"
check "drops are counted/logged" 'nft list table inet studio_agent | grep -Eq "counter packets [1-9]"'
check "proxy refuses non-allowlisted host (403)" "c=\$($AS curl -s -m 10 -o /dev/null -w '%{http_code}' -x http://127.0.0.1:8888 https://example.org/ 2>/dev/null); [ \"\$c\" = 000 ] || [ \"\$c\" = 403 ]"
check "proxy refuses plain-HTTP (non-CONNECT) even to an allowlisted host" "c=\$($AS curl -s -m 10 -o /dev/null -w '%{http_code}' -x http://127.0.0.1:8888 http://api.typesafe.ai/ 2>/dev/null); [ \"\$c\" = 403 ]"
check "proxy refuses non-443 CONNECT" "! $AS curl -s -m 8 -x http://127.0.0.1:8888 https://api.typesafe.ai:8443/ -o /dev/null"
INTERNET=0; x 'curl -s -m 8 -o /dev/null https://api.typesafe.ai/' && INTERNET=1
if [ "$INTERNET" = 1 ]; then
  check "proxy passes allowlisted host (CONNECT :443)" "$AS curl -s -m 15 -o /dev/null -w '%{http_code}' -x http://127.0.0.1:8888 https://api.typesafe.ai/ | grep -qv 000"
else echo "skip proxy allowlisted-host pass (no internet from container)"; fi

echo "--- sandbox probes: probe unit = copy of the live unit, ExecStart swapped (N1 + Neon/Bedrock reach + M4)"
xi 'cat >/usr/local/share/probe.py' <<'PROBE'
import os, socket, subprocess, sys, urllib.request, urllib.error
ip = sys.argv[1]
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
t("neon_5433", lambda: tcp(5433))
t("bedrock_via_proxy", bedrock)
PROBE
x "cd /etc/systemd/system && sed -e 's#^ExecStart=.*#ExecStart=/usr/bin/python3 /usr/local/share/probe.py $NEONIP#' -e 's#^Restart=.*#Restart=no#' -e '/^Type=/d' -e '/^BindsTo=/d' -e '/^PartOf=/d' -e '/^\[Install\]/,\$d' studio-agent.service >studio-probe.service
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
pv neon_5432 | grep -q ' ok' && ok "sandbox: neon pin :5432 reachable" || { bad "neon :5432"; pv neon_5432; }
pv neon_5433 | grep -q 'blocked' && ok "sandbox: neon pin other port blocked" || { bad "neon :5433 blocked"; pv neon_5433; }
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
grep -q 'plain.txt' "$WORK/psc.out" && ok "finds canary in plain file" || bad "finds canary in plain file"
grep -q 'journal hits: [1-9]' "$WORK/psc.out" && ok "finds canary in journal" || bad "finds canary in journal"
grep -q "$CAN" "$WORK/psc.out" && bad "canary printed in output" || ok "canary never printed (hashed path)"
x "rm -f /var/lib/refute/* /var/log/rotated.log.*; true"
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
check "rollback 2 (idempotent)" '/root/asus/install-studio-agent.sh --rollback'
check "funnel off after rollback (stub)" '! tailscale serve status --json | grep -q "/agent"'
check "purge-secrets removes env and key" '/root/asus/install-studio-agent.sh --purge-secrets; [ ! -e /etc/studio-agent/env ] && [ ! -e /etc/studio-agent/gcp-sa.json ]'

echo; [ "$fail" = 0 ] && echo "ALL CONTAINER CHECKS PASSED" || echo "SOME CONTAINER CHECKS FAILED"
exit $fail
