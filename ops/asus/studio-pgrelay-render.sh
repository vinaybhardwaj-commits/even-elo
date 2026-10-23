#!/usr/bin/env bash
# Render the Neon relay (pgbouncer) runtime files into /run/studio-pgrelay (tmpfs) from:
#   /etc/studio-pgrelay/neon.env    real Neon URLs (the ONLY persistent copy of the Neon credentials; 0600)
#   /etc/studio-pgrelay/local.env   loopback passwords the agent uses toward the relay
#   /run/studio-agent/neon-pins.json  pinned Neon addresses (written by studio-agent-egress-refresh)
# Files: pgbouncer.ini + userlist.txt (0600 studio-pgrelay) in /run/studio-pgrelay, and /run/studio-agent/relay-hosts
# (the relay's private /etc/hosts, bind-mounted by its unit: pins only, no DNS; it must exist before the unit's
# namespace is set up, so the egress refresh creates it).
#   (no args)      full render of the ini + userlist; ExecStartPre=+ of studio-pgrelay.service and ExecReload
#   --hosts-only   replace just the hosts file (temp + rename; called by the egress refresh)
# Nothing secret is printed.
set -euo pipefail

RUN=/run/studio-pgrelay
HOSTS=/run/studio-agent/relay-hosts
PINS=/run/studio-agent/neon-pins.json
NEON_ENV=/etc/studio-pgrelay/neon.env
LOCAL_ENV=/etc/studio-pgrelay/local.env
SVC=studio-pgrelay
HOSTS_ONLY=0
[ "${1:-}" = "--hosts-only" ] && HOSTS_ONLY=1

[ "$HOSTS_ONLY" = 1 ] || [ -d "$RUN" ] || { echo "$RUN missing (start the unit, it creates it)" >&2; exit 1; }
[ -s "$PINS" ] || { echo "no pins file yet ($PINS); egress refresh has not succeeded" >&2; exit 1; }

NEON_ENV=$NEON_ENV LOCAL_ENV=$LOCAL_ENV PINS=$PINS RUN=$RUN HOSTS=$HOSTS HOSTS_ONLY=$HOSTS_ONLY SVC=$SVC python3 - <<'PY'
import json, os, pwd, sys
from urllib.parse import unquote, urlsplit

run, pins_path = os.environ["RUN"], os.environ["PINS"]
hosts_only = os.environ["HOSTS_ONLY"] == "1"
uid = pwd.getpwnam(os.environ["SVC"]).pw_uid

def write_atomic(path, text, mode, owner):
    # sibling temp + rename: a reader sees the old or the new file, never a torn one. (A bind mount follows the inode, so the
    # relay unit is restarted to pick up a replaced hosts file; see the egress refresh.)
    tmp = path + ".new"
    with open(tmp, "w") as f:
        f.write(text); f.flush(); os.fsync(f.fileno())
    os.chmod(tmp, mode); os.chown(tmp, owner, -1)
    os.rename(tmp, path)

pins = json.load(open(pins_path))
if hosts_only:
    lines = ["127.0.0.1 localhost"]
    for host, addrs in sorted(pins.items()):
        for a in addrs:
            lines.append(f"{a} {host}")
    os.makedirs(os.path.dirname(os.environ["HOSTS"]), exist_ok=True)
    write_atomic(os.environ["HOSTS"], "\n".join(lines) + "\n", 0o644, 0)
    sys.exit(0)

def kv(path):
    out = {}
    for line in open(path):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out

neon, local = kv(os.environ["NEON_ENV"]), kv(os.environ["LOCAL_ENV"])

def q(v):  # libpq-style quoted value
    return "'" + v.replace("\\", "\\\\").replace("'", "\\'") + "'"

dbs, users = [], []
# gov and studio are required; cdmss (the read-only CDMSS role, ops/cdmss/relay-install.sh) is optional: absent from neon.env = no alias,
# and a CDMSS host that is not pinned (neon-hosts.extra) drops only that alias with a warning, never gov or studio.
for alias, key, user_key in (("gov", "GOV_NEON_URL", "AGENT_GOV_PW"), ("studio", "STUDIO_NEON_URL", "AGENT_STUDIO_PW"),
                             ("cdmss", "CDMSS_NEON_URL", "AGENT_CDMSS_PW")):
    url = neon.get(key, "")
    if not url and alias == "cdmss":
        continue
    if not url:
        sys.exit(f"{key} is empty in neon.env")
    u = urlsplit(url)
    host, port = u.hostname, u.port or 5432
    if not (host and u.username and u.password and u.path.strip("/")):
        sys.exit(f"{key} must be postgres://user:password@host[:port]/dbname")
    if host not in pins:
        if alias == "cdmss":
            print(f"warning: {key}: host {host} is not in the pins file (neon-hosts.extra); the cdmss alias is not rendered", file=sys.stderr)
            continue
        sys.exit(f"{key}: host {host} is not in the pins file (is it listed in --neon-host?)")
    endpoint = host.split(".")[0]
    if endpoint.endswith("-pooler"):
        endpoint = endpoint[: -len("-pooler")]
    # Plain password: pgbouncer sends SNI (the pinned hosts file keeps the real hostname), and Neon rejects the
    # endpoint=<id>$<pw> form when SNI is present (password authentication failed). Verified 15 Oct with psql:
    # prefixed+SNI fails, plain+SNI and prefixed+no-SNI both log in.
    password = unquote(u.password)
    # gov pool capped at 2: studio_gov_ro CONNECTION LIMIT is 20 (was 5, fable O1-C3) and the even-studio app on Vercel
    # reads live staff with the same role on every request; a full pool of 5 starved it (401 profile-unconfirmed, 21 Oct).
    pool = 2 if alias in ("gov", "cdmss") else 5
    # cdmss: read-only at the pool as well as at the role. connect_query runs on every NEW server connection (default_transaction_read_only on,
    # statement_timeout 30 s); the pool's server_reset_query (DISCARD ALL) undoes both after a client leaves, so the agent also sets them per
    # connection (studio_db.connect_cdmss_read_only) and the role's own grants (views only) are the fence that does not reset.
    extra = " connect_query='SET default_transaction_read_only = on; SET statement_timeout = 30000'" if alias == "cdmss" else ""
    lp = local.get(user_key, "")
    if not lp and alias == "cdmss":
        print("warning: AGENT_CDMSS_PW is empty in local.env; the cdmss alias is not rendered", file=sys.stderr)
        continue
    dbs.append(f"{alias} = host={host} port={port} dbname={unquote(u.path.strip('/'))} "
               f"user={unquote(u.username)} password={q(password)} pool_size={pool}{extra}")
    if not lp:
        sys.exit(f"{user_key} is empty in local.env")
    users.append(f'"agent_{alias}" "{lp}"')

ini = "\n".join(["[databases]"] + dbs + ["", "[pgbouncer]"] + [
    "listen_addr = 127.0.0.1",
    "listen_port = 6432",
    "unix_socket_dir =",
    "auth_type = scram-sha-256",
    f"auth_file = {run}/userlist.txt",
    "admin_users =",
    "stats_users =",
    "pool_mode = session",
    "max_client_conn = 50",
    "default_pool_size = 5",
    "max_db_connections = 8",
    "server_login_retry = 5",
    "ignore_startup_parameters = extra_float_digits",
    "client_tls_sslmode = disable",
    "server_tls_sslmode = verify-full",
    "server_tls_ca_file = /etc/ssl/certs/ca-certificates.crt",
    "server_tls_protocols = secure",
    "log_connections = 0",
    "log_disconnections = 0",
    "log_stats = 0",
]) + "\n"
write_atomic(os.path.join(run, "pgbouncer.ini"), ini, 0o600, uid)
write_atomic(os.path.join(run, "userlist.txt"), "\n".join(users) + "\n", 0o600, uid)
PY
if [ "$HOSTS_ONLY" = 1 ]; then echo "relay hosts file replaced"; else echo "relay files rendered"; fi
