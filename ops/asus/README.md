# ops/asus: Studio agent on the Asus (OPS-PLAN-M0S2.md O2, R2 rulings)

Needs **NOPASSWD sudo** on the Asus (the key is piped over ssh stdin, so there is no tty for a password).
Prereqs: `apt install tinyproxy nftables python3`, `uv`, Tailscale with Funnel enabled for the node (installer preflights this).

- `install-studio-agent.sh`: idempotent install/upgrade. `--tarball PATH --sha256 HEX --neon-host H` (repeat `--neon-host` for each Neon host).
  Tarball = `git archive <commit> studio/apps/agent` made by gov-orch, copied over ssh. No git credentials on the Asus.
  Each release is built as root (`uv sync --frozen`) in `/opt/studio-agent/releases/<sha12>`; `current` is swapped atomically only after the build
  succeeds and reverted if the new release does not start. The previous release is kept in `previous`.
  The agent is enabled and started only when the env file is complete and the key is present.
  `--dry-run [--render-dir DIR]` makes the same decisions, prints actions, and runs `nft -c` and a tinyproxy config check.
- `--receive-gcp-key`: `ssh t4 'cat KEY.json' | ssh asus 'sudo ./install-studio-agent.sh --receive-gcp-key'`.
- `--rollback`: disable and stop the agent first, then funnel off (each step tolerant, safe to repeat). Env, key and egress rules stay.
- `--purge-secrets`: stop the agent, then shred `/etc/studio-agent/env` and the GCP key. Run after rollback when decommissioning.
- `studio-agent-egress-refresh.sh`: installed to `/usr/local/sbin`; run by `studio-agent-nft.service` and a 5-minute timer. Rebuilds the nftables
  table, the Neon block in `/etc/hosts` and the unit's `IPAddressAllow=`.
- `post-session-check.sh`: canary grep (plain files, `.gz`, journal). Exit 0 clean, 1 hit, 3 inconclusive. Prints hashed paths only.
- Tests: `test-asus-ops.sh` (offline, no root) and `test-asus-container.sh` (docker, privileged ubuntu:24.04 systemd container; `tailscale` is a stub).

Egress model: the agent uid has no DNS and reaches only 127.0.0.1:8888 (tinyproxy, default-deny allowlist) and Neon:5432 by IP;
anything else is logged and dropped. The agent unit Requires the nft and proxy units and refuses to start without the nft table.
`IPAddressDeny=any` on the unit is an independent second layer.
