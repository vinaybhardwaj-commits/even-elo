#!/usr/bin/env bash
# Install / upgrade the Studio agent on the Asus (Ubuntu, tailnet). Spec: OPS-PLAN-M0S2.md O2 (+R2..R6 rulings).
# Idempotent. Prints no secret; secrets move file-to-file or via stdin only. Needs root (NOPASSWD sudo).
#
#   sudo ./install-studio-agent.sh --tarball PATH --sha256 HEX --neon-host H [--neon-host H2 ...] --broker TAILNET_IP:PORT [--dry-run [--render-dir DIR]]
#     tarball = `git archive <commit> studio/apps/agent`, made by gov-orch and copied over ssh (no git credentials here)
#   (no GCP key lives here any more: AWS credentials come from the t4 credential broker, see ops/t4-broker)
#   ssh t4 'sudo sed -n s/^BROKER_TOKEN=//p /etc/studio-broker/env' | ssh asus 'sudo ./install-studio-agent.sh --receive-broker-token'   (NOPASSWD sudo: no tty)
#   sudo ./install-studio-agent.sh --stop            incident stop: stop agent and relay, hold them down until the next install (see README)
#   sudo ./install-studio-agent.sh --rollback        stop+disable agent and relay, funnel off (keeps env and egress rules)
#   sudo ./install-studio-agent.sh --purge-secrets   stop+disable agent and relay, funnel off, shred env and Neon credentials
set -euo pipefail

SVC=studio-agent
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=/opt/studio-agent
RELEASES=$APP_DIR/releases
CURRENT=$APP_DIR/current
AGENT_REL=studio/apps/agent
ETC_DIR=/etc/studio-agent
ENV_FILE=$ETC_DIR/env
OLD_KEY_FILE=$ETC_DIR/gcp-sa.json   # earlier releases kept the GCP key here; the installer shreds it
AWS_CONFIG=$ETC_DIR/aws-config
AWS_HELPER=/usr/local/bin/studio-aws-creds
STOP_FLAG=/run/studio-agent/operator-stop
PROXY_DIR=/etc/studio-proxy
PROXY_CONF=$PROXY_DIR/squid.conf
PROXY_HOSTS=$PROXY_DIR/hosts.txt
PROXY_CERT=$PROXY_DIR/splice-only.pem
RELAY=studio-pgrelay
RELAY_DIR=/etc/studio-pgrelay
NEON_ENV=$RELAY_DIR/neon.env
LOCAL_ENV=$RELAY_DIR/local.env
RELAY_BIN=/usr/local/sbin/studio-pgrelay-render
RELAY_PORT=6432
EGRESS_CONF=$ETC_DIR/egress.conf
REFRESH_BIN=/usr/local/sbin/studio-agent-egress-refresh
GUARD_BIN=/usr/local/sbin/studio-agent-egress-guard
UNIT_DIR=/etc/systemd/system
PROXY_PORT=8888
PORT=8123

# name=default; required ones (non-empty before the service may start) are listed separately.
# AWS credentials come from the t4 broker through credential_process (BEDROCK_AUTH=default-chain): no GCP variable, no AWS role,
# no key file on this host. Vertex is OFF here (VERTEX_* unset).
ENV_DEFAULTS=(
  GOV_RO_DATABASE_URL= STUDIO_DATABASE_URL= STUDIO_SERVICE_TOKEN= STUDIO_ACTOR_SECRET=
  STUDIO_LIVE_READS=0 STUDIO_RATE_PER_MIN=30 STUDIO_LOG_LEVEL=INFO
  BEDROCK_AUTH=default-chain BEDROCK_REGION=ap-south-1 AWS_REGION=ap-south-1 AWS_STS_REGIONAL_ENDPOINTS=regional
  "AWS_CONFIG_FILE=$AWS_CONFIG" AWS_EC2_METADATA_DISABLED=true STUDIO_BROKER_URL= STUDIO_BROKER_TOKEN=
  BEDROCK_MODEL_SONNET=global.anthropic.claude-sonnet-5-5 BEDROCK_MODEL_HAIKU=global.anthropic.claude-haiku-5-5
  TYPESAFE_API_KEY= JEV_MODEL=jev-latest
)
# Names an earlier release put in the env file that must not exist on this host any more (migration removes them).
RETIRED_VARS=(GCP_SA_KEY_FILE GCP_SA_KEY_JSON GCP_AUDIENCE GOOGLE_APPLICATION_CREDENTIALS AWS_ROLE_ARN VERTEX_MODEL VERTEX_LOCATION)
# GOV_RO_DATABASE_URL / STUDIO_DATABASE_URL are NOT operator-filled: the installer points them at the relay (127.0.0.1:6432);
# STUDIO_BROKER_URL is derived from --broker. STUDIO_BROKER_TOKEN is the one secret copied from t4 by hand.
REQUIRED_VARS=(
  STUDIO_SERVICE_TOKEN STUDIO_ACTOR_SECRET STUDIO_BROKER_TOKEN
  AWS_STS_REGIONAL_ENDPOINTS BEDROCK_MODEL_SONNET BEDROCK_MODEL_HAIKU TYPESAFE_API_KEY JEV_MODEL
)

DRY=0 MODE=install TARBALL="" SHA256="" NEON_HOSTS=() RENDER_DIR="" BROKER=""

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
    --broker) BROKER=${2:-}; shift ;;
    --stop) MODE=stop ;;
    --receive-broker-token) MODE=token ;;
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

# ---------------------------------------------------------------- broker token via stdin
if [ "$MODE" = token ]; then
  say "receive the broker token on stdin -> STUDIO_BROKER_TOKEN in $ENV_FILE (never echoed, never in argv)"
  if [ "$DRY" = 1 ]; then echo "+ read one line from stdin (32+ alphanumerics); rewrite the STUDIO_BROKER_TOKEN line of $ENV_FILE in place"; exit 0; fi
  [ -f "$ENV_FILE" ] || die "$ENV_FILE missing; run the installer first"
  python3 -c '
import os, re, sys
env = sys.argv[1]
tok = sys.stdin.readline().strip()
if not re.fullmatch(r"[A-Za-z0-9]{32,128}", tok):
    sys.exit("stdin did not look like a broker token")
lines = open(env).read().splitlines()
out, done = [], False
for l in lines:
    if l.startswith("STUDIO_BROKER_TOKEN="):
        l, done = "STUDIO_BROKER_TOKEN=" + tok, True
    out.append(l)
if not done:
    out.append("STUDIO_BROKER_TOKEN=" + tok)
tmp = env + ".new"
with open(tmp, "w") as f:
    f.write("\n".join(out) + "\n")
st = os.stat(env)
os.chmod(tmp, 0o600); os.chown(tmp, st.st_uid, st.st_gid); os.rename(tmp, env)
' "$ENV_FILE" || die "token not installed"
  say "token installed; rerun the installer to start the agent"
  exit 0
fi

# ---------------------------------------------------------------- stop / rollback / purge
if [ "$MODE" = stop ]; then
  say "stop: hold the agent and the relay down (flag $STOP_FLAG); an install clears it, a reboot clears it"
  if [ "$DRY" = 1 ]; then echo "+ touch $STOP_FLAG"; else install -d -o root -g "$SVC" -m 0750 "$(dirname "$STOP_FLAG")" 2>/dev/null || true; touch "$STOP_FLAG"; fi
  run_t systemctl stop "$SVC.service"
  run_t systemctl stop "$RELAY.service"
  echo "agent and relay stopped; the egress refresh will not restart them while the flag exists. (--rollback also disables them.)"
  exit 0
fi
if [ "$MODE" = rollback ]; then
  say "rollback: stop and disable the agent first, then the relay (drops its pool), then funnel off; every step tolerant"
  run_t systemctl disable --now "$SVC.service"
  run_t systemctl disable --now "$RELAY.service"
  run_t tailscale funnel --https=443 --set-path /agent off
  echo "agent and relay stopped and disabled. env, Neon credentials, proxy and egress rules kept (use --purge-secrets to remove secrets)."
  exit 0
fi
if [ "$MODE" = purge ]; then
  say "purge-secrets: stop+disable agent and relay (they stay disabled), funnel off, shred env and Neon credentials"
  run_t systemctl disable --now "$SVC.service"
  run_t systemctl disable --now "$RELAY.service"
  run_t tailscale funnel --https=443 --set-path /agent off
  run_t shred -u "$ENV_FILE"
  run_t shred -u "$OLD_KEY_FILE"
  run_t shred -u "$AWS_CONFIG"
  run_t shred -u "$NEON_ENV"
  run_t shred -u "$LOCAL_ENV"
  exit 0
fi

# ---------------------------------------------------------------- argument checks
[ -n "$TARBALL" ] || die "--tarball PATH required"
[[ $SHA256 =~ ^[0-9a-f]{64}$ ]] || die "--sha256 must be the 64-hex digest of the tarball (pin)"
[ ${#NEON_HOSTS[@]} -gt 0 ] || die "--neon-host required (repeat for each Neon host in the two database URLs)"
for h in "${NEON_HOSTS[@]}"; do [[ $h =~ ^[A-Za-z0-9.-]+$ ]] || die "bad --neon-host: $h"; done
[[ $BROKER =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}:[0-9]{1,5}$ ]] || die "--broker must be TAILNET_IPV4:PORT (the t4 credential broker)"
BROKER_IP=${BROKER%:*}
python3 - "$BROKER_IP" <<'PY' || die "--broker $BROKER_IP is not a tailnet address (100.64.0.0/10)"
import ipaddress, sys
sys.exit(0 if ipaddress.ip_address(sys.argv[1]) in ipaddress.ip_network("100.64.0.0/10") else 1)
PY
if [ -f "$TARBALL" ]; then
  echo "$SHA256  $TARBALL" | sha256sum -c --quiet - || die "tarball sha256 mismatch"
elif [ "$DRY" = 1 ]; then
  echo "(dry-run: tarball $TARBALL not present here; sha256 check skipped)"
else
  die "tarball not found: $TARBALL"
fi
REL=$RELEASES/${SHA256:0:12}

missing=()
for c in uv squid pgbouncer nft systemctl tailscale python3 curl flock openssl; do
  command -v "$c" >/dev/null || missing+=("$c")
done
if [ ${#missing[@]} -gt 0 ]; then
  if [ "$DRY" = 1 ]; then echo "(dry-run: missing prerequisites: ${missing[*]})"
  else die "missing prerequisites: ${missing[*]} (apt install squid-openssl pgbouncer nftables python3 curl openssl bind9-dnsutils; uv from astral)"; fi
fi

# ---------------------------------------------------------------- renderers
render_agent_unit() {
  cat <<EOT
[Unit]
Description=Even Studio agent (FastAPI, 127.0.0.1:$PORT)
Requires=studio-agent-nft.service
Wants=studio-pgrelay.service
BindsTo=studio-proxy.service
PartOf=studio-agent-nft.service
After=network-online.target studio-agent-nft.service studio-proxy.service studio-pgrelay.service
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
# network: second egress layer independent of nftables. The agent talks to loopback only (squid :8888, relay :6432) and to the
# t4 credential broker on the tailnet; it holds no Neon address, no Neon credential and no GCP key.
RestrictAddressFamilies=AF_INET AF_INET6
IPAddressDeny=any
IPAddressAllow=127.0.0.1/32 $BROKER_IP/32
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
Description=Studio agent egress proxy (squid: CONNECT :443, TLS server-name allowlist, no decryption; 127.0.0.1:$PROXY_PORT)
After=network-online.target
Wants=network-online.target

[Service]
User=proxy
Group=proxy
ExecStart=/usr/sbin/squid -N -s -f $PROXY_CONF
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
RuntimeDirectory=studio-proxy
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
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
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
InaccessiblePaths=-/opt/studio-agent -/etc/studio-agent -/etc/studio-pgrelay

[Install]
WantedBy=multi-user.target
EOT
}

render_proxy_conf() {
  cat <<EOT
# CONNECT to :443 only, to exactly the names in $PROXY_HOSTS. ssl_bump peeks at the TLS ClientHello and splices (blind
# tunnel) only when the server name (SNI) is in the same list; everything else is terminated. There is no bump action,
# so nothing is decrypted. The certificate below is a throwaway that Squid insists on when ssl-bump is enabled; no client
# trusts it, it signs nothing, and a denied client is reset before any handshake (deny_info TCP_RESET).
# Exact names only, never a reverse lookup: "-n" on dstdomain, and IP-literal targets (v4 and v6) are denied first.
http_port 127.0.0.1:$PROXY_PORT ssl-bump tls-cert=$PROXY_CERT generate-host-certificates=off
acl ip_literal url_regex -i ^([0-9]{1,3}\\.){3}[0-9]{1,3}(:[0-9]+)?\$
acl ip_literal url_regex -i ^\\[
acl ip_literal url_regex -i ^[0-9a-f]*:[0-9a-f]*:[0-9a-f:.]*\$
acl allowed_dst dstdomain -n "$PROXY_HOSTS"
acl allowed_sni ssl::server_name "$PROXY_HOSTS"
acl step1 at_step SslBump1
acl SSL_ports port 443
acl CONNECT method CONNECT
http_access deny ip_literal
http_access deny !CONNECT
http_access deny !SSL_ports
http_access allow CONNECT allowed_dst
http_access deny all
deny_info TCP_RESET ip_literal
deny_info TCP_RESET CONNECT
deny_info TCP_RESET SSL_ports
deny_info TCP_RESET all
ssl_bump peek step1
ssl_bump splice allowed_sni
ssl_bump terminate all
cache deny all
cache_mem 8 MB
cache_log /dev/null
pid_filename none
visible_hostname studio-proxy
via off
forwarded_for delete
client_persistent_connections off
shutdown_lifetime 3 seconds
logformat studio %Ss/%03>Hs %rm %>rd:%>rP sni=%ssl::>sni
access_log syslog:daemon.info studio
EOT
}

render_proxy_hosts() {
  # exact host names, one per line (no leading dot = no subdomains). No *.googleapis.com: Google front ends route on the
  # HTTP Host header regardless of SNI, so an allowed Google name would reach every Google service. GCP federation lives
  # on the t4 broker. No STS either: the broker hands over ready-made credentials.
  cat <<'EOT'
bedrock-runtime.ap-south-1.amazonaws.com
api.typesafe.ai
EOT
}

render_relay_unit() {
  cat <<EOT
[Unit]
Description=Studio agent Neon relay (pgbouncer; TLS verify-full to the pinned Neon endpoint; 127.0.0.1:$RELAY_PORT)
Requires=studio-agent-nft.service
After=network-online.target studio-agent-nft.service
Wants=network-online.target

[Service]
Type=simple
User=$RELAY
Group=$RELAY
RuntimeDirectory=$RELAY
RuntimeDirectoryMode=0750
# the real Neon credentials stay in $NEON_ENV; the rendered config lives on tmpfs only
ExecStartPre=+$RELAY_BIN
ExecStartPre=+/usr/sbin/nft list table inet studio_agent
ExecStart=/usr/sbin/pgbouncer /run/$RELAY/pgbouncer.ini
ExecReload=+$RELAY_BIN
ExecReload=/bin/kill -HUP \$MAINPID
Restart=on-failure
RestartSec=5
# the relay has no DNS: it sees only the pinned addresses
BindReadOnlyPaths=/run/studio-agent/relay-hosts:/etc/hosts
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
RestrictAddressFamilies=AF_INET AF_INET6
# pgbouncer logs through the native journal protocol (an AF_UNIX socket) when JOURNAL_STREAM is set, which would silently lose
# every log line here; unset it so it logs to stdout, which systemd already connected to the journal
UnsetEnvironment=JOURNAL_STREAM
IPAddressDeny=any
IPAddressAllow=127.0.0.1/32
InaccessiblePaths=-/opt/studio-agent -/etc/studio-agent -/etc/studio-pgrelay -/run/systemd/resolve -/run/dbus -/run/nscd -/run/tailscale -/run/avahi-daemon -/var/run/dbus

[Install]
WantedBy=multi-user.target
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

say "1. system users and directories"
for u in "$SVC:$APP_DIR" "$RELAY:/nonexistent"; do
  name=${u%%:*} home=${u##*:}
  if ! id "$name" >/dev/null 2>&1; then
    run useradd --system --home-dir "$home" --no-create-home --shell /usr/sbin/nologin "$name"
  else
    echo "user $name exists"
  fi
done
run install -d -o "$SVC" -g "$SVC" -m 0750 "$APP_DIR"
run install -d -o root -g root -m 0755 "$RELEASES"
run install -d -o root -g "$SVC" -m 0750 "$ETC_DIR"
run install -d -o root -g root -m 0700 "$RELAY_DIR"
run install -d -o root -g proxy -m 0750 "$PROXY_DIR"

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
PROXY_CHANGED=0 NFT_CHANGED=0 AGENT_UNIT_CHANGED=0 RELAY_CHANGED=0 UNITS_CHANGED=0
note_change() { # $1 = group (proxy|nft|agent|unit-only)
  [ "$WROTE" = 1 ] || return 0
  UNITS_CHANGED=1
  case $1 in proxy) PROXY_CHANGED=1 ;; nft) NFT_CHANGED=1 ;; agent) AGENT_UNIT_CHANGED=1 ;; relay) RELAY_CHANGED=1 ;; esac
}
# stock units from the packages would grab ports (squid 3128, pgbouncer 6432) and run with stock configs
for u in tinyproxy squid pgbouncer; do
  run_t systemctl disable --now "$u.service"
  run systemctl mask "$u.service"
done
run rm -f "$ETC_DIR/tinyproxy.conf" "$ETC_DIR/tinyproxy.allow"
# earlier releases put the Neon addresses on the agent unit as a persistent override: the agent unit is now static
run rm -rf /etc/systemd/system.control/studio-agent.service.d
if [ ! -s "$PROXY_CERT" ]; then
  if [ "$DRY" = 1 ]; then echo "+ openssl req -x509 ... > $PROXY_CERT (0640 root:proxy; throwaway splice-only certificate, never trusted, signs nothing)"
  else
    umask 077
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=studio-proxy-splice-only" \
      -keyout "$PROXY_CERT.key" -out "$PROXY_CERT.crt" 2>/dev/null
    cat "$PROXY_CERT.key" "$PROXY_CERT.crt" >"$PROXY_CERT"; rm -f "$PROXY_CERT.key" "$PROXY_CERT.crt"
    chown root:proxy "$PROXY_CERT"; chmod 0640 "$PROXY_CERT"
    umask 022
  fi
fi
write_file "$PROXY_CONF" 0640 root:proxy < <(render_proxy_conf); note_change proxy
write_file "$PROXY_HOSTS" 0640 root:proxy < <(render_proxy_hosts); note_change proxy
write_file "$UNIT_DIR/studio-proxy.service" 0644 root:root < <(render_proxy_unit); note_change proxy
write_file "$UNIT_DIR/$RELAY.service" 0644 root:root < <(render_relay_unit); note_change relay
# AWS credentials for the agent: credential_process -> the t4 broker (no GCP key, no STS, no googleapis on this host)
if [ "$DRY" = 1 ]; then echo "+ install -m 0755 -o root -g root $HERE/studio-aws-creds.py $AWS_HELPER"
else install -m 0755 -o root -g root "$HERE/studio-aws-creds.py" "$AWS_HELPER"; fi
write_file "$AWS_CONFIG" 0640 "root:$SVC" < <(printf '[default]\nregion = ap-south-1\ncredential_process = %s\n' "$AWS_HELPER")
write_file "$UNIT_DIR/$SVC.service" 0644 root:root < <(render_agent_unit); note_change agent
write_file "$EGRESS_CONF" 0644 root:root < <(printf 'NEON_HOSTS="%s"\nBROKER_ADDR="%s"\n' "${NEON_HOSTS[*]}" "$BROKER"); note_change nft
for pair in "studio-agent-egress-refresh.sh:$REFRESH_BIN" "studio-agent-egress-guard.sh:$GUARD_BIN" "studio-pgrelay-render.sh:$RELAY_BIN"; do
  src=$HERE/${pair%%:*} dst=${pair##*:}
  WROTE=0; if ! cmp -s "$src" "$dst" 2>/dev/null; then WROTE=1; fi
  run install -m 0755 -o root -g root "$src" "$dst"
  case $dst in "$REFRESH_BIN") note_change nft ;; "$RELAY_BIN") note_change relay ;; esac
done
write_file "$UNIT_DIR/studio-agent-nft.service" 0644 root:root < <(cat <<EOT
[Unit]
Description=Studio agent egress rules (nftables + Neon pins + relay hosts)
After=network-online.target nftables.service
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$REFRESH_BIN
# boot-time retry until Neon resolves; the script then starts the relay and the agent
Restart=on-failure
RestartSec=15

[Install]
WantedBy=multi-user.target
EOT
); note_change nft
write_file "$UNIT_DIR/studio-agent-egress-refresh.service" 0644 root:root < <(cat <<EOT
[Unit]
Description=Re-resolve Neon and refresh studio-agent egress
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=oneshot
ExecStart=$REFRESH_BIN
Restart=on-failure
RestartSec=15
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

say "3a. migrate: no GCP key, no GCP/AWS-role/Vertex variable on this host; AWS credentials via the broker"
if [ -e "$OLD_KEY_FILE" ]; then run shred -u "$OLD_KEY_FILE"; else echo "no old GCP key file"; fi
if [ "$DRY" = 1 ]; then
  echo "+ remove ${RETIRED_VARS[*]} lines from $ENV_FILE if present; set BEDROCK_AUTH=default-chain; set STUDIO_BROKER_URL=http://$BROKER/creds"
elif [ -r "$ENV_FILE" ]; then
  tmp=$(mktemp "$ENV_FILE.XXXXXX")
  pat=$(IFS='|'; echo "${RETIRED_VARS[*]}")
  grep -Ev "^($pat)=" "$ENV_FILE" | sed -e 's#^BEDROCK_AUTH=.*#BEDROCK_AUTH=default-chain#' -e "s#^STUDIO_BROKER_URL=.*#STUDIO_BROKER_URL=http://$BROKER/creds#" >"$tmp" || true
  chmod 0600 "$tmp"; chown "root:$SVC" "$tmp"; mv -f "$tmp" "$ENV_FILE"
fi

say "3b. Neon relay credentials: $NEON_ENV (real Neon URLs, 0600, the only persistent copy) and $LOCAL_ENV (loopback passwords)"
if [ ! -e "$NEON_ENV" ]; then
  write_file "$NEON_ENV" 0600 root:root < <(cat <<'EOT'
# Real Neon connection URLs, filled by hand file-to-file: postgres://user:password@host/dbname?sslmode=require
# The host must be one of the --neon-host names. The agent never sees these; only the relay (pgbouncer) does.
GOV_NEON_URL=
STUDIO_NEON_URL=
EOT
)
else
  echo "$NEON_ENV exists, left untouched"
fi
if [ ! -e "$LOCAL_ENV" ]; then
  if [ "$DRY" = 1 ]; then echo "+ generate AGENT_GOV_PW / AGENT_STUDIO_PW with openssl rand -hex 24 into $LOCAL_ENV (0600 root)"
  else
    ( umask 077; printf 'AGENT_GOV_PW=%s\nAGENT_STUDIO_PW=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" >"$LOCAL_ENV" )
    chown root:root "$LOCAL_ENV"; chmod 0600 "$LOCAL_ENV"
  fi
fi
# point the agent at the relay: loopback, local passwords, no Neon host or credential in the agent's environment
if [ "$DRY" = 1 ]; then
  echo "+ set GOV_RO_DATABASE_URL / STUDIO_DATABASE_URL in $ENV_FILE to postgresql://agent_*:<local pw>@127.0.0.1:$RELAY_PORT/{gov,studio}?sslmode=disable"
elif [ -r "$ENV_FILE" ] && [ -r "$LOCAL_ENV" ]; then
  gpw=$(sed -n 's/^AGENT_GOV_PW=//p' "$LOCAL_ENV"); spw=$(sed -n 's/^AGENT_STUDIO_PW=//p' "$LOCAL_ENV")
  [ -n "$gpw" ] && [ -n "$spw" ] || die "$LOCAL_ENV is incomplete"
  tmp=$(mktemp "$ENV_FILE.XXXXXX")
  sed -e "s#^GOV_RO_DATABASE_URL=.*#GOV_RO_DATABASE_URL=postgresql://agent_gov:$gpw@127.0.0.1:$RELAY_PORT/gov?sslmode=disable#" \
      -e "s#^STUDIO_DATABASE_URL=.*#STUDIO_DATABASE_URL=postgresql://agent_studio:$spw@127.0.0.1:$RELAY_PORT/studio?sslmode=disable#" \
      "$ENV_FILE" >"$tmp"
  chmod 0600 "$tmp"; chown "root:$SVC" "$tmp"; mv -f "$tmp" "$ENV_FILE"
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

say "5. proxy, egress and relay layers (restarted only when their config changed)"
run_t systemctl reset-failed studio-proxy.service studio-agent-nft.service "$RELAY.service" "$SVC.service"
[ "$UNITS_CHANGED" = 0 ] || run systemctl daemon-reload
run systemctl enable studio-proxy.service studio-agent-nft.service studio-agent-egress-refresh.timer studio-agent-egress-guard.timer
if [ "$PROXY_CHANGED" = 1 ] || ! systemctl is-active --quiet studio-proxy.service 2>/dev/null; then
  run systemctl restart studio-proxy.service
else echo "studio-proxy unchanged and active; not restarted"; fi
if [ "$NFT_CHANGED" = 1 ] || ! systemctl is-active --quiet studio-agent-nft.service 2>/dev/null; then
  run systemctl restart studio-agent-nft.service
else echo "studio-agent-nft unchanged and active; not restarted"; fi
run systemctl start studio-agent-egress-refresh.timer studio-agent-egress-guard.timer

say "6. AWS credentials: t4 broker at $BROKER (token STUDIO_BROKER_TOKEN is copied from t4 by hand, file-to-file)"

say "7. activate (kill switch: STUDIO_LIVE_READS stays 0 until O1 proof passes)"
ready=1
if [ -r "$ENV_FILE" ]; then
  for v in "${REQUIRED_VARS[@]}"; do
    grep -Eq "^$v=.+" "$ENV_FILE" || { echo "env var $v is empty"; ready=0; }
  done
  echo "note: Vertex is off on this host by design (no VERTEX_* variable, no googleapis allowlist)"
else
  echo "env file not readable here (dry-run as non-root, or not created yet): treated as not ready"; ready=0
fi
if [ -r "$NEON_ENV" ]; then
  for v in GOV_NEON_URL STUDIO_NEON_URL; do
    grep -Eq "^$v=.+" "$NEON_ENV" || { echo "$NEON_ENV: $v is empty"; ready=0; }
  done
else
  echo "$NEON_ENV not readable here: treated as not ready"; ready=0
fi

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
  run rm -f "$STOP_FLAG"  # an operator stop is ended by an install
  # relay first: it renders its config from neon.env on (re)start / reload
  run systemctl enable "$RELAY.service"
  if [ "$RELAY_CHANGED" = 1 ] || ! systemctl is-active --quiet "$RELAY.service" 2>/dev/null; then
    run systemctl restart "$RELAY.service"
  else
    run systemctl reload "$RELAY.service"
  fi
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
  if command -v squid >/dev/null; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=dry-run" -keyout "$DRYDIR/dry.key" -out "$DRYDIR/dry.crt" 2>/dev/null
    cat "$DRYDIR/dry.key" "$DRYDIR/dry.crt" >"$DRYDIR/splice-only.pem"
    sed "s#$PROXY_DIR/#$DRYDIR/#g" "$DRYDIR/squid.conf" >"$DRYDIR/squid.check.conf"
    if squid -k parse -f "$DRYDIR/squid.check.conf" >"$DRYDIR/squid.check.out" 2>&1; then echo "squid config parsed ok"
    else cat "$DRYDIR/squid.check.out" >&2; die "squid rejected the rendered config"; fi
  else
    echo "(squid not installed here; config check skipped)"
  fi
fi
say "done (post-session check: ops/asus/post-session-check.sh)"
