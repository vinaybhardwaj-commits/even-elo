#!/usr/bin/env bash
# Offline checks: shellcheck, dry-run coverage of every O2 bullet, systemd-analyze verify.
set -uo pipefail
cd "$(dirname "$0")" || exit 2
fail=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fail=1; }

if command -v shellcheck >/dev/null; then
  if shellcheck -x install-studio-agent.sh post-session-check.sh test-asus-ops.sh; then ok shellcheck; else bad shellcheck; fi
else bad "shellcheck not installed"; fi

out=$(./install-studio-agent.sh --dry-run --tarball /tmp/a.tar --sha256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --neon-host db.example.neon.tech --jev-host jev.tailnet.ts.net 2>&1) || bad "dry-run exit"
for pat in 'useradd --system' '/opt/studio-agent' 'tar -xf /tmp/a.tar' 'sha256sum -c' 'uv sync --frozen' \
  'MemorySwapMax=0' 'LimitCORE=0' 'PrivateTmp=yes' 'NoNewPrivileges=yes' 'ProtectSystem=strict' \
  'ProtectHome=yes' 'ReadWritePaths=$' 'StateDirectory=$' 'EnvironmentFile=/etc/studio-agent/env' \
  'mode 0600, owner root:studio-agent' '--host 127.0.0.1 --port 8123' 'tinyproxy' \
  'sts\\.amazonaws' 'bedrock-runtime\\.ap-south-1' 'googleapis' 'db\\.example\\.neon\\.tech' \
  'jev\\.tailnet' 'skuid "studio-agent"' 'log prefix' 'funnel --bg --set-path /agent' \
  'STUDIO_LIVE_READS=0' 'receive-gcp-key'; do
  if grep -Eq -- "$pat" <<<"$out"; then ok "dry-run: $pat"; else bad "dry-run missing: $pat"; fi
done
if ./install-studio-agent.sh --dry-run --receive-gcp-key | grep -q '0600'; then ok "key mode dry-run"; else bad "key mode dry-run"; fi
if ./install-studio-agent.sh --dry-run --rollback | grep -q 'funnel'; then ok "rollback dry-run"; else bad "rollback dry-run"; fi
if ./post-session-check.sh --dry-run | grep -q 'journalctl'; then ok "post-session dry-run"; else bad "post-session dry-run"; fi
if ./install-studio-agent.sh --dry-run --tarball /tmp/a.tar --sha256 abc --neon-host a --jev-host b >/dev/null 2>&1; then bad "bad sha256 accepted"; else ok "rejects bad sha256"; fi

if command -v systemd-analyze >/dev/null; then
  tmp=$(mktemp -d)
  awk '/studio-agent.service \(mode/{f=1;next} f&&/^\+ /{f=0} f{sub(/^    \| /,"");print}' <<<"$out" >"$tmp/studio-agent.service"
  sed -i 's#^EnvironmentFile=.*#EnvironmentFile=-/dev/null#; s#^ExecStart=.*#ExecStart=/bin/true#; s#^User=.*##; s#^Group=.*##; s#^WorkingDirectory=.*##' "$tmp/studio-agent.service"
  if ! grep -q '^MemorySwapMax=0' "$tmp/studio-agent.service"; then bad "unit extraction empty"; fi
  if systemd-analyze verify "$tmp/studio-agent.service" 2>&1 | grep -v 'tinyproxy.service' | grep -Ei 'unknown|invalid|bad|error'; then
    bad "systemd-analyze verify"; else ok "systemd-analyze verify"; fi
  rm -rf "$tmp"
fi
exit $fail
