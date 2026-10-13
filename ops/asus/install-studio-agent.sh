#!/usr/bin/env bash
# Install / update the Studio agent on the Asus (Ubuntu, tailnet). Spec: OPS-PLAN-M0S2.md O2.
# Idempotent. Prints no secret; secrets move file-to-file or via stdin only.
#
#   sudo ./install-studio-agent.sh --tarball PATH --sha256 HEX --neon-host H --jev-host H [--dry-run]
#   (tarball: `git archive <commit> studio/apps/agent` made by gov-orch, copied over ssh; no git credentials on this host)
#   ssh t4 'cat <key.json>' | ssh asus 'sudo ./install-studio-agent.sh --receive-gcp-key'
#   sudo ./install-studio-agent.sh --rollback
set -euo pipefail

SVC=studio-agent
APP_DIR=/opt/studio-agent
SRC_DIR=$APP_DIR/src
AGENT_REL=studio/apps/agent
VENV=$APP_DIR/venv
ETC_DIR=/etc/studio-agent
ENV_FILE=$ETC_DIR/env
KEY_FILE=$ETC_DIR/gcp-sa.json
UNIT=/etc/systemd/system/$SVC.service
PROXY_PORT=8888
PORT=8123
REQUIRED_VARS=(GOV_RO_DATABASE_URL STUDIO_DATABASE_URL STUDIO_SERVICE_TOKEN STUDIO_ACTOR_SECRET GCP_AUDIENCE AWS_ROLE_ARN)

DRY=0 MODE=install TARBALL="" SHA256="" NEON_HOST="" JEV_HOST=""

die() { printf 'error: %s\n' "$*" >&2; exit 2; }
say() { printf '== %s\n' "$*"; }

run() {
  if [ "$DRY" = 1 ]; then printf '+ %s\n' "$*"; else "$@"; fi
}

# write_file PATH MODE OWNER:GROUP  (content on stdin; never used for secrets)
write_file() {
  local path=$1 mode=$2 owner=$3
  if [ "$DRY" = 1 ]; then
    printf '+ write %s (mode %s, owner %s)\n' "$path" "$mode" "$owner"
    sed 's/^/    | /'
  else
    local tmp
    tmp=$(mktemp "$path.XXXXXX")
    cat >"$tmp"
    chmod "$mode" "$tmp"
    chown "$owner" "$tmp"
    mv -f "$tmp" "$path"
  fi
}

usage() { sed -n '2,10p' "$0"; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) DRY=1 ;;
    --tarball) TARBALL=${2:-}; shift ;;
    --sha256) SHA256=${2:-}; shift ;;
    --neon-host) NEON_HOST=${2:-}; shift ;;
    --jev-host) JEV_HOST=${2:-}; shift ;;
    --receive-gcp-key) MODE=key ;;
    --rollback) MODE=rollback ;;
    -h|--help) usage 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

if [ "$DRY" = 0 ] && [ "$(id -u)" != 0 ]; then die "run as root (sudo), or use --dry-run"; fi

# ---------------------------------------------------------------- rollback
if [ "$MODE" = rollback ]; then
  say "rollback: stop service, funnel off (data and env kept)"
  run tailscale funnel --https=443 --set-path /agent off
  run systemctl disable --now "$SVC.service"
  exit 0
fi

# ---------------------------------------------------------------- GCP key via stdin
if [ "$MODE" = key ]; then
  say "receive GCP SA key on stdin -> $KEY_FILE (0600 $SVC), never echoed"
  if [ "$DRY" = 1 ]; then
    echo "+ umask 077; cat > $KEY_FILE.new  (stdin; must be non-empty and contain a service_account type)"
    echo "+ chown $SVC:$SVC $KEY_FILE.new; chmod 0600; mv -f $KEY_FILE.new $KEY_FILE"
    exit 0
  fi
  [ -d "$ETC_DIR" ] || die "$ETC_DIR missing; run the installer first"
  umask 077
  tmp=$ETC_DIR/.gcp-sa.json.new
  cat >"$tmp"
  if [ ! -s "$tmp" ] || ! grep -q '"type"[[:space:]]*:[[:space:]]*"service_account"' "$tmp"; then
    rm -f "$tmp"; die "stdin did not look like a service account key"
  fi
  chown "$SVC:$SVC" "$tmp"; chmod 0600 "$tmp"; mv -f "$tmp" "$KEY_FILE"
  say "key installed ($(stat -c '%a %U' "$KEY_FILE"))"
  exit 0
fi

# ---------------------------------------------------------------- install
[ -n "$TARBALL" ] || die "--tarball PATH required"
[[ $SHA256 =~ ^[0-9a-f]{64}$ ]] || die "--sha256 must be the 64-hex digest of the tarball (pin)"
[ "$DRY" = 1 ] || [ -f "$TARBALL" ] || die "tarball not found: $TARBALL"
[[ $NEON_HOST =~ ^[A-Za-z0-9.-]+$ ]] || die "--neon-host required (hostname)"
[[ $JEV_HOST =~ ^[A-Za-z0-9.-]+$ ]] || die "--jev-host required (tailnet hostname)"
if [ "$DRY" = 0 ]; then
  for c in uv tailscale tinyproxy nft systemctl; do
    command -v "$c" >/dev/null || die "missing prerequisite: $c (apt install tinyproxy nftables; uv from astral)"
  done
fi

say "1. system user and directories"
if [ "$DRY" = 1 ] || ! id "$SVC" >/dev/null 2>&1; then
  run useradd --system --home-dir "$APP_DIR" --no-create-home --shell /usr/sbin/nologin "$SVC"
fi
run install -d -o "$SVC" -g "$SVC" -m 0750 "$APP_DIR"
run install -d -o root -g "$SVC" -m 0750 "$ETC_DIR"

say "2. unpack pinned tarball (sha256 checked) into $SRC_DIR, uv sync --frozen"
if [ "$DRY" = 1 ]; then
  echo "+ sha256sum -c: $SHA256  $TARBALL"
else
  echo "$SHA256  $TARBALL" | sha256sum -c --quiet - || die "tarball sha256 mismatch"
fi
run rm -rf "$SRC_DIR"
run install -d -o "$SVC" -g "$SVC" -m 0750 "$SRC_DIR"
run tar -xf "$TARBALL" -C "$SRC_DIR" --no-same-owner --no-same-permissions
run chown -R "$SVC:$SVC" "$SRC_DIR"
run sudo -u "$SVC" env UV_PROJECT_ENVIRONMENT="$VENV" UV_CACHE_DIR="$APP_DIR/.cache" \
  uv sync --frozen --no-dev --project "$SRC_DIR/$AGENT_REL"

say "3. env file $ENV_FILE (0600 root:$SVC); kept if present; STUDIO_LIVE_READS=0"
if [ "$DRY" = 1 ] || [ ! -e "$ENV_FILE" ]; then
  write_file "$ENV_FILE" 0600 "root:$SVC" <<EOT
# Fill the empty values by hand (file-to-file); do not paste into chat or tickets.
GOV_RO_DATABASE_URL=
STUDIO_DATABASE_URL=
STUDIO_SERVICE_TOKEN=
STUDIO_ACTOR_SECRET=
STUDIO_LIVE_READS=0
STUDIO_RATE_PER_MIN=30
STUDIO_LOG_LEVEL=INFO
BEDROCK_AUTH=gcp-federation
BEDROCK_REGION=ap-south-1
AWS_REGION=ap-south-1
AWS_ROLE_ARN=
GCP_AUDIENCE=
GCP_SA_KEY_FILE=$KEY_FILE
GOOGLE_APPLICATION_CREDENTIALS=$KEY_FILE
EOT
else
  echo "env file exists, left untouched"
fi

say "4. systemd unit $UNIT (127.0.0.1:$PORT only)"
write_file "$UNIT" 0644 root:root <<EOT
[Unit]
Description=Even Studio agent (FastAPI, 127.0.0.1:$PORT)
After=network-online.target tinyproxy.service
Wants=network-online.target tinyproxy.service

[Service]
Type=simple
User=$SVC
Group=$SVC
WorkingDirectory=$SRC_DIR/$AGENT_REL
EnvironmentFile=$ENV_FILE
Environment=HTTPS_PROXY=http://127.0.0.1:$PROXY_PORT HTTP_PROXY=http://127.0.0.1:$PROXY_PORT
Environment=NO_PROXY=127.0.0.1,localhost PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
ExecStart=$VENV/bin/uvicorn main:app --host 127.0.0.1 --port $PORT --no-access-log
Restart=on-failure
RestartSec=5
MemorySwapMax=0
LimitCORE=0
PrivateTmp=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=
StateDirectory=
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
SystemCallArchitectures=native
# ids-only logging is enforced by the app's log filter (src/studio_logging.py); access log is off.

[Install]
WantedBy=multi-user.target
EOT

say "5a. tinyproxy allowlist on 127.0.0.1:$PROXY_PORT (CONNECT 443 only, default deny)"
write_file /etc/tinyproxy/studio-agent.conf 0644 root:root <<EOT
User tinyproxy
Group tinyproxy
Listen 127.0.0.1
Port $PROXY_PORT
Timeout 600
LogLevel Notice
LogFile "/var/log/tinyproxy/studio-agent.log"
MaxClients 20
ConnectPort 443
Filter "/etc/tinyproxy/studio-agent.allow"
FilterDefaultDeny Yes
FilterExtended On
FilterURLs Off
EOT
jev_re=${JEV_HOST//./\\.}
neon_re=${NEON_HOST//./\\.}
write_file /etc/tinyproxy/studio-agent.allow 0644 root:root <<EOT
^sts\.amazonaws\.com\$
^bedrock-runtime\.ap-south-1\.amazonaws\.com\$
^([a-z0-9-]+\.)?googleapis\.com\$
^$neon_re\$
^$jev_re\$
EOT
run systemctl enable tinyproxy.service
run systemctl restart tinyproxy.service

say "5b. nftables: drop and log any other outbound from uid $SVC (Postgres 5432 to Neon IPs only; libpq cannot use an HTTP proxy)"
write_file /usr/local/sbin/studio-agent-nft-refresh 0755 root:root <<EOT
#!/usr/bin/env bash
# Rebuild the studio-agent egress table; Neon IPs are re-resolved each run.
set -euo pipefail
ips=\$(getent ahostsv4 "$NEON_HOST" | awk '{print \$1}' | sort -u | paste -sd, -)
[ -n "\$ips" ] || { echo "neon host did not resolve; leaving table as is" >&2; exit 1; }
nft -f - <<NFT
table inet studio_agent
delete table inet studio_agent
table inet studio_agent {
  chain out {
    type filter hook output priority 0; policy accept;
    meta skuid "$SVC" oifname "lo" accept
    meta skuid "$SVC" ip daddr { \$ips } tcp dport 5432 accept
    meta skuid "$SVC" limit rate 10/minute log prefix "studio-agent-egress-drop " counter drop
    meta skuid "$SVC" counter drop
  }
}
NFT
EOT
write_file /etc/systemd/system/studio-agent-nft.service 0644 root:root <<EOT
[Unit]
Description=Studio agent egress nftables rules
Before=$SVC.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/studio-agent-nft-refresh
[Install]
WantedBy=multi-user.target
EOT
write_file /etc/systemd/system/studio-agent-nft.timer 0644 root:root <<EOT
[Unit]
Description=Refresh Neon IPs in the studio-agent egress set
[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
EOT
run systemctl daemon-reload
run systemctl enable studio-agent-nft.service
run systemctl start studio-agent-nft.service
run systemctl enable --now studio-agent-nft.timer

say "6. GCP SA key: copy over ssh stdin with --receive-gcp-key (see header); never echoed"
if [ "$DRY" = 1 ]; then
  echo "(key present check: test -f $KEY_FILE)"
elif [ ! -f "$KEY_FILE" ]; then
  echo "WARNING: $KEY_FILE not present yet; service will not start until it is."
fi

say "7. start (kill switch: STUDIO_LIVE_READS stays 0 until O1 proof passes)"
ready=1
if [ "$DRY" = 0 ]; then
  for v in "${REQUIRED_VARS[@]}"; do
    grep -Eq "^$v=.+" "$ENV_FILE" || { echo "env var $v is empty"; ready=0; }
  done
  [ -f "$KEY_FILE" ] || ready=0
fi
run systemctl enable "$SVC.service"
if [ "$ready" = 1 ]; then
  run systemctl restart "$SVC.service"
else
  echo "not starting: fill $ENV_FILE and install the key, then: systemctl start $SVC"
fi

say "8. Tailscale Funnel: /agent only -> 127.0.0.1:$PORT/agent"
run tailscale funnel --bg --set-path /agent "http://127.0.0.1:$PORT/agent"
run tailscale funnel status

say "done (post-session check: ops/asus/post-session-check.sh)"
