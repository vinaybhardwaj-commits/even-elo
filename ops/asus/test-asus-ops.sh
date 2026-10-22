#!/usr/bin/env bash
# Offline checks (no root, changes nothing): shellcheck, dry-run coverage, rendered units verified.
# The real-run test is test-asus-container.sh (needs docker).
set -uo pipefail
cd "$(dirname "$0")" || exit 2
fail=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fail=1; }
R=$(mktemp -d)
trap 'rm -rf "$R"' EXIT

if command -v shellcheck >/dev/null; then
  if shellcheck -x ./*.sh ../t4-broker/*.sh; then ok shellcheck; else bad shellcheck; fi
else bad "shellcheck not installed"; fi

out=$(./install-studio-agent.sh --dry-run --render-dir "$R" --tarball /tmp/none.tar \
  --sha256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef --neon-host db.example.neon.tech --broker 100.101.102.103:8765 2>&1) || bad "dry-run exit"
for pat in 'tar -xf /tmp/none.tar' 'uv sync --frozen' 'releases/0123456789ab' \
  'mask squid' 'mask pgbouncer' 'studio-proxy.service' 'studio-pgrelay.service' 'ProtectSystem=strict' 'BindsTo=studio-proxy.service' 'PartOf=studio-agent-nft.service' \
  'studio-agent-egress-refresh.timer' 'studio-agent-egress-guard.timer' 'nft -c ok' 'api.*typesafe.*ai' 'not activating|health: GET' ; do
  if grep -Eq -- "$pat" <<<"$out"; then ok "dry-run: $pat"; else bad "dry-run missing: $pat"; fi
done
# state-independent: the env template comes from the installer itself, not from this host's /etc
tpl=$(./install-studio-agent.sh --print-env-template)
for pat in '^AWS_STS_REGIONAL_ENDPOINTS=regional$' '^TYPESAFE_API_KEY=$' '^JEV_MODEL=' '^STUDIO_LIVE_READS=0$' '^BEDROCK_MODEL_SONNET=' '^BEDROCK_AUTH=default-chain$' '^STUDIO_BROKER_TOKEN=$' '^AWS_CONFIG_FILE=/etc/studio-agent/aws-config$'; do
  if grep -Eq -- "$pat" <<<"$tpl"; then ok "env template: $pat"; else bad "env template missing: $pat"; fi
done
u=$R/studio-agent.service
for pat in '^MemorySwapMax=0' '^LimitCORE=0' '^PrivateTmp=yes' '^NoNewPrivileges=yes' '^ProtectSystem=strict' '^ProtectHome=yes' \
  '^ReadWritePaths=$' '^StateDirectory=$' '^EnvironmentFile=/etc/studio-agent/env' '^IPAddressDeny=any' \
  '^RestrictAddressFamilies=AF_INET AF_INET6$' '^InaccessiblePaths=-/run/systemd/resolve' '^SystemCallErrorNumber=EPERM' '^IPAddressAllow=127.0.0.1/32 100.101.102.103/32$' '^BindsTo=studio-proxy.service' '^Requires=studio-agent-nft.service$' '^Wants=studio-pgrelay.service$' '^CapabilityBoundingSet=$' '^SystemCallFilter=@system-service' \
  '^ExecStartPre=\+/usr/sbin/nft list table inet studio_agent' '--host 127.0.0.1 --port 8123' '^UMask=0077'; do
  if grep -Eq -- "$pat" "$u"; then ok "unit: $pat"; else bad "unit missing: $pat"; fi
done
# squid: exact names only (no regex, no reverse DNS), no Google host, no bump action, IP literals denied first
if [ "$(cat "$R/hosts.txt")" = "bedrock-runtime.ap-south-1.amazonaws.com
api.typesafe.ai" ]; then ok "squid host list: exactly bedrock-runtime.ap-south-1 and api.typesafe.ai"; else bad "squid host list"; fi
if grep -qi 'googleapis\|sts\.' "$R/hosts.txt"; then bad "squid host list names a Google/STS host"; else ok "squid host list: no googleapis, no STS"; fi
for pat in '^acl allowed_dst dstdomain -n ' '^acl allowed_sni ssl::server_name ' '^acl ip_literal url_regex' '^http_access deny ip_literal$' '^http_access deny !CONNECT' '^http_access deny !SSL_ports' '^http_access deny all' \
  '^deny_info TCP_RESET ip_literal' '^deny_info TCP_RESET all' '^ssl_bump peek step1' '^ssl_bump splice step2 has_sni allowed_sni' '^external_acl_type sni_present .*%ssl::>sni' '^acl has_sni external sni_present' '^ssl_bump terminate all' '^cache deny all' '^http_port 127\.0\.0\.1:8889 ssl-bump'; do
  if grep -Eq -- "$pat" "$R/squid.conf"; then ok "squid.conf: $pat"; else bad "squid.conf missing: $pat"; fi
done
if grep -Eq 'dstdom_regex|server_name_regex' "$R/squid.conf"; then bad "squid.conf uses regex ACLs"; else ok "squid.conf: no regex ACLs"; fi
# the rule order that fixes B1: the IP-literal deny is the first http_access line
if [ "$(grep -n '^http_access' "$R/squid.conf" | head -1 | cut -d: -f2-)" = "http_access deny ip_literal" ]; then ok "squid.conf: IP-literal deny is the first http_access rule"; else bad "squid.conf rule order"; fi
if grep -Eq '^ssl_bump +(bump|stare|client-first|server-first)' "$R/squid.conf"; then bad "squid.conf has a decrypting bump action"; else ok "squid.conf: no decryption"; fi
# R3-3: logformat has bytes + termination marker; ClientHello pre-filter in front of squid
for pat in '^logformat studio .*in=%>st out=%<st bump=%ssl::bump_mode'; do
  if grep -Eq -- "$pat" "$R/squid.conf"; then ok "squid.conf: $pat"; else bad "squid.conf missing: $pat"; fi
done
if grep -q ':8888' "$R/squid.conf"; then bad "squid.conf still mentions :8888 (the pre-filter's port)"; else ok "squid.conf: squid is not on the agent-facing port"; fi
pf=$R/studio-prefilter.service
for pat in '^User=studio-prefilter' '^BindsTo=studio-proxy.service' '^IPAddressDeny=any' '^IPAddressAllow=127.0.0.1/32$' '^RestrictAddressFamilies=AF_INET AF_INET6$' '^NoNewPrivileges=yes' '^CapabilityBoundingSet=$' '^MemoryDenyWriteExecute=yes' '^PrivateUsers=yes' \
  '^Environment=PREFILTER_LISTEN_PORT=8888 PREFILTER_UPSTREAM_PORT=8889' '^ExecStart=/usr/bin/python3 -I /usr/local/sbin/studio-ech-prefilter$'; do
  if grep -Eq -- "$pat" "$pf"; then ok "prefilter unit: $pat"; else bad "prefilter unit missing: $pat"; fi
done
if grep -q '^BindsTo=studio-prefilter.service' "$u"; then ok "agent unit BindsTo the pre-filter"; else bad "agent unit does not bind to the pre-filter"; fi
if grep -q 'studio-ech-prefilter' studio-agent-egress-refresh.sh; then bad "egress refresh opens a port for the pre-filter uid"; else ok "nft: nothing opens :8889 to the agent uid"; fi
if grep -q 'studio-prefilter.service' studio-agent-egress-guard.sh; then ok "guard stops the agent when the pre-filter is down"; else bad "guard does not watch the pre-filter"; fi
if python3 -I test_prefilter.py 2>&1 | tail -1 | grep -q '^OK'; then ok "pre-filter parser tests (synthetic ClientHellos: ECH 0xfe0d/0xfe02/0xff02, malformed, oversize, fragmented)"; else bad "pre-filter parser tests"; fi
r=$R/studio-pgrelay.service
for pat in '^User=studio-pgrelay' '^BindReadOnlyPaths=/run/studio-agent/relay-hosts:/etc/hosts' '^IPAddressDeny=any' '^UnsetEnvironment=JOURNAL_STREAM' '^RestrictAddressFamilies=AF_INET AF_INET6$' '^ExecStartPre=\+/usr/sbin/nft list table inet studio_agent' '^ExecStart=/usr/sbin/pgbouncer /run/studio-pgrelay/pgbouncer.ini'; do
  if grep -Eq -- "$pat" "$r"; then ok "relay unit: $pat"; else bad "relay unit missing: $pat"; fi
done

if grep -q 'disable --now' < <(./install-studio-agent.sh --dry-run --rollback); then ok "rollback dry-run"; else bad "rollback dry-run"; fi
if grep -q 'funnel' < <(./install-studio-agent.sh --dry-run --purge-secrets); then ok "purge dry-run"; else bad "purge dry-run"; fi
if grep -q 'xzgrep' < <(./post-session-check.sh --dry-run); then ok "post-session dry-run"; else bad "post-session dry-run"; fi
if grep -q 'bump=terminate' < <(./post-session-check.sh --dry-run) && grep -q 'studio-prefilter' < <(./post-session-check.sh --dry-run); then ok "post-session dry-run lists the egress tally"; else bad "post-session dry-run egress tally"; fi
if ./install-studio-agent.sh --dry-run --tarball /tmp/a.tar --sha256 abc --neon-host a >/dev/null 2>&1; then bad "bad sha256 accepted"; else ok "rejects bad sha256"; fi

if command -v systemd-analyze >/dev/null; then
  cp "$u" "$R/v.service"
  sed -i 's#^EnvironmentFile=.*#EnvironmentFile=-/dev/null#; s#^ExecStart=.*#ExecStart=/bin/true#; s#^ExecStartPre=.*##; s#^User=.*##; s#^Group=.*##; s#^WorkingDirectory=.*##; s#^Requires=.*##; s#^After=.*##' "$R/v.service"
  if systemd-analyze verify "$R/v.service" 2>&1 | grep -Ei 'unknown|invalid|bad|missing key|error'; then bad "systemd-analyze verify (agent)"; else ok "systemd-analyze verify (agent)"; fi
  for g in studio-proxy.service studio-prefilter.service studio-pgrelay.service; do
    cp "$R/$g" "$R/p-$g"; sed -i 's#^ExecStart=.*#ExecStart=/bin/true#; s#^ExecStartPre=.*##; s#^ExecReload=.*##; s#^User=.*##; s#^Group=.*##; s#^Requires=.*##; s#^After=.*##; s#^BindReadOnlyPaths=.*##' "$R/p-$g"
    if systemd-analyze verify "$R/p-$g" 2>&1 | grep -Ei 'unknown|invalid|bad|missing key|error'; then bad "systemd-analyze verify ($g)"; else ok "systemd-analyze verify ($g)"; fi
  done
  for g in studio-agent-egress-guard.service studio-agent-egress-guard.timer studio-agent-nft.service; do
    cp "$R/$g" "$R/g-$g"; sed -i 's#^ExecStart=.*#ExecStart=/bin/true#; s#^Unit=.*##' "$R/g-$g"
    if systemd-analyze verify "$R/g-$g" 2>&1 | grep -Ei 'unknown|invalid|bad|missing key|error'; then bad "systemd-analyze verify ($g)"; else ok "systemd-analyze verify ($g)"; fi
  done
fi
if (cd ../t4-broker && PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -q test_broker 2>&1 | tail -1 | grep -q '^OK'); then ok "t4 broker unit tests (session policy, auth, tailnet-only, caching)"; else bad "t4 broker unit tests"; fi
if ../t4-broker/install-studio-broker.sh --dry-run --render-dir "$R/broker" --listen 100.101.102.103:8765 --allowed-source 100.101.102.104 --gcp-key-file /tmp/none.json >/dev/null 2>&1; then ok "broker installer dry-run"; else bad "broker installer dry-run"; fi
if ../t4-broker/install-studio-broker.sh --dry-run --listen 192.168.1.5:8765 --allowed-source 100.101.102.104 >/dev/null 2>&1; then bad "broker installer accepted a non-tailnet listen address"; else ok "broker installer refuses a non-tailnet listen address"; fi
if ./install-studio-agent.sh --dry-run --tarball /tmp/a.tar --sha256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef --neon-host a --broker 192.168.1.5:8765 >/dev/null 2>&1; then bad "asus installer accepted a non-tailnet broker"; else ok "asus installer refuses a non-tailnet broker address"; fi
if python3 - <<'PY'
import re,sys
src=open('studio-pgrelay-render.sh').read()
m=re.search(r"python3 - <<'PY'\n(.*?)\nPY\n", src, re.S)
compile(m.group(1),'render','exec')
PY
then ok "relay render script python compiles"; else bad "relay render script python"; fi
exit $fail
