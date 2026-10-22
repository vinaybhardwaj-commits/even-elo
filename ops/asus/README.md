# ops/asus: Studio agent on the Asus (OPS-PLAN-M0S2.md O2, R2-R6 rulings)

Needs **NOPASSWD sudo** on the Asus (secrets are piped over ssh stdin, so there is no tty for a password).
Prereqs: `apt install squid-openssl pgbouncer nftables python3 curl openssl bind9-dnsutils`, `uv`, Tailscale with Funnel enabled for the node (the installer preflights this).
The stock `squid` and `pgbouncer` units are disabled and masked by the installer; the studio units use their own configs.

## Design (every connection the agent can make goes to a destination we name)
```
studio-agent (uid studio-agent) --127.0.0.1:8888--> studio-prefilter (ClientHello filter, uid studio-prefilter) --127.0.0.1:8889--> studio-proxy (squid, uid proxy)
                                                                                                                  --blind TLS tunnel--> bedrock-runtime.ap-south-1, api.typesafe.ai
                                --127.0.0.1:6432--> studio-pgrelay (pgbouncer, uid studio-pgrelay) --TLS verify-full--> the pinned Neon endpoint
                                --tailnet IP:port--> credential broker on t4 (ops/t4-broker) --> short-lived, Bedrock-only AWS credentials
```
- **ClientHello pre-filter (`studio-ech-prefilter.py`, R3-3.1).** Squid 6 cannot match ClientHello extensions, so a ~250-line stdlib-only Python filter sits on `:8888` (the only port the
  agent uid can reach; nft gives it no route to Squid on `:8889`). Each connection must start with `CONNECT host:port HTTP/1.x`; that is forwarded to Squid, and once Squid says `200` the
  client's first TLS record(s) are read and parsed. The connection is **dropped** if the ClientHello carries extension `0xfe0d` (encrypted_client_hello) or the draft variants
  `0xfe02` / `0xff02`, or is malformed (lengths that do not add up, duplicate extension, trailing bytes, not a handshake record), larger than 16 KiB, or late (10 s). Everything else
  is relayed byte for byte, hello included. Fail closed: non-CONNECT first bytes, an unreadable hello or a dead Squid never become a tunnel. Own uid, loopback-only, no AF_UNIX,
  After the first hello it keeps framing the client's records and applies the same check to every later ClientHello-shaped handshake record (the second hello after a HelloRetryRequest, even pipelined); a tunnel idle in both directions for 300 s (`PREFILTER_IDLE_SECONDS`) is closed, and nft lets only the agent and relay uids reach `:8888`, so no other uid can hold its 64 slots. `BindsTo` Squid; the agent unit `BindsTo` the filter and the guard stops the agent if the filter is down. Journal lines: `prefilter drop reason=ech|malformed:<why>|hello-timeout|not-connect target=host:port [ext=0x..]`.
- **Web egress (squid, on 127.0.0.1:8889 behind the filter).** Exactly two names: `bedrock-runtime.ap-south-1.amazonaws.com` and `api.typesafe.ai` (`/etc/studio-proxy/hosts.txt`, one exact name per line).
  `CONNECT` to `:443` only; plain HTTP, other ports and **IP-literal targets (v4 and v6) are denied first** and with a plain TCP reset (no `200`, no handshake with the proxy's
  throwaway certificate). Matching never uses reverse DNS (`dstdomain -n`): a spoofed PTR cannot turn an IP into an allowlisted name. `ssl_bump peek` reads the TLS ClientHello and
  `splice`s (blind tunnel) only when the **server name (SNI)** is in the same list; otherwise the connection is terminated. A ClientHello **without SNI** is terminated too
  (Squid's own `ssl::server_name` falls back to the CONNECT host, so an external ACL fed the real client SNI, `sni-check.sh`, decides). There is no bump action: nothing is decrypted and no
  CA is trusted anywhere. Squid insists on a certificate when `ssl-bump` is on, so the installer generates a throwaway `splice-only.pem` (0640 root:proxy) that signs nothing.
  No disk cache; the access log (journal, tag `squid`) carries only status, method, host:port, SNI, bytes and the bump decision:
  `TCP_TUNNEL/200 CONNECT api.typesafe.ai:443 sni=api.typesafe.ai in=<client->server> out=<server->client> bump=splice` for a tunnel (bytes counted at close), and
  `NONE_NONE/200 CONNECT ... sni=example.com|- in=.. out=0 bump=terminate` for every SNI-mismatch / no-SNI termination. `post-session-check.sh` tallies both per session.
- **No Google on this host.** There is no `*.googleapis.com` (or STS) name on the allowlist: Google front ends route on the HTTP `Host` header whatever the SNI says, so an
  SNI allowlist cannot contain them. The GCP key and the GCP -> AWS federation live on t4 (`ops/t4-broker/README.md`). The agent gets AWS credentials through botocore's
  `credential_process` (`/usr/local/bin/studio-aws-creds`, configured in `/etc/studio-agent/aws-config`) from the broker over the tailnet: credentials with a session policy that
  allows `bedrock:InvokeModel*` on the two pinned model ids only. `BEDROCK_AUTH=default-chain`. **Vertex is off on this host** (`VERTEX_*` is not set; the fallback is disabled).
- **Neon relay (pgbouncer).** The agent's database URLs point at `127.0.0.1:6432` with local passwords (`/etc/studio-pgrelay/local.env`); the agent holds no Neon host, address
  or credential. The relay connects to Neon with `server_tls_sslmode = verify-full` against the system CA; pgbouncer sends the Neon hostname as SNI, which pins the endpoint;
  the password is sent plain (Neon rejects the `endpoint=<id>$<password>` form when SNI is present, verified 15 Oct). The real Neon URLs live only in `/etc/studio-pgrelay/neon.env` (0600 root);
  the relay's config is rendered from it into `/run/studio-pgrelay` (tmpfs, 0600) at start/reload. The relay has no DNS: its unit bind-mounts a private hosts file with the pinned
  IPv4/IPv6 addresses over `/etc/hosts`. Pool mode is `session`; the admin console is closed.
- **nftables.** uid `studio-agent` may reach only `127.0.0.1:8888`, `127.0.0.1:6432` and the broker's `IP:port`; only uid `studio-pgrelay` may reach the pinned Neon IPs, on `:5432`.
  Everything else from those two uids is logged and dropped. `IPAddressDeny=any` on both units is an independent second layer (agent: `127.0.0.1/32` + the broker; relay: `127.0.0.1/32` + the pins).
- **Pins.** `studio-agent-egress-refresh.sh` (run by `studio-agent-nft.service` and a 5-minute timer, serialised with flock) resolves the `--neon-host` names at the upstream
  resolver (`resolvectl query --cache=no --synthesize=no`, else `dig @upstream`), rewrites the nft table and the relay's `IPAddressAllow=`, replaces the relay's hosts file
  (temp file + rename) and writes `/run/studio-agent/neon-pins.json`. A bind mount follows the inode, so when the pins changed the **relay is restarted** to pick the new
  file up (the agent only `Wants` the relay and is not restarted). `/etc/hosts` is never edited. At boot it retries every 15 s until Neon resolves, then starts the relay and the agent.
- **Guard.** `studio-agent-egress-guard.timer` (15 s) stops the agent if the nft table or the proxy is gone; the agent unit Requires the nft unit, BindsTo the proxy,
  and refuses to start without the nft table.

## Incident stop
- `--stop`: stops the agent and the relay and drops `/run/studio-agent/operator-stop`; the egress refresh will **not** bring them back while that flag exists. An install clears it
  (and so does a reboot, which also restarts enabled units).
- `--rollback`: stops **and disables** the agent and the relay (pool dropped), funnel off. Safe to repeat. A plain `systemctl stop` is *not* an incident stop: the next refresh
  tick restarts an enabled unit.
- `--purge-secrets`: as `--rollback`, then shreds env, `aws-config`, `neon.env`, `local.env`. The relay stays disabled and is not retried.

## Files and commands
- `install-studio-agent.sh`: idempotent install/upgrade. `--tarball PATH --sha256 HEX --neon-host H [--neon-host H2 ...] --broker TAILNET_IP:PORT`.
  Tarball = `git archive <commit> studio/apps/agent` made by gov-orch, copied over ssh. No git credentials on the Asus.
  - Fill `/etc/studio-pgrelay/neon.env` (`GOV_NEON_URL`, `STUDIO_NEON_URL`: `postgres://user:password@host/db?sslmode=require`) and the other empty values in
    `/etc/studio-agent/env` by hand, file-to-file. The installer writes the agent's two database URLs and `STUDIO_BROKER_URL` itself.
  - `--receive-broker-token`: `ssh t4 'sudo sed -n s/^BROKER_TOKEN=//p /etc/studio-broker/env' | ssh asus 'sudo ./install-studio-agent.sh --receive-broker-token'`
    (stdin only; never in argv).
  - **Migration from R5**: the installer shreds `/etc/studio-agent/gcp-sa.json` and removes `GCP_*`, `GOOGLE_*`, `AWS_ROLE_ARN`, `VERTEX_*` from the env file.
  - Each release is built as root (`uv sync --frozen`) in `/opt/studio-agent/releases/<sha12>`; `current` is swapped atomically only after the build succeeds.
  - Health = `GET 127.0.0.1:8123/agent/health` answering `401 bad_service_token` for 30 s with the unit's restart counter unchanged. On failure `current` goes back to the old
    release, the failed release is deleted and `previous` still points at the release before it.
  - Units restart only when their rendered config changed; an unchanged install restarts nothing. `reset-failed` runs before restarts.
  - The agent and relay are enabled and started only when the env, `neon.env` and the broker token are complete.
  - `--dry-run [--render-dir DIR]` makes the same decisions, prints actions, and runs `nft -c` and `squid -k parse`.
- `post-session-check.sh` also prints (informational) `egress terminations` (no-SNI / SNI mismatch / denied CONNECT), `egress prefilter drops` and `egress tunnelled <name>:
  tunnels, bytes_in, bytes_out` for every allowed name, since the agent's last start (`STUDIO_SESSION_SINCE="YYYY-MM-DD HH:MM:SS"` overrides; an agent restart mid-session truncates the default window, and the output says so).
- `post-session-check.sh`: canary grep over /var, /tmp, /run and /opt/studio-agent (plain, .gz, .xz, .zst, file names; each path once) and the journal, plus egress-refresh age and
  log level. Exit 0 clean (`PURGED` label after `--purge-secrets`), 1 hit/violation, 3 inconclusive. Prints hashed paths only.
- Tests: `test-asus-ops.sh` (offline, no root; also runs the t4 broker's unit tests) and `test-asus-container.sh` (docker; privileged ubuntu:24.04 systemd container, two fake Neon
  endpoints (PostgreSQL + TLS), an IPv6-only one, a broker stub running the real broker code, `tailscale` stub).

## Limits worth knowing (residual risk, for fable)
- **ECH (R3-3).** Squid sees only the outer SNI, so a hand-built ECH ClientHello (allowed outer name, other inner name) would be spliced by Squid alone. The pre-filter above drops any
  ClientHello that carries `0xfe0d` / `0xfe02` / `0xff02`, tested with synthetic bytes in `test-asus-container.sh`. Not tested: a *working* ECH handshake against Cloudflare (we do not build an ECH
  client; the filter does not depend on whether Cloudflare would serve another zone). Residual: an ECH-like extension under some other codepoint, and exfiltration inside the allowed
  names themselves, which the per-session byte tally makes visible.
- **Domain fronting inside an allowed provider** depends on that provider's own blocking (Cloudflare refuses the Host/SNI mismatch for `api.typesafe.ai`; to be re-tested on
  `bedrock-runtime.ap-south-1` by the refuter). That is why no Google name is allowed.
- Neon login through the relay (plain password + SNI; verified by psql 15 Oct, recheck on `-pooler` hosts) and Bedrock's acceptance of the broker's session-policy ARNs are not testable offline;
  the container uses PostgreSQL stubs and a policy evaluator. Verify once on the O1 run / the live check.
- pgbouncer cannot bind a local user to one database, so the agent can open either database with either local password, by design (it holds both).
