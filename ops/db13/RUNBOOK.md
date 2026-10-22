# DB13 read access for Governance Studio — runbook

Basis: fable ruling G-D1..G-D5 (22 Oct 2026). Facts below marked UNVERIFIED have not been checked against DB13.

## Who owns what
| Item | Owner | Evidence required |
|---|---|---|
| Role `gov_studio_ro`, schema `gov_studio`, the 8 views | **Even IT (Shubh)** | Written confirmation (email or Slack link) pasted into the gate file that the role and views are theirs to own. Without it nothing below starts. |
| ada account + `authorized_keys` line | Even IT | Same confirmation. |
| Password for the role | Even IT sets it; gov-orch stores it only with the relay user | never in a repo, ticket or chat |
| Asus relay key, tunnel unit, nftables rule | separate ops lane (not this pack) | Opus refute in container sandbox first |
| Extract job | gov-orch | Opus refute before it touches DB13 |

We never hold DB13 admin, never get writes, never get another database.

## Order (G-D5)
1. Even IT runs `0001_gov_studio_ro.sql` as the DB admin (one transaction; it rolls back by itself if the post-check finds a leak). Then runs the two query blocks at the bottom of the file and sends the output. Rows in 8a = other databases where PUBLIC still has CONNECT: Even IT revokes them or states in writing why not.
2. Even IT sets the password: `\password gov_studio_ro` in psql (client-side SCRAM), or Cloud SQL IAM auth if the host is Cloud SQL (UNVERIFIED). If the role was created via gcloud: `REVOKE cloudsqlsuperuser FROM gov_studio_ro;`.
3. Even IT adds the ada key line (below). Fable GO already given; Asus change next.
4. First connection: run `VERIFY.sql` only. Follow its STOP RULE.
5. Only then the extract job.

## ada authorized_keys line (no shell)
```
restrict,port-forwarding,permitopen="<PG_HOST>:<PG_PORT>" ssh-ed25519 <ASUS RELAY-USER PUBLIC KEY> gov-studio-relay
```
`restrict` turns off pty, agent/X11 forwarding and commands; `port-forwarding` re-enables only forwarding; `permitopen` pins the one target (PG on 5433). Give the account a no-login shell (`/usr/sbin/nologin`) as well. Tunnel from the Asus: `ssh -N -L 127.0.0.1:<LOCAL_PORT>:<PG_HOST>:<PG_PORT> <user>@ada`.

## Kill switch
Even IT deletes that one line from ada's `authorized_keys`. The tunnel dies and cannot be reopened; no one on our side needs to cooperate. Secondary: `ALTER ROLE gov_studio_ro NOLOGIN;`. Full removal: `DROP OWNED BY gov_studio_ro; DROP ROLE gov_studio_ro;` then `DROP SCHEMA gov_studio CASCADE;`.

## Rotate the password
Even IT: `\password gov_studio_ro`, hand the new secret to the relay user's credential store out of band, restart the tunnel/extract unit. Rotate on any staff change on either side or after any VERIFY failure. Do not rotate by pasting plaintext into SQL.

## Asus side (summary only; built later by another lane)
- One new egress exception: outbound TCP/22 to ada's exact IP(s), allowed only for the relay uid. The agent user is refused; the ops refute must show a refused connect as the agent user.
- Key generated on the Asus for the relay user, 0600, never leaves. Tunnel = systemd unit as the relay user. Per-session bytes logged in the post-session check.

## Load rules (live production primary)
One tunnel and one connection per job; at most 2 queries/second; 60 s statement timeout (also set on the role); batch by key. Unindexed large scans (all of `individuals-prescriptions`, 4.4 GB) off-peak by default (22:00–07:00 IST), but an operator may run on demand at the same caps. Key `individuals-prescriptions` by `_parent_id` or `uploaded_at`; `kx_*` are indexed on `_id` only. Record per run: start, end, rows per view, DB13 snapshot time. Screens/chat never query DB13 live.

## If VERIFY fails
Stop at the first deviation. Close the connection; do not retry or "just check one more thing". Send Even IT and gov-orch the exact statement and output. If a write succeeded or any public table was readable: Even IT pulls the ada key line first. Fix is Even IT re-running `0001` (idempotent) and re-granting nothing by hand; then repeat VERIFY from the top with a fresh connection.
