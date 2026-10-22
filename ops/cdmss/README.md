# ops/cdmss: the CDMSS read layer (`studio_cdmss_ro`, schema `cdmss_ro`)

Run only as the database OWNER over the DIRECT (non-pooled) url of the CDMSS Neon database, never from CI or a build.
No password is ever handled over SQL: roles are created by SQL (NOLOGIN); **Neon issues the password through its API**.

| File | Purpose |
|---|---|
| `0000_cdmss_ro_precheck.sql` | read-only: every base column the views read must exist live (lists all missing, applies nothing) |
| `0001_cdmss_ro_role.sql`, `0002_cdmss_ro_views.sql`, `0003_cdmss_ro_postcheck.sql` | role, 16 column-scoped views, post-check (exact ACLs, column allowlist, privilege fence) |
| `run-cdmss-ro.sh` | applies 0000 to 0003 (`--precheck`, `--check`, `--dry-run`); already applied live |
| `run-login-mini.sh` | the LOGIN step, run on the Mac Mini (this runbook) |

## LOGIN runbook (Mac Mini, macOS)

Prerequisites on the Mini: `brew install coreutils jq` (the Neon scripts use GNU `stat -c`; the wrapper puts
`/opt/homebrew/opt/coreutils/libexec/gnubin` first in PATH and refuses if GNU `stat` is still missing), `python3`, `curl`, `git`, `hdiutil`/`diskutil`;
the checkout `~/oc/gov-orch/wt-banner` (the wrapper does `git fetch` + `checkout --detach origin/main`, so the LOGIN changes must be merged);
`~/Library/Application Support/com.vercel.cli/auth.json` (Vercel CLI login); `~/oc/gov-orch/secrets/neon-api-key` (mode 600).

```bash
ops/cdmss/run-login-mini.sh          # 1. issue the password, enable LOGIN
# ... the relay lane moves /Volumes/cdmssloginram/relay-url to the Asus ...
ops/cdmss/run-login-mini.sh --detach # 2. wipe it (rm -P) and detach the RAM disk
```

What step 1 does, in order (detail goes to `~/oc/gov-orch/scratch/cdmss-login.log`, filtered of urls and "password"; the terminal gets status lines only):
1. `umask 077`; creates a RAM disk (`hdiutil attach -nomount ram://65536`, `diskutil erasevolume HFS+ cdmssloginram`), mounted at `/Volumes/cdmssloginram`; refuses to start if that mount already exists.
2. Pulls `DATABASE_URL_UNPOOLED` and `NEON_PROJECT_ID` of Vercel project `even-cdmss` (production) through the Vercel API with the CLI token, in python, straight into `owner-url` and `project.env` (mode 600) on the RAM disk. Nothing goes through argv or stdout.
3. Refuses a **pooled** owner url (host containing `-pooler`, or `pgbouncer=true`) with exit 3, before anything runs: the post-check needs the database owner on a direct connection.
4. `neon-role.sh reset-password KEY @project.env auto studio_cdmss_ro relay-url --dsn-from owner-url --host auto`: Neon generates the password; the branch is the project's default branch; the url's host is the branch's read_write endpoint from the API (`LOGIN_MINI_RELAY_HOST=pooled|owner` changes that; the host for the Asus is a relay-lane decision). Exit 4 means the API cannot see the SQL-created role: nothing changed, stop and tell gov-orch.
5. `run-roles.sh --role studio_cdmss_ro --login owner-url`: LOGIN plus the cdmss post-check in ONE transaction. A neon_superuser membership or a broken privilege fence refuses LOGIN and the role is set NOLOGIN again.
6. Wipes `owner-url` and `project.env` (`/bin/rm -P`) on every exit path including HUP/INT/TERM. On failure it also wipes `relay-url` and detaches the RAM disk.

**The relay URL.** `/Volumes/cdmssloginram/relay-url` (mode 600) is the only copy of the password-bearing url. On success it, and only it, stays on the still-attached RAM disk; the wrapper prints just its path and status. It is moved to the Asus by the later relay lane, which then runs `run-login-mini.sh --detach`. Do not copy it anywhere else, and do not leave the disk attached overnight. If the password is lost, run the whole thing again: `run-roles.sh --role studio_cdmss_ro --nologin` first (rotation), then step 1.

Rotation: `STUDIO_ROLES_SHM=<ramdisk> ops/neon/run-roles.sh --role studio_cdmss_ro --nologin OWNER_URL_FILE`, then `run-login-mini.sh`.

## Test-only overrides
`LOGIN_MINI_*` paths/commands, `VERCEL_API_BASE` and `CDMSS_POSTCHECK_SQL` exist only for the Linux tests with stubs. The wrapper refuses to start if any is set without `LOGIN_MINI_TEST=1`, and `run-roles.sh` refuses `CDMSS_POSTCHECK_SQL` without `CDMSS_ALLOW_TEST_POSTCHECK=1`.
