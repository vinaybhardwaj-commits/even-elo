#!/usr/bin/env bash
# Install / upgrade the Studio agent on the Asus (Ubuntu, tailnet). Spec: OPS-PLAN-M0S2.md O2 (+R2 rulings).
# Idempotent. Prints no secret; secrets move file-to-file or via stdin only. Needs root (NOPASSWD sudo).
#
#   sudo ./install-studio-agent.sh --tarball PATH --sha256 HEX --neon-host H [--neon-host H2 ...] [--dry-run [--render-dir DIR]]
#     tarball = `git archive <commit> studio/apps/agent`, made by gov-orch and copied over ssh (no git credentials here)
#   ssh t4 'cat KEY.json' | ssh asus 'sudo ./install-studio-agent.sh --receive-gcp-key'   (needs NOPASSWD sudo: no tty)
#   sudo ./install-studio-agent.sh --rollback        stop the agent, funnel off (keeps env, key, egress rules)
#   sudo ./install-studio-agent.sh --purge-secrets   stop the agent, shred env and key
set -euo pipefail

SVC=studio-agent
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=/opt/studio-agent
RELEASES=$APP_DIR/releases
CURRENT=$APP_DIR/current
AGENT_REL=studio/apps/agent
ETC_DIR=/etc/studio-agent
ENV_FILE=$ETC_DIR/env
KEY_FILE=$ETC_DIR/gcp-sa.json
PROXY_CONF=$ETC_DIR/tinyproxy.conf
PROXY_ALLOW=$ETC_DIR/tinyproxy.allow
EGRESS_CONF=$ETC_DIR/egress.conf
REFRESH_BIN=/usr/local/sbin/studio-agent-egress-refresh
UNIT_DIR=/etc/systemd/system
PROXY_PORT=8888
PORT=8123

# name=default; required ones (non-empty before the service may start) are listed separately.
ENV_DEFAULTS=(
  GOV_RO_DATABASE_URL= STUDIO_DATABASE_URL= STUDIO_SERVICE_TOKEN= STUDIO_ACTOR_SECRET=
  STUDIO_LIVE_READS=0 STUDIO_RATE_PER_MIN=30 STUDIO_LOG_LEVEL=INFO
  BEDROCK_AUTH=gcp-federation BEDROCK_REGION=ap-south-1 AWS_ROLE_ARN= GCP_AUDIENCE=
  "GCP_SA_KEY_FILE=$KEY_FILE"
  BEDROCK_MODEL_SONNET=global.anthropic.claude-sonnet-5-5 BEDROCK_MODEL_HAIKU=global.anthropic.claude-haiku-5-5
  VERTEX_LOCATION=asia-northeast1 VERTEX_MODEL= TYPESAFE_API_KEY= JEV_MODEL=jev-latest
)
REQUIRED_VARS=(
  GOV_RO_DATABASE_URL STUDIO_DATABASE_URL STUDIO_SERVICE_TOKEN STUDIO_ACTOR_SECRET
  AWS_ROLE_ARN GCP_AUDIENCE BEDROCK_MODEL_SONNET BEDROCK_MODEL_HAIKU VERTEX_MODEL TYPESAFE_API_KEY JEV_MODEL
)

DRY=0 MODE=install TARBALL="" SHA256="" NEON_HOSTS=() RENDER_DIR=""

die() { printf 'error: %s\n' "$*" >&2; exit 2; }
say() { printf '== %s\n' "$*"; }

run() {
  if [ "$DRY" = 1 ]; then printf '+ %s\n' "$*"; else "$@"; fi
}
# run, but a failure is reported and tolerated (rollback / purge)
run_t() {
  if [ "$DRY" = 1 ]; then printf '+ %s   (failure tolerated)\n' "$*"; return 0; fi
  "$@" || printf '  (ignored: "%s" exited %s)\n' "$*" "$?"
}

# write_file PATH MODE OWNER:GROUP  (content on stdin; never used for secrets)
write_file() {
  local path=$1 mode=$2 owner=$3
  if [ "$DRY" = 1 ]; then
    printf '+ write %s (mode %s, owner %s)\n' "$path" "$mode" "$owner"
    tee "$DRYDIR/$(basename "$path")" | sed 's/^/    | /'
  else
    local tmp
    tmp=$(mktemp "$path.XXXXXX")
    cat >"$tmp"
    chmod "$mode" "$tmp"
    chown "$owner" "$tmp"
    mv -f "$tmp" "$path"
  fi
}

while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) DRY=1 ;;
    --render-dir) RENDER_DIR=${2:-}; shift ;;
    --tarball) TARBALL=${2:-}; shift ;;
    --sha256) SHA256=${2:-}; shift ;;
    --neon-host) NEON_HOSTS+=("${2:-}"); shift ;;
    --receive-gcp-key) MODE=key ;;
    --rollback) MODE=rollback ;;
    --purge-secrets) MODE=purge ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

if [ "$DRY" = 1 ]; then
  if [ -n "$RENDER_DIR" ]; then DRYDIR=$RENDER_DIR; mkdir -p "$DRYDIR"; else DRYDIR=$(mktemp -d); fi
elif [ "$(id -u)" != 0 ]; then
  die "run as root (sudo), or use --dry-run"
fi

# ---------------------------------------------------------------- rollback / purge
if [ "$MODE" = rollback ]; then
  say "rollback: stop and disable the agent first, then funnel off; every step tolerant"
  run_t systemctl disable --now "$SVC.service"
  run_t tailscale funnel --https=443 --set-path /agent off
  echo "agent stopped. env, key, proxy and egress rules kept (use --purge-secrets to remove secrets)."
  exit 0
fi
if [ "$MODE" = purge ]; then
  say "purge-secrets: stop the agent, shred env and key"
  run_t systemctl disable --now "$SVC.service"
  run_t shred -u "$ENV_FILE"
  run_t shred -u "$KEY_FILE"
  exit 0
fi

# ---------------------------------------------------------------- GCP key via stdin
if [ "$MODE" = key ]; then
  say "receive GCP SA key on stdin -> $KEY_FILE (0600 $SVC), never echoed"
  if [ "$DRY" = 1 ]; then
    echo "+ umask 077; cat > $ETC_DIR/.gcp-sa.json.new  (stdin; non-empty, must contain a service_account type)"
    echo "+ chown $SVC:$SVC; chmod 0600; mv -f to $KEY_FILE"
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
  say "key installed ($(stat -c '%a %U' "$KEY_FILE")); rerun the installer to start the agent"
  exit 0
fi

# ---------------------------------------------------------------- argument checks
[ -n "$TARBALL" ] || die "--tarball PATH required"
[[ $SHA256 =~ ^[0-9a-f]{64}$ ]] || die "--sha256 must be the 64-hex digest of the tarball (pin)"
[ ${#NEON_HOSTS[@]} -gt 0 ] || die "--neon-host required (repeat for each Neon host in the two database URLs)"
for h in "${NEON_HOSTS[@]}"; do [[ $h =~ ^[A-Za-z0-9.-]+$ ]] || die "bad --neon-host: $h"; done
if [ -f "$TARBALL" ]; then
  echo "$SHA256  $TARBALL" | sha256sum -c --quiet - || die "tarball sha256 mismatch"
elif [ "$DRY" = 1 ]; then
  echo "(dry-run: tarball $TARBALL not present here; sha256 check skipped)"
else
  die "tarball not found: $TARBALL"
fi
REL=$RELEASES/${SHA256:0:12}

missing=()
for c in uv tinyproxy nft systemctl tailscale python3; do
  command -v "$c" >/dev/null || missing+=("$c")
done
if [ ${#missing[@]} -gt 0 ]; then
  if [ "$DRY" = 1 ]; then echo "(dry-run: missing prerequisites: ${missing[*]})"
  else die "missing prerequisites: ${missing[*]} (apt install tinyproxy nftables python3; uv from astral)"; fi
fi

# ---------------------------------------------------------------- renderers
render_agent_unit() {
  cat <<EOT
[Unit]
Description=Even Studio agent (FastAPI, 127.0.0.1:$PORT)
Requires=studio-agent-nft.service studio-proxy.service
After=network-online.target studio-agent-nft.service studio-proxy.service
Wants=network-online.target

[Service]
Type=simple
User=$SVC
Group=$SVC
WorkingDirectory=$CURRENT/app/$AGENT_REL
EnvironmentFile=$ENV_FILE
Environment=HTTPS_PROXY=http://127.0.0.1:$PROXY_PORT HTTP_PROXY=http://127.0.0.1:$PROXY_PORT
Environment=NO_PROXY=127.0.0.1,localhost PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
# fail closed: no egress table, no agent
ExecStartPre=+/usr/sbin/nft list table inet studio_agent
ExecStart=$CURRENT/venv/bin/uvicorn main:app --host 127.0.0.1 --port $PORT --no-access-log
Restart=on-failure
RestartSec=5
UMask=0077
# memory and files
MemorySwapMax=0
LimitCORE=0
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=
StateDirectory=
ProcSubset=pid
ProtectProc=invisible
RemoveIPC=yes
# privileges
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
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
# network: second egress layer independent of nftables (Neon IPs are added by the refresh script)
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
IPAddressDeny=any
IPAddressAllow=localhost
# ids-only logging is enforced by the app's log filter (src/studio_logging.py); the access log is off.

[Install]
WantedBy=multi-user.target
EOT
}

render_proxy_unit() {
  cat <<EOT
[Unit]
Description=Studio agent egress allowlist proxy (127.0.0.1:$PROXY_PORT, default deny)
After=network-online.target
Wants=network-online.target

[Service]
User=tinyproxy
Group=tinyproxy
SupplementaryGroups=$SVC
ExecStart=/usr/bin/tinyproxy -d -c $PROXY_CONF
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes

[Install]
WantedBy=multi-user.target
EOT
}

render_proxy_conf() {
  cat <<EOT
Port $PROXY_PORT
Listen 127.0.0.1
Timeout 600
Syslog On
LogLevel Notice
MaxClients 20
DisableViaHeader Yes
ConnectPort 443
Filter "$PROXY_ALLOW"
FilterDefaultDeny Yes
FilterExtended On
FilterURLs Off
EOT
}

render_proxy_allow() {
  cat <<'EOT'
^sts\.amazonaws\.com$
^sts\.ap-south-1\.amazonaws\.com$
^bedrock-runtime\.ap-south-1\.amazonaws\.com$
^api\.typesafe\.ai$
^oauth2\.googleapis\.com$
^iamcredentials\.googleapis\.com$
^sts\.googleapis\.com$
^aiplatform\.googleapis\.com$
^[a-z0-9-]+-aiplatform\.googleapis\.com$
EOT
}

# ---------------------------------------------------------------- preflight: Funnel
preflight_funnel() {
  if ! command -v tailscale >/dev/null; then
    [ "$DRY" = 1 ] && { echo "(dry-run: tailscale missing, funnel preflight skipped)"; return 0; }
    die "tailscale missing"
  fi
  local st serve
  st=$(tailscale status --json) || die "tailscale status failed"
  ST="$st" python3 - <<'PY' || die "this node lacks the Funnel capability: enable 'funnel' (and 'https') nodeAttrs for it in the tailnet policy, then retry"
import json, os, sys
d = json.loads(os.environ["ST"])
caps = (d.get("Self") or {}).get("CapMap") or {}
keys = " ".join(caps.keys()) if isinstance(caps, dict) else ""
sys.exit(0 if ("funnel" in keys and "https" in keys) else 1)
PY
  serve=$(tailscale serve status --json) || die "tailscale serve status failed"
  SERVE="$serve" python3 - <<'PY' || die "a :443 serve/funnel handler other than /agent exists; Funnel exposes the whole :443 config, so remove it first (tailscale serve status)"
import json, os, sys
raw = os.environ["SERVE"].strip()
d = json.loads(raw) if raw else {}
bad = []
for hp, w in (d.get("Web") or {}).items():
    if hp.endswith(":443"):
        bad += [p for p in (w.get("Handlers") or {}) if p != "/agent"]
for port, t in (d.get("TCP") or {}).items():
    if port == "443" and (t or {}).get("TCPForward"):
        bad.append("tcp-forward")
if bad:
    print("offending :443 handlers: " + ", ".join(bad), file=sys.stderr)
    sys.exit(1)
PY
}

say "0. preflight: Funnel capability and :443 handlers"
preflight_funnel

say "1. system user and directories"
if ! id "$SVC" >/dev/null 2>&1; then
  run useradd --system --home-dir "$APP_DIR" --no-create-home --shell /usr/sbin/nologin "$SVC"
else
  echo "user $SVC exists"
fi
run install -d -o "$SVC" -g "$SVC" -m 0750 "$APP_DIR"
run install -d -o root -g root -m 0755 "$RELEASES"
run install -d -o root -g "$SVC" -m 0750 "$ETC_DIR"

say "2. config, units, egress refresh script"
run_t systemctl disable --now tinyproxy.service
run systemctl mask tinyproxy.service
render_proxy_conf | write_file "$PROXY_CONF" 0644 root:root
render_proxy_allow | write_file "$PROXY_ALLOW" 0644 root:root
render_proxy_unit | write_file "$UNIT_DIR/studio-proxy.service" 0644 root:root
render_agent_unit | write_file "$UNIT_DIR/$SVC.service" 0644 root:root
printf 'NEON_HOSTS="%s"\n' "${NEON_HOSTS[*]}" | write_file "$EGRESS_CONF" 0644 root:root
if [ "$DRY" = 1 ]; then
  echo "+ install -m 0755 -o root -g root $HERE/studio-agent-egress-refresh.sh $REFRESH_BIN"
else
  install -m 0755 -o root -g root "$HERE/studio-agent-egress-refresh.sh" "$REFRESH_BIN"
fi
write_file "$UNIT_DIR/studio-agent-nft.service" 0644 root:root <<EOT
[Unit]
Description=Studio agent egress rules (nftables + hosts block + IPAddressAllow)
After=network-online.target nftables.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$REFRESH_BIN

[Install]
WantedBy=multi-user.target
EOT
write_file "$UNIT_DIR/studio-agent-egress-refresh.service" 0644 root:root <<EOT
[Unit]
Description=Re-resolve Neon and refresh studio-agent egress
After=network-online.target

[Service]
Type=oneshot
ExecStart=$REFRESH_BIN
EOT
write_file "$UNIT_DIR/studio-agent-egress-refresh.timer" 0644 root:root <<EOT
[Unit]
Description=Refresh studio-agent egress every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOT

say "3. env file $ENV_FILE (0600 root:$SVC): created, or missing names appended; values never touched"
if [ ! -e "$ENV_FILE" ]; then
  { echo "# Fill the empty values by hand (file-to-file); do not paste into chat or tickets."
    printf '%s\n' "${ENV_DEFAULTS[@]}"; } | write_file "$ENV_FILE" 0600 "root:$SVC"
else
  echo "env file exists; checking for names added since the last release"
  for line in "${ENV_DEFAULTS[@]}"; do
    name=${line%%=*}
    if [ "$DRY" = 1 ] && [ ! -r "$ENV_FILE" ]; then echo "(dry-run: env unreadable, name check skipped)"; break; fi
    if ! grep -q "^$name=" "$ENV_FILE"; then
      if [ "$DRY" = 1 ]; then echo "+ append $name to $ENV_FILE"; else printf '%s\n' "$line" >>"$ENV_FILE"; fi
    fi
  done
fi

say "4. build release ${SHA256:0:12} as root (uv sync --frozen) into $REL; $CURRENT untouched until it succeeds"
if [ -f "$REL/.complete" ]; then
  echo "release already built, reusing"
else
  run rm -rf "$REL"
  run install -d -m 0755 "$REL/app"
  if [ "$DRY" = 1 ]; then
    echo "+ tar -xf $TARBALL -C $REL/app --no-same-owner"
    echo "+ UV_PROJECT_ENVIRONMENT=$REL/venv UV_CACHE_DIR=/var/cache/studio-agent-uv UV_PYTHON_INSTALL_DIR=$APP_DIR/python uv sync --frozen --no-dev --project $REL/app/$AGENT_REL"
    echo "+ chmod -R a+rX,go-w $REL $APP_DIR/python; touch $REL/.complete"
  else
    {
      tar -xf "$TARBALL" -C "$REL/app" --no-same-owner &&
      [ -d "$REL/app/$AGENT_REL" ] &&
      UV_PROJECT_ENVIRONMENT="$REL/venv" UV_CACHE_DIR=/var/cache/studio-agent-uv UV_PYTHON_INSTALL_DIR="$APP_DIR/python" \
        uv sync --frozen --no-dev --project "$REL/app/$AGENT_REL" &&
      chmod -R a+rX,go-w "$REL" &&
      { [ ! -d "$APP_DIR/python" ] || chmod -R a+rX,go-w "$APP_DIR/python"; } &&
      touch "$REL/.complete"
    } || { rm -rf "$REL"; die "release build failed; $CURRENT and the running service are untouched"; }
  fi
fi

say "5. proxy and egress layers up (enabled), before the agent can start"
run systemctl daemon-reload
run systemctl enable studio-proxy.service studio-agent-nft.service studio-agent-egress-refresh.timer
run systemctl restart studio-proxy.service
run systemctl restart studio-agent-nft.service
run systemctl start studio-agent-egress-refresh.timer

say "6. GCP SA key: copy over ssh stdin with --receive-gcp-key (see header); never echoed"
[ -f "$KEY_FILE" ] || echo "note: $KEY_FILE not present yet"

say "7. activate (kill switch: STUDIO_LIVE_READS stays 0 until O1 proof passes)"
ready=1
if [ -r "$ENV_FILE" ]; then
  for v in "${REQUIRED_VARS[@]}"; do
    grep -Eq "^$v=.+" "$ENV_FILE" || { echo "env var $v is empty"; ready=0; }
  done
else
  echo "env file not readable here (dry-run as non-root, or not created yet): treated as not ready"; ready=0
fi
[ -f "$KEY_FILE" ] || { echo "key file missing"; ready=0; }

if [ "$ready" = 1 ]; then
  prev=$(readlink -f "$CURRENT" 2>/dev/null || true)
  run ln -sfn "$REL" "$CURRENT.new"
  run mv -T "$CURRENT.new" "$CURRENT"
  if [ -n "$prev" ] && [ "$prev" != "$REL" ]; then run ln -sfn "$prev" "$APP_DIR/previous"; fi
  run systemctl enable "$SVC.service"
  run systemctl restart "$SVC.service"
  if [ "$DRY" = 0 ]; then
    sleep 4
    if ! systemctl is-active --quiet "$SVC.service"; then
      if [ -n "$prev" ] && [ -d "$prev" ]; then
        ln -sfn "$prev" "$CURRENT.new"; mv -T "$CURRENT.new" "$CURRENT"
        systemctl restart "$SVC.service" || true
        die "new release failed to start; reverted to $prev"
      fi
      die "agent failed to start (no previous release to revert to); see journalctl -u $SVC"
    fi
    for d in "$RELEASES"/*; do
      case $(readlink -f "$d") in "$(readlink -f "$CURRENT")"|"$(readlink -f "$APP_DIR/previous" 2>/dev/null || echo none)") ;; *) rm -rf "$d" ;; esac
    done
  fi
  say "8. Tailscale Funnel: /agent only -> 127.0.0.1:$PORT/agent"
  run tailscale funnel --bg --set-path /agent "http://127.0.0.1:$PORT/agent"
  run tailscale funnel status
else
  echo "not activating: fill $ENV_FILE and install the key, then rerun this installer (agent stays disabled, funnel not opened)"
fi

if [ "$DRY" = 1 ]; then
  say "dry-run config checks"
  if [ -x "$HERE/studio-agent-egress-refresh.sh" ]; then
    STUDIO_EGRESS_TEST_IPS="192.0.2.10 2001:db8::10" "$HERE/studio-agent-egress-refresh.sh" --check
  fi
  if command -v tinyproxy >/dev/null; then
    sed "s#$ETC_DIR/#$DRYDIR/#g; s#^Port .*#Port 18999#" "$DRYDIR/tinyproxy.conf" >"$DRYDIR/tinyproxy.check.conf"
    # tinyproxy has no check-only mode: start it on a scratch port; a bad config exits at once
    tinyproxy -d -c "$DRYDIR/tinyproxy.check.conf" >"$DRYDIR/tinyproxy.check.out" 2>&1 &
    tp=$!
    sleep 1
    if kill -0 "$tp" 2>/dev/null; then
      kill "$tp"; wait "$tp" 2>/dev/null || true; echo "tinyproxy config parsed ok"
    else
      cat "$DRYDIR/tinyproxy.check.out" >&2; die "tinyproxy rejected the rendered config"
    fi
  else
    echo "(tinyproxy not installed here; config check skipped)"
  fi
fi
say "done (post-session check: ops/asus/post-session-check.sh)"
