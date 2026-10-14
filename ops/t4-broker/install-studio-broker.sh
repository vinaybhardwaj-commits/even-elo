#!/usr/bin/env bash
# Install / update the Studio credential broker on t4 (tailnet only). See README.md. Idempotent. Needs root.
# Prints no secret; the GCP key is copied file-to-file from a path that already exists on this host.
#
#   sudo ./install-studio-broker.sh --listen TAILNET_IP:PORT --allowed-source ASUS_TAILNET_IP[,..] \
#        --gcp-key-file /path/on/t4/key.json [--dry-run [--render-dir DIR]]
#   sudo ./install-studio-broker.sh --stop         stop and disable the broker (credentials already issued live out their TTL)
#   sudo ./install-studio-broker.sh --purge        stop, disable, shred the broker's copy of the key and its env
set -euo pipefail

SVC=studio-broker
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=/opt/studio-broker
ETC_DIR=/etc/studio-broker
ENV_FILE=$ETC_DIR/env
KEY_FILE=$ETC_DIR/gcp-sa.json
UNIT=/etc/systemd/system/$SVC.service
ENV_DEFAULTS=(
  BROKER_LISTEN= BROKER_ALLOWED_SOURCES= BROKER_TOKEN=
  BROKER_ROLE_ARN= BROKER_GCP_AUDIENCE= "BROKER_GCP_SA_KEY_FILE=$KEY_FILE"
  BROKER_AWS_REGION=ap-south-1 "BROKER_MODEL_IDS=global.anthropic.claude-sonnet-5-5,global.anthropic.claude-haiku-5-5"
  BROKER_DURATION=3600
)
REQUIRED=(BROKER_LISTEN BROKER_ALLOWED_SOURCES BROKER_TOKEN BROKER_ROLE_ARN BROKER_GCP_AUDIENCE BROKER_MODEL_IDS)

DRY=0 MODE=install LISTEN="" SOURCES="" KEYSRC="" RENDER_DIR=""
die() { printf 'error: %s\n' "$*" >&2; exit 2; }
say() { printf '== %s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then printf '+ %s\n' "$*"; else "$@"; fi; }
run_t() { if [ "$DRY" = 1 ]; then printf '+ %s   (failure tolerated)\n' "$*"; return 0; fi; "$@" || printf '  (ignored: "%s" exited %s)\n' "$*" "$?"; }

while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) DRY=1 ;;
    --render-dir) RENDER_DIR=${2:-}; shift ;;
    --listen) LISTEN=${2:-}; shift ;;
    --allowed-source) SOURCES=${2:-}; shift ;;
    --gcp-key-file) KEYSRC=${2:-}; shift ;;
    --stop) MODE=stop ;;
    --purge) MODE=purge ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
if [ "$DRY" = 1 ]; then
  if [ -n "$RENDER_DIR" ]; then DRYDIR=$RENDER_DIR; mkdir -p "$DRYDIR"; else DRYDIR=$(mktemp -d); fi
elif [ "$(id -u)" != 0 ]; then die "run as root (sudo), or use --dry-run"; fi

if [ "$MODE" = stop ]; then run_t systemctl disable --now "$SVC.service"; exit 0; fi
if [ "$MODE" = purge ]; then
  run_t systemctl disable --now "$SVC.service"
  run_t shred -u "$KEY_FILE"
  run_t shred -u "$ENV_FILE"
  exit 0
fi

[[ $LISTEN =~ ^[0-9a-fA-F:.]+:[0-9]+$ ]] || die "--listen must be TAILNET_IP:PORT"
LHOST=${LISTEN%:*}
python3 - "$LHOST" <<'PY' || die "--listen $LHOST is not a tailnet address (100.64.0.0/10 or fd7a:115c:a1e0::/48): the broker never listens elsewhere"
import ipaddress, sys
ip = ipaddress.ip_address(sys.argv[1])
sys.exit(0 if ip in ipaddress.ip_network("100.64.0.0/10") or ip in ipaddress.ip_network("fd7a:115c:a1e0::/48") else 1)
PY
[ -n "$SOURCES" ] || die "--allowed-source required (the Asus tailnet IP)"
[[ $SOURCES =~ ^[0-9a-fA-F:./,]+$ ]] || die "bad --allowed-source"
if [ -z "$KEYSRC" ]; then
  [ "$DRY" = 1 ] || [ -f "$KEY_FILE" ] || die "--gcp-key-file required on first install"
elif [ ! -f "$KEYSRC" ] && [ "$DRY" = 0 ]; then
  die "key file not found: $KEYSRC"
fi
for c in uv systemctl python3 openssl; do
  if ! command -v "$c" >/dev/null; then
    if [ "$DRY" = 1 ]; then echo "(dry-run: missing $c)"; else die "missing prerequisite: $c"; fi
  fi
done

render_unit() {
  cat <<EOT
[Unit]
Description=Studio credential broker (GCP key -> scoped AWS Bedrock credentials; tailnet only)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=$SVC
Group=$SVC
EnvironmentFile=$ENV_FILE
ExecStart=$APP_DIR/venv/bin/python $APP_DIR/broker.py
Restart=on-failure
RestartSec=5
UMask=0077
LimitCORE=0
MemorySwapMax=0
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProcSubset=pid
ProtectProc=invisible
RemoveIPC=yes
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
PrivateUsers=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
SystemCallErrorNumber=EPERM
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
# AF_UNIX stays: name resolution on t4 may go through systemd-resolved / nscd sockets. The broker's outbound
# (Google, AWS STS) cannot be an IP allowlist; its inbound is tailnet-only by construction (it refuses any other bind address).
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
InaccessiblePaths=-/home -/root

[Install]
WantedBy=multi-user.target
EOT
}

say "1. user and directories"
if id "$SVC" >/dev/null 2>&1; then echo "user $SVC exists"
else run useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$SVC"; fi
run install -d -o root -g root -m 0755 "$APP_DIR"
run install -d -o root -g "$SVC" -m 0750 "$ETC_DIR"

say "2. code and venv (uv sync --frozen, as root)"
for f in broker.py pyproject.toml uv.lock; do run install -o root -g root -m 0644 "$HERE/$f" "$APP_DIR/$f"; done
run env UV_PROJECT_ENVIRONMENT="$APP_DIR/venv" UV_CACHE_DIR=/var/cache/studio-broker-uv UV_PYTHON_INSTALL_DIR="$APP_DIR/python" \
  uv sync --frozen --no-dev --project "$APP_DIR"
run chmod -R a+rX,go-w "$APP_DIR"

say "3. GCP key (copied file-to-file, never echoed) and env"
if [ -n "$KEYSRC" ]; then
  run install -o "$SVC" -g "$SVC" -m 0600 "$KEYSRC" "$KEY_FILE"
fi
if [ ! -e "$ENV_FILE" ]; then
  if [ "$DRY" = 1 ]; then
    echo "+ create $ENV_FILE (0600 root) with a fresh BROKER_TOKEN from openssl rand -hex 32"
  else
    (
      umask 077
      {
        echo "# BROKER_ROLE_ARN (GCPBedrockRole) and BROKER_GCP_AUDIENCE are filled by hand; BROKER_TOKEN is generated here."
        printf '%s\n' "${ENV_DEFAULTS[@]}"
      } >"$ENV_FILE"
    )
    sed -i "s#^BROKER_LISTEN=.*#BROKER_LISTEN=$LISTEN#; s#^BROKER_ALLOWED_SOURCES=.*#BROKER_ALLOWED_SOURCES=$SOURCES#; s#^BROKER_TOKEN=.*#BROKER_TOKEN=$(openssl rand -hex 32)#" "$ENV_FILE"
    chown root:root "$ENV_FILE"; chmod 0600 "$ENV_FILE"
  fi
else
  echo "$ENV_FILE exists; token and the hand-filled values are left as they are"
  if [ "$DRY" = 0 ]; then
    sed -i "s#^BROKER_LISTEN=.*#BROKER_LISTEN=$LISTEN#; s#^BROKER_ALLOWED_SOURCES=.*#BROKER_ALLOWED_SOURCES=$SOURCES#" "$ENV_FILE"
  fi
fi

say "4. unit $UNIT"
if [ "$DRY" = 1 ]; then
  printf '+ write %s (0644 root)\n' "$UNIT"
  render_unit | tee "$DRYDIR/$SVC.service" | sed 's/^/    | /'
else
  render_unit >"$UNIT.new"; chmod 0644 "$UNIT.new"; mv -f "$UNIT.new" "$UNIT"
fi
run systemctl daemon-reload

say "5. start only when the env is complete"
ready=1
if [ -r "$ENV_FILE" ]; then
  for v in "${REQUIRED[@]}"; do
    grep -Eq "^$v=.+" "$ENV_FILE" || { echo "$v is empty in $ENV_FILE"; ready=0; }
  done
else
  echo "env not readable here: treated as not ready"; ready=0
fi
[ -f "$KEY_FILE" ] || { echo "key file missing"; ready=0; }
if [ "$ready" = 1 ]; then
  run systemctl enable "$SVC.service"
  run systemctl restart "$SVC.service"
else
  echo "not starting: fill $ENV_FILE (BROKER_ROLE_ARN, BROKER_GCP_AUDIENCE), then rerun this installer"
fi
say "done"
