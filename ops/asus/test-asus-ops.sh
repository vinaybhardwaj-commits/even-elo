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
  if shellcheck -x ./*.sh; then ok shellcheck; else bad shellcheck; fi
else bad "shellcheck not installed"; fi

out=$(./install-studio-agent.sh --dry-run --render-dir "$R" --tarball /tmp/none.tar \
  --sha256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef --neon-host db.example.neon.tech 2>&1) || bad "dry-run exit"
for pat in 'tar -xf /tmp/none.tar' 'uv sync --frozen' 'releases/0123456789ab' \
  'mask squid' 'mask pgbouncer' 'studio-proxy.service' 'studio-pgrelay.service' 'ProtectSystem=strict' 'BindsTo=studio-proxy.service' 'PartOf=studio-agent-nft.service' \
  'studio-agent-egress-refresh.timer' 'studio-agent-egress-guard.timer' 'nft -c ok' 'api.*typesafe.*ai' 'not activating|health: GET' ; do
  if grep -Eq -- "$pat" <<<"$out"; then ok "dry-run: $pat"; else bad "dry-run missing: $pat"; fi
done
# state-independent: the env template comes from the installer itself, not from this host's /etc
tpl=$(./install-studio-agent.sh --print-env-template)
for pat in '^AWS_STS_REGIONAL_ENDPOINTS=regional$' '^TYPESAFE_API_KEY=$' '^VERTEX_MODEL=$' '^JEV_MODEL=' '^STUDIO_LIVE_READS=0$' '^BEDROCK_MODEL_SONNET='; do
  if grep -Eq -- "$pat" <<<"$tpl"; then ok "env template: $pat"; else bad "env template missing: $pat"; fi
done
u=$R/studio-agent.service
for pat in '^MemorySwapMax=0' '^LimitCORE=0' '^PrivateTmp=yes' '^NoNewPrivileges=yes' '^ProtectSystem=strict' '^ProtectHome=yes' \
  '^ReadWritePaths=$' '^StateDirectory=$' '^EnvironmentFile=/etc/studio-agent/env' '^IPAddressDeny=any' \
  '^RestrictAddressFamilies=AF_INET AF_INET6$' '^InaccessiblePaths=-/run/systemd/resolve' '^SystemCallErrorNumber=EPERM' '^IPAddressAllow=127.0.0.1/32$' '^BindsTo=studio-proxy.service' '^Requires=studio-agent-nft.service studio-pgrelay.service' '^CapabilityBoundingSet=$' '^SystemCallFilter=@system-service' \
  '^ExecStartPre=\+/usr/sbin/nft list table inet studio_agent' '--host 127.0.0.1 --port 8123' '^UMask=0077'; do
  if grep -Eq -- "$pat" "$u"; then ok "unit: $pat"; else bad "unit missing: $pat"; fi
done
# squid: exact anchored hosts only, no googleapis wildcard beyond the regional aiplatform host, no bump action
if ! grep -vq '^\^.*\$$' "$R/hosts.regex" && grep -q 'api\\.typesafe\\.ai' "$R/hosts.regex" && ! grep -Eq '^\^\(|\.\*' "$R/hosts.regex"; then ok "squid host list: anchored, exact"; else bad "squid host list"; fi
for pat in '^http_access deny !CONNECT' '^http_access deny !SSL_ports' '^http_access deny all' '^ssl_bump peek step1' '^ssl_bump splice allowed_sni' '^ssl_bump terminate all' '^cache deny all' '^http_port 127\.0\.0\.1:8888 ssl-bump'; do
  if grep -Eq -- "$pat" "$R/squid.conf"; then ok "squid.conf: $pat"; else bad "squid.conf missing: $pat"; fi
done
if grep -Eq '^ssl_bump +(bump|stare|client-first|server-first)' "$R/squid.conf"; then bad "squid.conf has a decrypting bump action"; else ok "squid.conf: no decryption"; fi
r=$R/studio-pgrelay.service
for pat in '^User=studio-pgrelay' '^BindReadOnlyPaths=/run/studio-agent/relay-hosts:/etc/hosts' '^IPAddressDeny=any' '^UnsetEnvironment=JOURNAL_STREAM' '^RestrictAddressFamilies=AF_INET AF_INET6$' '^ExecStartPre=\+/usr/sbin/nft list table inet studio_agent' '^ExecStart=/usr/sbin/pgbouncer /run/studio-pgrelay/pgbouncer.ini'; do
  if grep -Eq -- "$pat" "$r"; then ok "relay unit: $pat"; else bad "relay unit missing: $pat"; fi
done

if grep -q 'disable --now' < <(./install-studio-agent.sh --dry-run --rollback); then ok "rollback dry-run"; else bad "rollback dry-run"; fi
if grep -q 'funnel' < <(./install-studio-agent.sh --dry-run --purge-secrets); then ok "purge dry-run"; else bad "purge dry-run"; fi
if grep -q 'xzgrep' < <(./post-session-check.sh --dry-run); then ok "post-session dry-run"; else bad "post-session dry-run"; fi
if ./install-studio-agent.sh --dry-run --tarball /tmp/a.tar --sha256 abc --neon-host a >/dev/null 2>&1; then bad "bad sha256 accepted"; else ok "rejects bad sha256"; fi

if command -v systemd-analyze >/dev/null; then
  cp "$u" "$R/v.service"
  sed -i 's#^EnvironmentFile=.*#EnvironmentFile=-/dev/null#; s#^ExecStart=.*#ExecStart=/bin/true#; s#^ExecStartPre=.*##; s#^User=.*##; s#^Group=.*##; s#^WorkingDirectory=.*##; s#^Requires=.*##; s#^After=.*##' "$R/v.service"
  if systemd-analyze verify "$R/v.service" 2>&1 | grep -Ei 'unknown|invalid|bad|missing key|error'; then bad "systemd-analyze verify (agent)"; else ok "systemd-analyze verify (agent)"; fi
  for g in studio-proxy.service studio-pgrelay.service; do
    cp "$R/$g" "$R/p-$g"; sed -i 's#^ExecStart=.*#ExecStart=/bin/true#; s#^ExecStartPre=.*##; s#^ExecReload=.*##; s#^User=.*##; s#^Group=.*##; s#^Requires=.*##; s#^After=.*##; s#^BindReadOnlyPaths=.*##' "$R/p-$g"
    if systemd-analyze verify "$R/p-$g" 2>&1 | grep -Ei 'unknown|invalid|bad|missing key|error'; then bad "systemd-analyze verify ($g)"; else ok "systemd-analyze verify ($g)"; fi
  done
  for g in studio-agent-egress-guard.service studio-agent-egress-guard.timer studio-agent-nft.service; do
    cp "$R/$g" "$R/g-$g"; sed -i 's#^ExecStart=.*#ExecStart=/bin/true#; s#^Unit=.*##' "$R/g-$g"
    if systemd-analyze verify "$R/g-$g" 2>&1 | grep -Ei 'unknown|invalid|bad|missing key|error'; then bad "systemd-analyze verify ($g)"; else ok "systemd-analyze verify ($g)"; fi
  done
fi
if python3 - <<'PY'
import re,sys
src=open('studio-pgrelay-render.sh').read()
m=re.search(r"python3 - <<'PY'\n(.*?)\nPY\n", src, re.S)
compile(m.group(1),'render','exec')
PY
then ok "relay render script python compiles"; else bad "relay render script python"; fi
exit $fail
