# ops/cdmss: the CDMSS read layer (`studio_cdmss_ro`, schema `cdmss_ro`)

Run only as the database OWNER over the DIRECT (non-pooled) url of the CDMSS Neon database, never from CI or a build.
No real password is ever handled over SQL: roles are created by SQL (NOLOGIN); **Neon issues the password through its API**. The one exception is a *throwaway* placeholder seeded over SQL on stdin (`run-roles.sh --seed-password`), which Neon's reset replaces before the role can log in (reason: Neon cannot reset a role that has no password at all, HTTP 422 "cannot update password for role without password").

| File | Purpose |
|---|---|
| `0000_cdmss_ro_precheck.sql` | read-only: every base column the views read must exist live (lists all missing, applies nothing) |
| `0001_cdmss_ro_role.sql`, `0002_cdmss_ro_views.sql`, `0003_cdmss_ro_postcheck.sql` | role, 16 column-scoped views, post-check (exact ACLs, column allowlist, privilege fence) |
| `run-cdmss-ro.sh` | applies 0000 to 0003 (`--precheck`, `--check`, `--dry-run`); already applied live |
| `run-login-mini.sh` | the LOGIN step, run on the Mac Mini (this runbook) |
| `relay-install.sh`, `asus-relay-apply.sh` | the RELAY step: Mini mover + its Asus half (section "Relay to the Asus") |

## LOGIN runbook (Mac Mini, macOS)

Prerequisites on the Mini: `brew install coreutils jq` (the Neon scripts use GNU `stat -c`; the wrapper puts
`/opt/homebrew/opt/coreutils/libexec/gnubin` first in PATH and refuses if GNU `stat` is still missing), `python3`, `curl`, `git`, `hdiutil`/`diskutil`;
the checkout `~/oc/gov-orch/wt-banner` (the wrapper does `git fetch` + `checkout --detach origin/main`, so the LOGIN changes must be merged);
`~/Library/Application Support/com.vercel.cli/auth.json` (Vercel CLI login); `~/oc/gov-orch/secrets/neon-api-key` (mode 600).

```bash
# Always invoke it like this (a clean environment and a clean bash; MODE is empty, --detach or --nologin):
/usr/bin/env -i HOME=$HOME PATH=/usr/bin:/bin /bin/bash --noprofile --norc ops/cdmss/run-login-mini.sh        # 1. issue the password, enable LOGIN
# ... the relay lane moves /Volumes/cdmssloginram/relay-url to the Asus ...
/usr/bin/env -i HOME=$HOME PATH=/usr/bin:/bin /bin/bash --noprofile --norc ops/cdmss/run-login-mini.sh --detach # 2. wipe it (rm -P) and detach the RAM disk
/usr/bin/env -i HOME=$HOME PATH=/usr/bin:/bin /bin/bash --noprofile --norc ops/cdmss/run-login-mini.sh --nologin # rotation step 0 (see below)
```

**Why that invocation.** The script's shebang is `/bin/bash -p` and its first act is `exec /usr/bin/env -i` into a fresh `/bin/bash --noprofile --norc -p` carrying only an allowlist: `PATH` (fixed to the gnubin and Homebrew prefixes plus `/usr/bin:/bin:/usr/sbin:/sbin`), `HOME USER LOGNAME LANG TERM` and a re-exec marker. Every other variable is gone before any secret exists, so nothing like `SHELLOPTS`, `BASHOPTS`, `PS4`, `BASH_XTRACEFD`, `BASH_ENV`, `ENV`, `PG*`, `CURL_*`, proxies, `GIT_*`, `LD_*`/`DYLD_*` or an exported function can reach the owner url or the tools. The names it saw and dropped are then refused (second layer, below). The residual: whoever invokes the script controls the startup of the bash that runs its first lines, and `bash script` ignores the `-p` of the shebang (a `PS4='$(cmd)'` with `SHELLOPTS=xtrace` would run `cmd` before line one). The `/usr/bin/env -i ... /bin/bash --noprofile --norc` form removes that. The owner url is never read into a shell variable by the wrapper (python reads the file and returns an exit code).

What step 1 does, in order (detail goes to `~/oc/gov-orch/scratch/cdmss-login.log`, filtered of urls and "password"; the terminal gets status lines only):
1. `umask 077`; creates a RAM disk (`hdiutil attach -nomount ram://65536`, `diskutil erasevolume HFS+ cdmssloginram`), mounted at `/Volumes/cdmssloginram`; refuses to start if that mount already exists.
2. Pulls `DATABASE_URL_UNPOOLED` and `NEON_PROJECT_ID` of Vercel project `even-cdmss` (production) through the Vercel API with the CLI token, in python, straight into `owner-url` and `project.env` (mode 600) on the RAM disk. Nothing goes through argv or stdout.
3. Refuses a **pooled** owner url (host containing `-pooler`, or `pgbouncer=true`) with exit 3, before anything runs: the post-check needs the database owner on a direct connection.
4. **Order (the Neon 422 root cause: `reset_password` refuses a role that has no password, LOGIN or not).** (pre) `neon-role.sh role-auth ... studio_cdmss_ro` must say `no_login`; anything else means the role already has a password, which is ROTATION: the wrapper changes nothing and exits 6. (a) `run-roles.sh --role studio_cdmss_ro --seed-password owner-url`: a THROWAWAY password over SQL (48 random bytes born in python and sent to psql on stdin: never argv, environment, a file or our logs) while the role stays NOLOGIN; it may sit in the server's statement log, acceptable only because (b) replaces it before the role can ever log in. (b) `neon-role.sh reset-password KEY @project.env auto studio_cdmss_ro relay-url --dsn-from owner-url --host auto`: Neon generates the real password; the branch is the project's default branch; the url's host is the branch's read_write endpoint from the API (fixed in the wrapper, no environment knob). A non-2xx stops the run with its filtered message; there is no LOGIN-first fallback. (c) `run-roles.sh --role studio_cdmss_ro --login owner-url`: every membership/grant check incl. `neon_superuser` (the reset may add it), the cdmss post-check, then LOGIN last, in ONE transaction. Any failure from (a) on leaves the role NOLOGIN (a committed NOLOGIN and ended sessions if LOGIN had been enabled; exit codes of the failing step unchanged, 5 = sessions could not be ended), re-seeds a FRESH throwaway if (b) had not completed (the first one is dead; the new one is replaced by the next successful run), and leaves no `relay-url`. Exit 4 anywhere means the API cannot see the SQL-created role: nothing changed, stop and tell gov-orch.
5. The log gets python's and the scripts' output through one filter that drops url, "password", bearer and token lines. `neon-role.sh` logs the HTTP status and the API's error `message` of any non-2xx (the message itself passes the same filter), so a 422 is diagnosable from the log.
6. Wipes `owner-url` and `project.env` (`/bin/rm -P`) on every exit path including HUP/INT/TERM. On failure it also wipes `relay-url` and detaches the RAM disk.

**The relay URL.** `/Volumes/cdmssloginram/relay-url` (mode 600) is the only copy of the password-bearing url. On success it, and only it, stays on the still-attached RAM disk; the wrapper prints just its path and status. It is moved to the Asus by the later relay lane, which then runs `run-login-mini.sh --detach`. Do not copy it anywhere else, and do not leave the disk attached overnight. If the password is lost, run the whole thing again: `run-roles.sh --role studio_cdmss_ro --nologin` first (rotation), then step 1.

Rotation (password lost, or to rotate; the role is already LOGIN with a password, so the first-login order above refuses it with exit 6): `ops/cdmss/run-login-mini.sh --nologin`, then `ops/cdmss/run-login-mini.sh`. `--nologin` does what steps 1-3 do (fresh RAM disk, owner url pulled from Vercel straight onto it, pooled url refused), runs `run-roles.sh --role studio_cdmss_ro --nologin` on that file (the role is set NOLOGIN in its own committed statement and its live sessions are ended; exit 5 means some sessions could not be ended and must be ended by hand before trusting the rotation), then wipes and detaches. You never place `OWNER_URL_FILE` yourself: it exists only inside the script, on the RAM disk. Do not run `run-roles.sh` by hand against a url file on the ordinary disk.
UNVERIFIED (23 Oct): after `--nologin` the role keeps its (Neon-issued) password, so the API may report something other than `no_login`; then the first-login order refuses it (exit 6) and the rotation is a reset on the existing password followed by `run-roles.sh --login`, done by hand per `ops/neon/README.md` Rotation. If the API does report `no_login` the wrapper seeds a throwaway and resets as for a first login. Either way a non-2xx stops with the role NOLOGIN.
`rm -P` may not really overwrite on recent macOS/APFS-era systems; detaching the RAM disk is the real wipe, which is why the wrapper detaches on every path.

## Test-only overrides
These exist only for the Linux tests with stubs. With `LOGIN_MINI_TEST=1` the allowlisted re-exec carries them (and the caller's `PATH`), nothing else. In any other run the allowlist drops them and the second layer then refuses to start (exit 2) because it saw them set:
`LOGIN_MINI_REPO LOGIN_MINI_SKIP_GIT LOGIN_MINI_MOUNT LOGIN_MINI_SECURE_RM LOGIN_MINI_AUTH_JSON LOGIN_MINI_NEON_KEY LOGIN_MINI_LOG LOGIN_MINI_RELAY_HOST LOGIN_MINI_NOT_MAC VERCEL_API_BASE NEON_API_BASE SQL_FILE PSQL CDMSS_POSTCHECK_SQL CDMSS_ALLOW_TEST_POSTCHECK STUDIO_ROLES_SHM XDG_RUNTIME_DIR BASH_ENV ENV`,
the shell-control variables `SHELLOPTS BASHOPTS PS4 BASH_XTRACEFD PROMPT_COMMAND` (also refused if they survive into the exported environment), and every variable that redirects a host, file or binary under the tools it runs: `PG*` (libpq), `CURL_*` and `*_proxy`/`*_PROXY`, `PYTHON*`, `GIT_*`, `LD_*`, `DYLD_*`. `HOME` and `PATH` are not refused.
The second layer (after the re-exec) fails closed: it enumerates names with `compgen -e` and validates each, and any scan error, odd variable name, exported bash function (`BASH_FUNC_*`) or newline inside an environment value exits 2 before anything else runs. git fetch/checkout output reaches the log only through the same filter as everything else.
Separately, `ops/neon/run-roles.sh` refuses `CDMSS_POSTCHECK_SQL` unless `CDMSS_ALLOW_TEST_POSTCHECK=1`.

## Relay to the Asus (`relay-install.sh`, after `run-login-mini.sh`)

How the agent reaches Neon today: **Postgres does not pass Squid.** The agent only talks to the pgbouncer relay on `127.0.0.1:6432` (aliases `gov`, `studio`; local passwords); the relay (uid `studio-pgrelay`) is the only process that reaches Neon, on `:5432` to the pinned addresses of the `--neon-host` names (nft + `IPAddressAllow`), TLS `verify-full`. The Squid allowlist stays exactly `bedrock-runtime.ap-south-1.amazonaws.com` and `api.typesafe.ai`. CDMSS mirrors that: a third alias `cdmss`, the endpoint host pinned like a `--neon-host`, nothing else.

Prerequisite (a normal release step, not this mover): run `install-studio-agent.sh` from `gov/cdmss-relay` on the Asus once, so `/usr/local/sbin/studio-pgrelay-render` and `studio-agent-egress-refresh` know the cdmss alias and `/etc/studio-agent/neon-hosts.extra`. The mover refuses (rc 5, "predate CDMSS support", nothing changed) otherwise.

```bash
/usr/bin/env -i HOME=$HOME PATH=/usr/bin:/bin /bin/bash --noprofile --norc ops/cdmss/relay-install.sh             # move, install, verify, then run-login-mini.sh --detach
/usr/bin/env -i HOME=$HOME PATH=/usr/bin:/bin /bin/bash --noprofile --norc ops/cdmss/relay-install.sh --rollback  # undo on the Asus
```
The URL is streamed from `/Volumes/cdmssloginram/relay-url` as ssh stdin (never argv, never a variable or a file elsewhere). The Asus half is sent in the ssh command line and run as `sudo -n bash -c`. **What the install changes on the Asus** (all undone by `--rollback`, and restored to the previous bytes if anything fails):
1. `/etc/studio-pgrelay/neon.env` (0600 root:root): `+ CDMSS_NEON_URL=<url>` next to `GOV_NEON_URL`.
2. `/etc/studio-pgrelay/local.env` (0600 root:root): `+ AGENT_CDMSS_PW=<48 hex>`.
3. `/etc/studio-agent/env` (0600 root:studio-agent): `CDMSS_RO_DATABASE_URL=postgresql://agent_cdmss:<pw>@127.0.0.1:6432/cdmss?sslmode=disable`. Read at the agent's next start; the agent is NOT restarted and no tool uses it yet.
4. `/etc/studio-agent/neon-hosts.extra` (0644): the DSN's host (direct `read_write` endpoint, port 5432). The refresh pins it; nft lets the relay uid also reach its IPs on `:5432`.
5. Runs `studio-agent-egress-refresh` and restarts `studio-pgrelay` (gov and studio pools reconnect briefly).
Then, as `studio-agent` through the relay with the agent venv's psycopg: `current_user=studio_cdmss_ro`, `SELECT count(*)` on `cdmss_ro.ams_formulary`, a `DELETE` refused with the session read-only default switched off (the ROLE must refuse), `SELECT` on base table `public.formulary` refused. Only then `run-login-mini.sh --detach` wipes the Mini copy. The pool is read-only too: `connect_query` sets `default_transaction_read_only=on` and `statement_timeout=30000` per new server connection, and `studio_db.connect_cdmss_read_only()` sets them per agent connection (pgbouncer's `DISCARD ALL` undoes the pool-level ones when a client leaves); suggested follow-up on Neon (not done here): `ALTER ROLE studio_cdmss_ro SET default_transaction_read_only = on, statement_timeout = '30s'`.
