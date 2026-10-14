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
for pat in 'useradd --system' 'tar -xf /tmp/none.tar' 'uv sync --frozen' 'releases/0123456789ab' \
  'mask tinyproxy' 'studio-proxy.service' 'ProtectSystem=strict' 'Requires=studio-agent-nft.service studio-proxy.service' \
  'mode 0600, owner root:studio-agent' 'studio-agent-egress-refresh.timer' 'nft -c ok' \
  'api.*typesafe.*ai' 'TYPESAFE_API_KEY' 'VERTEX_MODEL' 'JEV_MODEL' 'rollback|not activating' ; do
  if grep -Eq -- "$pat" <<<"$out"; then ok "dry-run: $pat"; else bad "dry-run missing: $pat"; fi
done
u=$R/studio-agent.service
for pat in '^MemorySwapMax=0' '^LimitCORE=0' '^PrivateTmp=yes' '^NoNewPrivileges=yes' '^ProtectSystem=strict' '^ProtectHome=yes' \
  '^ReadWritePaths=$' '^StateDirectory=$' '^EnvironmentFile=/etc/studio-agent/env' '^IPAddressDeny=any' \
  '^RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX' '^CapabilityBoundingSet=$' '^SystemCallFilter=@system-service' \
  '^ExecStartPre=\+/usr/sbin/nft list table inet studio_agent' '--host 127.0.0.1 --port 8123' '^UMask=0077'; do
  if grep -Eq -- "$pat" "$u"; then ok "unit: $pat"; else bad "unit missing: $pat"; fi
done
if grep -q 'googleapis' "$R/tinyproxy.allow" && ! grep -Eq '^\^\(' "$R/tinyproxy.allow"; then ok "no googleapis wildcard"; else bad "googleapis wildcard"; fi
if grep -q 'FilterDefaultDeny Yes' "$R/tinyproxy.conf" && grep -q 'Listen 127.0.0.1' "$R/tinyproxy.conf"; then ok "proxy default-deny, loopback"; else bad "proxy conf"; fi

if ./install-studio-agent.sh --dry-run --rollback | grep -q 'disable --now'; then ok "rollback dry-run"; else bad "rollback dry-run"; fi
if ./install-studio-agent.sh --dry-run --purge-secrets | grep -q shred; then ok "purge dry-run"; else bad "purge dry-run"; fi
if ./post-session-check.sh --dry-run | grep -q 'zgrep'; then ok "post-session dry-run"; else bad "post-session dry-run"; fi
if ./install-studio-agent.sh --dry-run --tarball /tmp/a.tar --sha256 abc --neon-host a >/dev/null 2>&1; then bad "bad sha256 accepted"; else ok "rejects bad sha256"; fi

if command -v systemd-analyze >/dev/null; then
  cp "$u" "$R/v.service"
  sed -i 's#^EnvironmentFile=.*#EnvironmentFile=-/dev/null#; s#^ExecStart=.*#ExecStart=/bin/true#; s#^ExecStartPre=.*##; s#^User=.*##; s#^Group=.*##; s#^WorkingDirectory=.*##; s#^Requires=.*##; s#^After=.*##' "$R/v.service"
  if systemd-analyze verify "$R/v.service" 2>&1 | grep -Ei 'unknown|invalid|bad|missing key|error'; then bad "systemd-analyze verify (agent)"; else ok "systemd-analyze verify (agent)"; fi
  cp "$R/studio-proxy.service" "$R/p.service"; sed -i 's#^ExecStart=.*#ExecStart=/bin/true#; s#^User=.*##; s#^Group=.*##; s#^SupplementaryGroups=.*##' "$R/p.service"
  if systemd-analyze verify "$R/p.service" 2>&1 | grep -Ei 'unknown|invalid|bad|missing key|error'; then bad "systemd-analyze verify (proxy)"; else ok "systemd-analyze verify (proxy)"; fi
fi
exit $fail
