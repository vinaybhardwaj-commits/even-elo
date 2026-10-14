# ops/asus: Studio agent on the Asus (OPS-PLAN-M0S2.md O2, R2-R5 rulings)

Needs **NOPASSWD sudo** on the Asus (the key is piped over ssh stdin, so there is no tty for a password).
Prereqs: `apt install squid-openssl pgbouncer nftables python3 curl openssl bind9-dnsutils`, `uv`, Tailscale with Funnel enabled for the node (the installer preflights this).
The stock `squid` and `pgbouncer` units are disabled and masked by the installer; the studio units use their own configs.

## Design (every connection the agent can make goes to a destination we name)
```
studio-agent (uid studio-agent) --127.0.0.1:8888--> studio-proxy (squid, uid proxy)  --TLS tunnel--> allowlisted hosts only
                                --127.0.0.1:6432--> studio-pgrelay (pgbouncer, uid studio-pgrelay) --TLS verify-full--> the pinned Neon endpoint
```
- **Web egress (squid).** `CONNECT` to `:443` only; everything else (plain HTTP, other ports, IP literals) is denied. `ssl_bump peek` reads the TLS ClientHello and
  `splice`s (blind tunnel) only when the **server name (SNI)** matches the exact-host allowlist (`/etc/studio-proxy/hosts.regex`); otherwise the connection is terminated.
  There is no bump action: nothing is decrypted and no CA is trusted anywhere. Squid insists on a certificate when `ssl-bump` is on, so the installer generates a throwaway
  `splice-only.pem` (0640 root:proxy) that signs nothing. No disk cache; the access log (journal, tag `squid`) carries only status, method, host:port and SNI.
- **Neon relay (pgbouncer).** The agent's database URLs point at `127.0.0.1:6432` with local passwords (`/etc/studio-pgrelay/local.env`); the agent holds no Neon host, address
  or credential. The relay connects to Neon with `server_tls_sslmode = verify-full` against the system CA; pgbouncer sends the Neon hostname as SNI and the password is sent in
  the Neon `endpoint=<endpoint-id>$<password>` form, so the endpoint is pinned both ways. The real Neon URLs live only in `/etc/studio-pgrelay/neon.env` (0600 root);
  the relay's config is rendered from it into `/run/studio-pgrelay` (tmpfs, 0600) at start/reload. The relay has no DNS: its unit bind-mounts a private hosts file with the pinned
  addresses over `/etc/hosts`. Pool mode is `session`; the admin console is closed.
- **nftables.** uid `studio-agent` may reach only `127.0.0.1:8888` and `127.0.0.1:6432`; only uid `studio-pgrelay` may reach the pinned Neon IPs, on `:5432`. Everything else from
  those two uids is logged and dropped. `IPAddressDeny=any` on both units is an independent second layer (agent: `127.0.0.1/32`; relay: `127.0.0.1/32` + the pins).
- **Pins.** `studio-agent-egress-refresh.sh` (run by `studio-agent-nft.service` and a 5-minute timer, serialised with flock) resolves the `--neon-host` names at the upstream
  resolver (`resolvectl query --cache=no --synthesize=no`, else `dig @upstream`), rewrites the nft table, the relay's `IPAddressAllow=` and hosts file, and writes
  `/run/studio-agent/neon-pins.json`; the relay is reloaded only when the pins changed. At boot it retries every 15 s until Neon resolves, then starts the relay and the agent.
  `/etc/hosts` is never edited.
- **Guard.** `studio-agent-egress-guard.timer` (15 s) stops the agent if the nft table or the proxy is gone; the agent unit Requires the nft unit and the relay, BindsTo the proxy,
  and refuses to start without the nft table.

## Files and commands
- `install-studio-agent.sh`: idempotent install/upgrade. `--tarball PATH --sha256 HEX --neon-host H` (repeat `--neon-host` for every Neon host in the two URLs).
  Tarball = `git archive <commit> studio/apps/agent` made by gov-orch, copied over ssh. No git credentials on the Asus.
  - Fill `/etc/studio-pgrelay/neon.env` (`GOV_NEON_URL`, `STUDIO_NEON_URL`: `postgres://user:password@host/db?sslmode=require`) and `/etc/studio-agent/env` by hand, file-to-file.
    The installer writes the agent's two database URLs itself.
  - Each release is built as root (`uv sync --frozen`) in `/opt/studio-agent/releases/<sha12>`; `current` is swapped atomically only after the build succeeds.
  - Health = `GET 127.0.0.1:8123/agent/health` answering `401 bad_service_token` for 30 s with the unit's restart counter unchanged. On failure `current` goes back to the old
    release, the failed release is deleted and `previous` still points at the release before it.
  - Units restart only when their rendered config changed; an unchanged install restarts nothing. `reset-failed` runs before restarts.
  - The agent and relay are enabled and started only when the env, the key and `neon.env` are complete. `VERTEX_MODEL` is optional (warning if unset).
  - `--dry-run [--render-dir DIR]` makes the same decisions, prints actions, and runs `nft -c` and `squid -k parse`.
- `--receive-gcp-key`: `ssh t4 'cat KEY.json' | ssh asus 'sudo ./install-studio-agent.sh --receive-gcp-key'`.
- `--rollback`: disable and stop the agent first, then funnel off (each step tolerant, safe to repeat). Env, key, relay and egress rules stay.
- `--purge-secrets`: stop the agent and the relay, funnel off, shred env, key, `neon.env` and `local.env`.
- `post-session-check.sh`: canary grep over /var, /tmp, /run and /opt/studio-agent (plain, .gz, .xz, .zst, file names) and the journal, plus egress-refresh age and log level.
  Exit 0 clean, 1 hit/violation, 3 inconclusive. Prints hashed paths only.
- Tests: `test-asus-ops.sh` (offline, no root) and `test-asus-container.sh` (docker; privileged ubuntu:24.04 systemd container, two fake Neon endpoints (PostgreSQL + TLS), `tailscale` stub).

## Limits worth knowing
- Destination names are enforced at the TLS server-name level (SNI). A client that sends an allowed SNI to an allowed address reaches that provider; domain fronting
  *within* an allowed provider depends on that provider's own blocking. The earlier residual risk (a tunnel to an allowed name carrying a different SNI, and the Neon IP
  carve-out admitting any tenant) is closed by design: a wrong SNI is terminated, and only the relay, which cannot be redirected, talks to Neon.
- Neon's acceptance of the `endpoint=<id>$<password>` password form (and of the pooled `-pooler` host with it) is not testable offline; the container uses PostgreSQL stubs that
  take the same form. Verify once on the O1 run.
- Local relay passwords are per database (`agent_gov`, `agent_studio`) but pgbouncer does not bind a user to a database, so the agent could use either to open either database by
  design (it holds both).
