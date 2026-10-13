# ops/asus: Studio agent on the Asus (OPS-PLAN-M0S2.md O2)

- `install-studio-agent.sh`: idempotent installer. Run `--dry-run` first. Requires `--tarball PATH --sha256 HEX` (from `git archive <commit> studio/apps/agent`, copied over ssh; no git credentials on the Asus), `--neon-host`, `--jev-host`.
  - `--receive-gcp-key`: reads the SA key from stdin: `ssh t4 'cat KEY' | ssh asus 'sudo ./install-studio-agent.sh --receive-gcp-key'`.
  - `--rollback`: funnel off, service disabled.
- `post-session-check.sh`: canary grep over /var, /tmp, /opt/studio-agent and the journal. Canary on stdin or `STUDIO_CANARY`; expects zero hits.
- `test-asus-ops.sh`: shellcheck, dry-run coverage, `systemd-analyze verify`. No root, changes nothing.

Prereqs on the Asus: `apt install tinyproxy nftables`, `uv`, Tailscale with Funnel enabled for the node.
The env file is created with empty secrets and `STUDIO_LIVE_READS=0`; the service only starts when it is filled and the key is present.
