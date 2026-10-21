# ops/neon: the Studio database roles (`studio_gov_ro`, `studio_app`)

Run as the database OWNER (never a superuser on Neon) over the DIRECT (non-pooled) URL. Never from CI or a build.
**No password is ever handled by these scripts**: roles are created BY SQL with no password clause, and Neon itself issues the password through its API.

## Runbook (O1 order)
```bash
umask 077
# owner DIRECT url in a 0600 file (e.g. from `vercel env pull`), Neon API key in another 0600 file: both on tmpfs
ops/neon/neon-role.sh discover "$XDG_RUNTIME_DIR/neon-api-key"                  # project ids, branch ids, role names ONLY
P=proj-...; B=br-...

# 1. create the role NOLOGIN by SQL + grants (one transaction; membership preflight + post-check inside it)
ops/neon/run-roles.sh --dry-run                                                  # preview, connects to nothing
ops/neon/run-roles.sh "$XDG_RUNTIME_DIR/owner-url"                               # studio_gov_ro on the governance DB
#    (studio_app, on the STUDIO database: run-roles.sh --role studio_app STUDIO_OWNER_URL_FILE, then
#     `uv run python apply_migration.py --dsn-env ... --app-role studio_app` for its table grants)

# 2. Neon issues the password: curl -> jq -> a 0600 DSN file (never argv, env or stdout)
ops/neon/neon-role.sh reset-password "$XDG_RUNTIME_DIR/neon-api-key" "$P" "$B" studio_gov_ro \
    "$XDG_RUNTIME_DIR/gov-ro-url" --dsn-from "$XDG_RUNTIME_DIR/owner-url"
#    exit 4 "role not visible to Neon API" = the API cannot see SQL-created roles: nothing was changed, stop (see below)

# 3. enable LOGIN: memberships re-checked first (the API may add neon_superuser on reset), grants verified
ops/neon/run-roles.sh --login "$XDG_RUNTIME_DIR/owner-url"

# 4. install the views (section below), THEN probe once with the new DSN (STUDIO_EXPECT_VIEWS=1; without the views the probe skips 22 checks)
STUDIO_EXPECT_VIEWS=1 GOV_RO_DATABASE_URL="$(<"$XDG_RUNTIME_DIR/gov-ro-url")" uv run --directory studio/apps/agent pytest tests/test_lc1_live_probe.py -q
```
## Migration run order (gov/rel1)
Each file is run as the owner over the DIRECT url (`SQL_FILE=ops/neon/<file> ops/neon/run-roles.sh <owner-url-file>`), except where noted.
1. `0001_roles.sql`, `0002_studio_app_role.sql`: roles (steps 1 to 3 above). Applied.
2. `0003_login.sql`, `0004_nologin.sql`, `0005_terminate.sql`, `0006_sessions.sql`: helper SQL run by name by `run-roles.sh` (`--login`, `--nologin`, session termination and count); never run by hand.
3. `0003_studio_views.sql`: M1 views. APPLIED LIVE already. Two files share the number 0003; `--login` selects `0003_login.sql` by name, so there is no clash.
4. `studio/apps/agent/migrations/0001_studio.sql`: Studio state tables, applied with `apply_migration.py` (see the studio_app note above).
5. `0007_docaudits_views.sql`: NEW, owner must apply (section below). Needed by the Document audits screen. Not yet applied live; the file was edited in place for the ungate ruling (adds `finding_body`, `evidence_excerpt`, `response_comment`, `authored_by_name`, `pdf_url`).
6. `0008_ungate_views.sql`: NEW, owner must apply AFTER 0003 and 0007 (section below). Appends the free-text columns to five 0003 views. The Studio tools that read those columns fail until it is applied, so apply it before the matching deploy.

### Column-scoped views (M1): `0003_studio_views.sql`
Physician 360, OPD governance and Patient feedback read **views** in schema `studio_ro`, never the base tables behind them (`privileges`, `oppe_reviews`, `clinical_metrics_monthly`, `qualifications`, `gov_capture_gaps`, `incident_replies`). Run it as the owner over the DIRECT url, after step 1 (the role must exist), before the probe:
```bash
SQL_FILE=ops/neon/0003_studio_views.sql ops/neon/run-roles.sh "$XDG_RUNTIME_DIR/owner-url"    # one transaction, idempotent
STUDIO_EXPECT_VIEWS=1 GOV_RO_DATABASE_URL="$(<"$XDG_RUNTIME_DIR/gov-ro-url")" uv run --directory studio/apps/agent pytest tests/test_lc1_live_probe.py -q
```
It refuses a superuser, a Studio role, a missing `studio_gov_ro`, and a `studio_ro` schema owned by someone else. The role gets `USAGE` on `studio_ro` and `SELECT` on seven `security_barrier` views; no grant is made on any base table, and a post-check rolls back if one is. The file is numbered 0003 by order; `run-roles.sh --login` selects `0003_login.sql` by name, so there is no clash. Without `STUDIO_EXPECT_VIEWS=1` the probe skips the view checks when the schema is absent; with it, a missing schema fails.

### Document-audit views (M2): `0007_docaudits_views.sql`
Adds two more `studio_ro` views (`document_audit_list`, `document_audit_finding_list`) over `document_audits` / `document_audit_findings`, which stay denied. Same rules as 0003; run after it (either order is safe: each file revokes and grants only on its own views, so re-running one never strips the other's grants):
```bash
SQL_FILE=ops/neon/0007_docaudits_views.sql ops/neon/run-roles.sh "$XDG_RUNTIME_DIR/owner-url"    # one transaction, idempotent
STUDIO_EXPECT_VIEWS=1 GOV_RO_DATABASE_URL="$(<"$XDG_RUNTIME_DIR/gov-ro-url")" uv run --directory studio/apps/agent pytest tests/test_lc1_live_probe.py -q
```
The post-check compares the views' columns with an explicit allowlist in the file (a renamed column cannot slip past a name regex). The probe with `STUDIO_EXPECT_VIEWS=1` expects BOTH files to be installed (nine views) and that the two base tables stay denied.

### Ungate columns (21 Oct ruling): `0008_ungate_views.sql`
V's ruling: governance has no doctor or PHI gating. This file appends columns AT THE END of five existing views with `CREATE OR REPLACE VIEW` (owner, `security_barrier` and the grant to `studio_gov_ro` are kept): `physician_privileges.withdrawn_reason`, `physician_oppe.decision_notes`, `physician_qualifications.institution`, `capture_gaps.note` and `source_doc`, `incident_reply_status.reply_text`. Run it after 0003 (it refuses if `studio_ro` is missing), idempotent, one transaction:
```bash
SQL_FILE=ops/neon/0008_ungate_views.sql ops/neon/run-roles.sh "$XDG_RUNTIME_DIR/owner-url"
STUDIO_EXPECT_VIEWS=1 GOV_RO_DATABASE_URL="$(<"$XDG_RUNTIME_DIR/gov-ro-url")" uv run --directory studio/apps/agent pytest tests/test_lc1_live_probe.py -q
```
Re-running 0003 drops and recreates those five views WITHOUT the appended columns: run 0008 again afterwards. The role still has nothing on any base table. The `interventions` note and the incidents text need no migration: `gov_interventions` and `incidents` are granted table-wide in 0001. The probe now expects the 0008 columns, so run it only after all three view files.

Then move the DSN into the even-studio Vercel project and the Asus agent env (never even-elo), and destroy the files. To rotate later, follow **Rotation** below: do NOT just repeat steps 2 and 3.

## Rotation (the role is already LOGIN)
Resetting a password on a live LOGIN role is where the API's side effects bite: if `reset_password` adds `neon_superuser` (open question b), a naive repeat of steps 2 + 3 leaves the role LOGIN-able *and* a member between the reset and the check (reproduced in the tests). So:
```bash
# step 0: take the role offline in its OWN committed statement (idempotent, no password involved)
ops/neon/run-roles.sh --nologin "$XDG_RUNTIME_DIR/owner-url"                  # add --role studio_app for the state role
# step 1: Neon issues a new password into a NEW 0600 DSN file (an existing OUT is never overwritten)
ops/neon/neon-role.sh reset-password "$XDG_RUNTIME_DIR/neon-api-key" "$P" "$B" studio_gov_ro "$XDG_RUNTIME_DIR/gov-ro-url-new" --dsn-from "$XDG_RUNTIME_DIR/owner-url"
# step 2: memberships + grants re-checked, then LOGIN
ops/neon/run-roles.sh --login "$XDG_RUNTIME_DIR/owner-url"
# step 3: probe with the new DSN, swap it into both env stores, destroy old and new files
```
- **Live sessions are ended too.** NOLOGIN only blocks *new* connections, so `--nologin` (and a failed `--login`'s containment) follows the committed NOLOGIN with `pg_terminate_backend` on every session of the role and prints `N live session(s) terminated`. The owner needs the right to signal the role's backends (member of the role, or `pg_signal_backend`); if it does not, the script prints `WARNING: <role> is NOLOGIN but N live session(s) could NOT be terminated ...` and exits **5** (distinct from every other code; in the containment path 5 outranks the original failure code). Never ignore exit 5: end those sessions by hand before trusting the rotation. The Studio app/agent connection pool simply reconnects with the new DSN once step 2 has run (its old sessions are gone, so the old password stops working immediately; redeploy or restart with the new DSN).
- Containment is automatic too: **a failed `--login` itself issues `ALTER ROLE ... NOLOGIN` (its own committed statement) before exiting non-zero**, so a role the API made a member of anything can never stay LOGIN-able after a failed check. It prints `NOLOGIN (contained)`; fix the cause (a `neon_superuser` member cannot be un-granted by the owner: drop the role and stop), then run `--login` again. Between step 0 and a successful step 2 the Studio has no database access (plan a short window; the old DSN stops working at step 0).
- **If the OUT file is empty** (the script was killed, e.g. `kill -9`/OOM, after the reset call): the password was already rotated server-side and is lost. Delete the empty OUT (and shred any leftover `neon-role.*/curl.cfg` in `$XDG_RUNTIME_DIR` or `/dev/shm`: it holds the API key), then **reset again**. Normal failures, `INT`, `TERM` and `HUP` remove the OUT and the curl config themselves; only an uncatchable kill leaves them.

## Why SQL creates the roles, and the API only issues passwords
Roles created through the Neon API/Console are granted `neon_superuser`, which a non-superuser owner cannot revoke, and the owner is not ADMIN of them (refute R12: the role would be a `neon_superuser` member with no grants, LOGIN-able). Roles created by SQL get no such membership and the creator holds ADMIN (PG16+). A plaintext `ALTER ROLE ... PASSWORD` over SQL is not allowed (it would put the password in server logs), and Neon rejects SCRAM verifiers, hence the API for the password.
- **Safety nets, all inside transactions:** setup creates the role `NOLOGIN` and aborts (rolls back) if the role is, before or after the changes, a member of ANY role; the login step aborts if the role is missing, lacks its grants, or is a member of any role (checked again after `ALTER ROLE ... LOGIN`). So the role is never LOGIN-able without grants and never with `neon_superuser`.
- **Open live questions (UNVERIFIED, O1 answers them):** (a) does the Neon API list and reset SQL-created roles? If not, `reset-password` exits 4 and changes nothing; (b) does `reset_password` add `neon_superuser` membership? If it does, the login step refuses and the role stays NOLOGIN; the owner cannot revoke it, so drop the role and stop (do not enable LOGIN on a `neon_superuser` member).

## Before the first run: check the Postgres version
```bash
psql "service=owner" -Atc "SELECT version()"       # or any psql session as the owner
```
- **PG 15+**: PUBLIC has no CREATE on schema `public`; nothing to do.
- **PG 14 or older**: run `REVOKE CREATE ON SCHEMA public FROM PUBLIC;` as the owner BEFORE the probe, or the probe's "no CREATE on any schema" / egress checks fail (PUBLIC's default grant). `0001_studio.sql` does this for the studio database; the governance database is the owner's to do.

## Owner role
Neon owners are never superusers. The SQL works for a non-superuser CREATEROLE owner: NOSUPERUSER appears only in `CREATE ROLE`, and NOCREATEDB / NOREPLICATION / NOBYPASSRLS are re-asserted only if the owner itself holds that attribute (Postgres refuses to even mention one you lack); the probe asserts them false either way. It runs as ONE transaction (`psql --single-transaction`) and enables LOGIN as its last statement, so a failure leaves nothing half-configured. If `studio_gov_ro` was created earlier by a different role, the owner needs CREATEROLE with ADMIN OPTION on it (or drop/recreate it).

## What it guarantees
- **No password handling in the scripts at all**: no password clause in any SQL file, nothing generated, nothing sent over SQL. The server log (`log_statement=all`) shows no `PASSWORD` statement from `run-roles.sh` (tests assert this); the only password is the one Neon issues, which goes through `neon-role.sh` into a 0600 file.
- `neon-role.sh`: the API key reaches curl only as a `header =` line of a 0600 curl config on tmpfs (never argv); the response is piped `curl | jq` straight into the output file, which must not exist and is created 0600 (a failed call removes it); nothing is printed. `NEON_API_BASE` is parsed strictly: https with a plain host, or http only for exactly `127.0.0.1` / `localhost`, no userinfo (a prefix match would send the bearer key to `http://127.0.0.1.evil.test`).
- No secret on any command line or in the environment: the owner URL is read from a file and handed to psql as a service file.
- Re-running setup is idempotent and does not change the LOGIN state of an existing role.

## Temp files and abnormal exit
Secrets (`svc` = the owner URL as a psql service file; for `neon-role.sh` also the curl config holding the API key) live in a `studio-roles.*` / `neon-role.*` directory under `$XDG_RUNTIME_DIR` or `/dev/shm` (tmpfs, RAM only). The script refuses a disk-backed temp dir unless `--allow-disk-tmp` is given.
- Normal exit, INT and TERM: a trap shreds and removes them.
- **kill -9, OOM kill or power loss: the trap cannot run.** Clean up by hand:
  `find "$XDG_RUNTIME_DIR" /dev/shm -maxdepth 2 \( -path '*studio-roles.*' -o -path '*neon-role.*' \) -type f -exec shred -u {} +; rmdir "$XDG_RUNTIME_DIR"/studio-roles.* /dev/shm/studio-roles.* 2>/dev/null`
  (tmpfs is cleared on reboot anyway). With `--allow-disk-tmp` also check `${TMPDIR:-/tmp}/studio-roles.*`.
- `shred` overwrites in place and is **not reliable on journaling or copy-on-write filesystems** (ext4 data=journal, btrfs, ZFS, APFS) or SSD wear-levelling: that is why the files belong on tmpfs. Treat anything that touched a disk as possibly recoverable and rotate the password (step 2 again).
- The DSN file written by `neon-role.sh reset-password` is the one deliberate secret on disk: 0600, refuses to overwrite. Move it to the secret stores and `shred -u` it.

## Probe
`studio/apps/agent/tests/test_lc1_live_probe.py` (needs `GOV_RO_DATABASE_URL`) proves the role is read-only by grants, not just by settings; `tests/test_studio_roles.py` and `tests/test_studio_probe_sensitivity.py` run it against a scratch Postgres, including over-privileged roles it must catch.
