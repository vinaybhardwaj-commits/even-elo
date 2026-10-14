# ops/asus: Studio agent on the Asus (OPS-PLAN-M0S2.md O2, R2/R3/R4 rulings)

Needs **NOPASSWD sudo** on the Asus (the key is piped over ssh stdin, so there is no tty for a password).
Prereqs: `apt install tinyproxy nftables python3 curl bind9-dnsutils`, `uv`, Tailscale with Funnel enabled for the node (the installer preflights this).

- `install-studio-agent.sh`: idempotent install/upgrade. `--tarball PATH --sha256 HEX --neon-host H` (repeat `--neon-host` for every Neon host in the two database URLs).
  Tarball = `git archive <commit> studio/apps/agent` made by gov-orch, copied over ssh. No git credentials on the Asus.
  - Each release is built as root (`uv sync --frozen`) in `/opt/studio-agent/releases/<sha12>`; `current` is swapped atomically only after the build succeeds.
  - Health = `GET 127.0.0.1:8123/agent/health` answering `401 bad_service_token` for 30 s with the unit's restart counter unchanged.
    On failure `current` goes back to the old release, the failed release is deleted and `previous` still points at the release before it.
  - The proxy and nft units restart only when their rendered config changed; an unchanged install restarts nothing. `reset-failed` runs before restarts.
  - The agent is enabled and started only when the env file is complete and the key is present. `VERTEX_MODEL` is optional (warning if unset).
  - `--dry-run [--render-dir DIR]` makes the same decisions, prints actions, and runs `nft -c` and a tinyproxy config check.
- `--receive-gcp-key`: `ssh t4 'cat KEY.json' | ssh asus 'sudo ./install-studio-agent.sh --receive-gcp-key'`.
- `--rollback`: disable and stop the agent first, then funnel off (each step tolerant, safe to repeat). Env, key and egress rules stay.
- `--purge-secrets`: stop the agent, then shred `/etc/studio-agent/env` and the GCP key.
- `studio-agent-egress-refresh.sh` (run by `studio-agent-nft.service` and a 5-minute timer, serialised with flock): resolves the Neon host(s) at the
  upstream resolver (`resolvectl query --cache=no --synthesize=no`, else `dig @upstream`), then rebuilds the nftables table and the unit's
  `IPAddressAllow=` (127.0.0.1/32 + Neon pins), and writes `/run/studio-agent/neon-pins.json` (`{host: [ipv4..., ipv6...]}`, 0640 root:studio-agent).
  The agent restarts only when the pins changed. `/etc/hosts` is never edited (an old marked block from earlier releases is removed once).
  **The agent must connect with `hostaddr=` taken from the pins file: its uid has no DNS at all.**
- `studio-agent-egress-guard.timer` (15 s): stops the agent if the nft table or the proxy unit is gone.
- `post-session-check.sh`: canary grep (plain, .gz, .xz, .zst, journal) plus egress-refresh age and log level. Exit 0 clean, 1 hit/violation, 3 inconclusive.
- Tests: `test-asus-ops.sh` (offline, no root) and `test-asus-container.sh` (docker, privileged ubuntu:24.04 systemd container plus a Neon stub; `tailscale` is a stub).

Egress model: the agent uid has no DNS (no UDP/TCP 53, no AF_UNIX, resolved/dbus/nscd/tailscale sockets hidden) and reaches only 127.0.0.1:8888
(tinyproxy, default-deny, CONNECT :443 to exact hosts only) and the pinned Neon IPs on 5432; anything else is logged and dropped.
The agent unit Requires the nft unit, BindsTo the proxy unit, and refuses to start without the nft table.

## Residual risk (for fable F-O2)
CONNECT allowlisting cannot bind TLS SNI/Host: a tunnel to an allowed name can carry a different SNI to anything on the same CDN address, and the same holds for the
Neon IP carve-out (any tenant behind the same IPs). Exploiting it needs code execution inside the agent.
