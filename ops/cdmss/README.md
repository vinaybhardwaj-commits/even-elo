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
4. `neon-role.sh reset-password KEY @project.env auto studio_cdmss_ro relay-url --dsn-from owner-url --host auto`: Neon generates the password; the branch is the project's default branch; the url's host is the branch's read_write endpoint from the API. That is fixed in the Mini wrapper (there is no environment knob); a pooled or owner-url host for the Asus is a relay-lane change to the wrapper, not an override. The log gets python's and the scripts' output through one filter that drops url, "password", bearer and token lines. Exit 4 means the API cannot see the SQL-created role: nothing changed, stop and tell gov-orch.
5. `run-roles.sh --role studio_cdmss_ro --login owner-url`: LOGIN plus the cdmss post-check in ONE transaction. A neon_superuser membership or a broken privilege fence refuses LOGIN and the role is set NOLOGIN again.
6. Wipes `owner-url` and `project.env` (`/bin/rm -P`) on every exit path including HUP/INT/TERM. On failure it also wipes `relay-url` and detaches the RAM disk.

**The relay URL.** `/Volumes/cdmssloginram/relay-url` (mode 600) is the only copy of the password-bearing url. On success it, and only it, stays on the still-attached RAM disk; the wrapper prints just its path and status. It is moved to the Asus by the later relay lane, which then runs `run-login-mini.sh --detach`. Do not copy it anywhere else, and do not leave the disk attached overnight. If the password is lost, run the whole thing again: `run-roles.sh --role studio_cdmss_ro --nologin` first (rotation), then step 1.

Rotation (password lost, or to rotate): `ops/cdmss/run-login-mini.sh --nologin`, then `ops/cdmss/run-login-mini.sh`. `--nologin` does what steps 1-3 do (fresh RAM disk, owner url pulled from Vercel straight onto it, pooled url refused), runs `run-roles.sh --role studio_cdmss_ro --nologin` on that file (the role is set NOLOGIN in its own committed statement and its live sessions are ended; exit 5 means some sessions could not be ended and must be ended by hand before trusting the rotation), then wipes and detaches. You never place `OWNER_URL_FILE` yourself: it exists only inside the script, on the RAM disk. Do not run `run-roles.sh` by hand against a url file on the ordinary disk.
`rm -P` may not really overwrite on recent macOS/APFS-era systems; detaching the RAM disk is the real wipe, which is why the wrapper detaches on every path.

## Test-only overrides
These exist only for the Linux tests with stubs. With `LOGIN_MINI_TEST=1` the allowlisted re-exec carries them (and the caller's `PATH`), nothing else. In any other run the allowlist drops them and the second layer then refuses to start (exit 2) because it saw them set:
`LOGIN_MINI_REPO LOGIN_MINI_SKIP_GIT LOGIN_MINI_MOUNT LOGIN_MINI_SECURE_RM LOGIN_MINI_AUTH_JSON LOGIN_MINI_NEON_KEY LOGIN_MINI_LOG LOGIN_MINI_RELAY_HOST LOGIN_MINI_NOT_MAC VERCEL_API_BASE NEON_API_BASE SQL_FILE PSQL CDMSS_POSTCHECK_SQL CDMSS_ALLOW_TEST_POSTCHECK STUDIO_ROLES_SHM XDG_RUNTIME_DIR BASH_ENV ENV`,
the shell-control variables `SHELLOPTS BASHOPTS PS4 BASH_XTRACEFD PROMPT_COMMAND` (also refused if they survive into the exported environment), and every variable that redirects a host, file or binary under the tools it runs: `PG*` (libpq), `CURL_*` and `*_proxy`/`*_PROXY`, `PYTHON*`, `GIT_*`, `LD_*`, `DYLD_*`. `HOME` and `PATH` are not refused.
The second layer (after the re-exec) fails closed: it enumerates names with `compgen -e` and validates each, and any scan error, odd variable name, exported bash function (`BASH_FUNC_*`) or newline inside an environment value exits 2 before anything else runs. git fetch/checkout output reaches the log only through the same filter as everything else.
Separately, `ops/neon/run-roles.sh` refuses `CDMSS_POSTCHECK_SQL` unless `CDMSS_ALLOW_TEST_POSTCHECK=1`.
