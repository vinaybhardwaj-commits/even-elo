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
GUARD_BIN=/usr/local/sbin/studio-agent-egress-guard
UNIT_DIR=/etc/systemd/system
PROXY_PORT=8888
PORT=8123

# name=default; required ones (non-empty before the service may start) are listed separately.
ENV_DEFAULTS=(
  GOV_RO_DATABASE_URL= STUDIO_DATABASE_URL= STUDIO_SERVICE_TOKEN= STUDIO_ACTOR_SECRET=
  STUDIO_LIVE_READS=0 STUDIO_RATE_PER_MIN=30 STUDIO_LOG_LEVEL=INFO
  BEDROCK_AUTH=gcp-federation BEDROCK_REGION=ap-south-1 AWS_STS_REGIONAL_ENDPOINTS=regional AWS_ROLE_ARN= GCP_AUDIENCE=
  "GCP_SA_KEY_FILE=$KEY_FILE"
  BEDROCK_MODEL_SONNET=global.anthropic.claude-sonnet-5-5 BEDROCK_MODEL_HAIKU=global.anthropic.claude-haiku-5-5
  VERTEX_LOCATION=asia-northeast1 VERTEX_MODEL= TYPESAFE_API_KEY= JEV_MODEL=jev-latest
)
REQUIRED_VARS=(
  GOV_RO_DATABASE_URL STUDIO_DATABASE_URL STUDIO_SERVICE_TOKEN STUDIO_ACTOR_SECRET
  AWS_STS_REGIONAL_ENDPOINTS AWS_ROLE_ARN GCP_AUDIENCE BEDROCK_MODEL_SONNET BEDROCK_MODEL_HAIKU TYPESAFE_API_KEY JEV_MODEL
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
# Sets WROTE=1 when the content differs from what is on disk (call it without a pipe: write_file ... < <(render)).
WROTE=0
write_file() {
  local path=$1 mode=$2 owner=$3 new
  new=$(mktemp)
  cat >"$new"
  if [ -f "$path" ] && cmp -s "$new" "$path"; then WROTE=0; else WROTE=1; fi
  if [ "$DRY" = 1 ]; then
    printf '+ write %s (mode %s, owner %s)%s\n' "$path" "$mode" "$owner" "$([ "$WROTE" = 0 ] && echo ' [unchanged]')"
    cp "$new" "$DRYDIR/$(basename "$path")"
    sed 's/^/    | /' "$new"
    rm -f "$new"
  elif [ "$WROTE" = 1 ]; then
    chmod "$mode" "$new"
    chown "$owner" "$new"
    mv -f "$new" "$path"
  else
    rm -f "$new"
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
    --print-env-template) printf '%s\n' "${ENV_DEFAULTS[@]}"; exit 0 ;;
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
for c in uv tinyproxy nft systemctl tailscale python3 curl flock; do
  command -v "$c" >/dev/null || missing+=("$c")
done
if [ ${#missing[@]} -gt 0 ]; then
  if [ "$DRY" = 1 ]; then echo "(dry-run: missing prerequisites: ${missing[*]})"
  else die "missing prerequisites: ${missing[*]} (apt install tinyproxy nftables python3 curl bind9-dnsutils; uv from astral)"; fi
fi

# ---------------------------------------------------------------- renderers
render_agent_unit() {
  cat <<EOT
[Unit]
Description=Even Studio agent (FastAPI, 127.0.0.1:$PORT)
Requires=studio-agent-nft.service
BindsTo=studio-proxy.service
PartOf=studio-agent-nft.service
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
SystemCallErrorNumber=EPERM
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
# network: second egress layer independent of nftables (Neon IPs are added by the refresh script)
RestrictAddressFamilies=AF_INET AF_INET6
IPAddressDeny=any
IPAddressAllow=127.0.0.1/32
# no DNS by any route: resolved (varlink/D-Bus), nscd, avahi and tailscale sockets are invisible to the agent
InaccessiblePaths=-/run/systemd/resolve -/run/dbus -/run/nscd -/run/tailscale -/run/avahi-daemon -/var/run/dbus
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
FilterURLs On
EOT
}

render_proxy_allow() {
  # FilterURLs On: tinyproxy matches the whole request target. A CONNECT target is "host:port", so these
  # patterns accept only CONNECT to :443; any plain-HTTP request ("http://host/...") matches nothing and is refused.
  cat <<'EOT'
^sts\.amazonaws\.com:443$
^sts\.ap-south-1\.amazonaws\.com:443$
^bedrock-runtime\.ap-south-1\.amazonaws\.com:443$
^api\.typesafe\.ai:443$
^oauth2\.googleapis\.com:443$
^iamcredentials\.googleapis\.com:443$
^sts\.googleapis\.com:443$
^aiplatform\.googleapis\.com:443$
^[a-z0-9-]+-aiplatform\.googleapis\.com:443$
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
keys = set(caps.keys()) if isinstance(caps, dict) else set()
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

say "1b. remove the old marked Neon block from /etc/hosts (earlier releases edited it; the agent now uses pins)"
if grep -q '^# BEGIN studio-agent-neon$' /etc/hosts 2>/dev/null; then
  if [ "$DRY" = 1 ]; then
    echo "+ remove the BEGIN/END studio-agent-neon block from /etc/hosts under flock (temp file + rename; in place if bind-mounted)"
  else
    mkdir -p /run/lock
    (
      flock 9
      tmp=$(mktemp /etc/.hosts.XXXXXX)
      sed '/^# BEGIN studio-agent-neon$/,/^# END studio-agent-neon$/d' /etc/hosts >"$tmp"
      if findmnt -n /etc/hosts >/dev/null 2>&1; then cat "$tmp" >/etc/hosts; rm -f "$tmp"
      else chmod --reference=/etc/hosts "$tmp"; mv -f "$tmp" /etc/hosts; fi
    ) 9>/run/lock/studio-agent-egress.lock
  fi
else
  echo "no old hosts block"
fi

say "2. config, units, egress scripts (rewritten only when their content changed)"
PROXY_CHANGED=0 NFT_CHANGED=0 AGENT_UNIT_CHANGED=0 UNITS_CHANGED=0
note_change() { # $1 = group (proxy|nft|agent|unit-only)
  [ "$WROTE" = 1 ] || return 0
  UNITS_CHANGED=1
  case $1 in proxy) PROXY_CHANGED=1 ;; nft) NFT_CHANGED=1 ;; agent) AGENT_UNIT_CHANGED=1 ;; esac
}
run_t systemctl disable --now tinyproxy.service
run systemctl mask tinyproxy.service
write_file "$PROXY_CONF" 0644 root:root < <(render_proxy_conf); note_change proxy
write_file "$PROXY_ALLOW" 0644 root:root < <(render_proxy_allow); note_change proxy
write_file "$UNIT_DIR/studio-proxy.service" 0644 root:root < <(render_proxy_unit); note_change proxy
write_file "$UNIT_DIR/$SVC.service" 0644 root:root < <(render_agent_unit); note_change agent
write_file "$EGRESS_CONF" 0644 root:root < <(printf 'NEON_HOSTS="%s"\n' "${NEON_HOSTS[*]}"); note_change nft
for pair in "studio-agent-egress-refresh.sh:$REFRESH_BIN" "studio-agent-egress-guard.sh:$GUARD_BIN"; do
  src=$HERE/${pair%%:*} dst=${pair##*:}
  WROTE=0; if ! cmp -s "$src" "$dst" 2>/dev/null; then WROTE=1; fi
  run install -m 0755 -o root -g root "$src" "$dst"
  case $dst in "$REFRESH_BIN") note_change nft ;; esac
done
write_file "$UNIT_DIR/studio-agent-nft.service" 0644 root:root < <(cat <<EOT
[Unit]
Description=Studio agent egress rules (nftables + IPAddressAllow + Neon pins)
After=network-online.target nftables.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$REFRESH_BIN

[Install]
WantedBy=multi-user.target
EOT
); note_change nft
write_file "$UNIT_DIR/studio-agent-egress-refresh.service" 0644 root:root < <(cat <<EOT
[Unit]
Description=Re-resolve Neon and refresh studio-agent egress
After=network-online.target

[Service]
Type=oneshot
ExecStart=$REFRESH_BIN
EOT
); note_change unit-only
write_file "$UNIT_DIR/studio-agent-egress-refresh.timer" 0644 root:root < <(cat <<EOT
[Unit]
Description=Refresh studio-agent egress every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOT
); note_change unit-only
write_file "$UNIT_DIR/studio-agent-egress-guard.service" 0644 root:root < <(cat <<EOT
[Unit]
Description=Stop the Studio agent if its egress table or proxy is gone

[Service]
Type=oneshot
ExecStart=$GUARD_BIN
EOT
); note_change unit-only
write_file "$UNIT_DIR/studio-agent-egress-guard.timer" 0644 root:root < <(cat <<EOT
[Unit]
Description=Studio agent egress guard (every 15 s)

[Timer]
OnBootSec=30s
OnUnitActiveSec=15s
AccuracySec=1s

[Install]
WantedBy=timers.target
EOT
); note_change unit-only

say "3. env file $ENV_FILE (0600 root:$SVC): created, or missing names appended; values never touched"
if [ ! -e "$ENV_FILE" ]; then
  write_file "$ENV_FILE" 0600 "root:$SVC" < <(echo "# Fill the empty values by hand (file-to-file); do not paste into chat or tickets."
    printf '%s\n' "${ENV_DEFAULTS[@]}")
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

say "5. proxy and egress layers (restarted only when their config changed)"
run_t systemctl reset-failed studio-proxy.service studio-agent-nft.service "$SVC.service"
[ "$UNITS_CHANGED" = 0 ] || run systemctl daemon-reload
run systemctl enable studio-proxy.service studio-agent-nft.service studio-agent-egress-refresh.timer studio-agent-egress-guard.timer
if [ "$PROXY_CHANGED" = 1 ] || ! systemctl is-active --quiet studio-proxy.service 2>/dev/null; then
  run systemctl restart studio-proxy.service
else echo "studio-proxy unchanged and active; not restarted"; fi
if [ "$NFT_CHANGED" = 1 ] || ! systemctl is-active --quiet studio-agent-nft.service 2>/dev/null; then
  run systemctl restart studio-agent-nft.service
else echo "studio-agent-nft unchanged and active; not restarted"; fi
run systemctl start studio-agent-egress-refresh.timer studio-agent-egress-guard.timer

say "6. GCP SA key: copy over ssh stdin with --receive-gcp-key (see header); never echoed"
[ -f "$KEY_FILE" ] || echo "note: $KEY_FILE not present yet"

say "7. activate (kill switch: STUDIO_LIVE_READS stays 0 until O1 proof passes)"
ready=1
if [ -r "$ENV_FILE" ]; then
  for v in "${REQUIRED_VARS[@]}"; do
    grep -Eq "^$v=.+" "$ENV_FILE" || { echo "env var $v is empty"; ready=0; }
  done
  grep -Eq "^VERTEX_MODEL=.+" "$ENV_FILE" || echo "WARNING: VERTEX_MODEL is unset: the Vertex fallback is disabled"
else
  echo "env file not readable here (dry-run as non-root, or not created yet): treated as not ready"; ready=0
fi
[ -f "$KEY_FILE" ] || { echo "key file missing"; ready=0; }

# health = GET /agent/health answers 401 bad_service_token (the app is up behind its auth middleware),
# sustained for 30 s with the unit's restart counter unchanged. Returns 0 healthy.
agent_healthy() {
  local deadline=$((SECONDS + 45)) good_since="" n0 n1 body
  n0=$(systemctl show "$SVC.service" -p NRestarts --value)
  while [ "$SECONDS" -lt "$deadline" ] || [ -n "$good_since" ]; do
    if body=$(curl -s --noproxy '*' -m 3 -w '\n%{http_code}' "http://127.0.0.1:$PORT/agent/health" 2>/dev/null) \
       && [ "$(tail -n1 <<<"$body")" = 401 ] && grep -q bad_service_token <<<"$body"; then
      [ -n "$good_since" ] || good_since=$SECONDS
      n1=$(systemctl show "$SVC.service" -p NRestarts --value)
      [ "$n1" = "$n0" ] || return 1
      [ $((SECONDS - good_since)) -ge 30 ] && return 0
    else
      [ -z "$good_since" ] || return 1  # was healthy, then stopped answering
    fi
    systemctl is-active --quiet "$SVC.service" || [ "$(systemctl is-active "$SVC.service")" = activating ] || return 1
    sleep 2
  done
  return 1
}

if [ "$ready" = 1 ]; then
  prev=$(readlink -f "$CURRENT" 2>/dev/null || true)
  if [ "$prev" = "$REL" ] && [ "$AGENT_UNIT_CHANGED" = 0 ] && systemctl is-active --quiet "$SVC.service" 2>/dev/null; then
    echo "release $REL already current and the agent is active; nothing to restart"
  else
    run ln -sfn "$REL" "$CURRENT.new"
    run mv -T "$CURRENT.new" "$CURRENT"
    run systemctl enable "$SVC.service"
    run_t systemctl reset-failed "$SVC.service"
    run systemctl restart "$SVC.service"
    if [ "$DRY" = 0 ]; then
      if ! agent_healthy; then
        journalctl -u "$SVC" -n 15 --no-pager -o cat 2>/dev/null | sed 's/^/   | /' || true
        if [ -n "$prev" ] && [ -d "$prev" ] && [ "$prev" != "$REL" ]; then
          ln -sfn "$prev" "$CURRENT.new"; mv -T "$CURRENT.new" "$CURRENT"
          systemctl reset-failed "$SVC.service" || true
          systemctl restart "$SVC.service" || true
          rm -rf "$REL"
          die "new release failed the 30 s health check; reverted to $prev ('previous' unchanged)"
        fi
        die "agent failed the health check (no previous release to revert to); see journalctl -u $SVC"
      fi
      # success: only now does 'previous' move
      if [ -n "$prev" ] && [ "$prev" != "$REL" ]; then ln -sfn "$prev" "$APP_DIR/previous"; fi
      for d in "$RELEASES"/*; do
        case $(readlink -f "$d") in "$(readlink -f "$CURRENT")"|"$(readlink -f "$APP_DIR/previous" 2>/dev/null || echo none)") ;; *) rm -rf "$d" ;; esac
      done
    else
      echo "+ health: GET http://127.0.0.1:$PORT/agent/health = 401 bad_service_token for 30 s, NRestarts unchanged; else revert to previous and keep 'previous' as is"
    fi
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
