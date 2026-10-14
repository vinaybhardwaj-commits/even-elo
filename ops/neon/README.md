# ops/neon: the read-only governance role (`studio_gov_ro`)

Run once per Neon database, as the database OWNER, over the DIRECT (non-pooled) URL. Never from CI or a build.

```bash
umask 077
vercel env pull --environment=production "$XDG_RUNTIME_DIR/owner.env"        # or write the owner URL to any 0600 file
# put just the owner DIRECT url in the file (one line), then:
ops/neon/run-roles.sh --dry-run                                              # preview, connects to nothing
ops/neon/run-roles.sh "$XDG_RUNTIME_DIR/owner-url" "$XDG_RUNTIME_DIR/gov-ro-url"
GOV_RO_DATABASE_URL="$(<"$XDG_RUNTIME_DIR/gov-ro-url")" uv run --directory studio/apps/agent pytest tests/test_lc1_live_probe.py -q
```

Then move the URL into the even-studio Vercel project and the Asus agent env (never even-elo), and destroy the files.

## Before the first run: check the Postgres version
```bash
psql "service=owner" -Atc "SELECT version()"       # or any psql session as the owner
```
- **PG 15+**: PUBLIC has no CREATE on schema `public`; nothing to do.
- **PG 14 or older**: run `REVOKE CREATE ON SCHEMA public FROM PUBLIC;` as the owner BEFORE the probe, or the probe's "no CREATE on any schema" / egress checks fail (PUBLIC's default grant). `0001_studio.sql` does this for the studio database; the governance database is the owner's to do.

## Owner role
Neon owners are never superusers. The SQL works for a non-superuser CREATEROLE owner: NOSUPERUSER appears only in `CREATE ROLE`, and NOCREATEDB / NOREPLICATION / NOBYPASSRLS are re-asserted only if the owner itself holds that attribute (Postgres refuses to even mention one you lack); the probe asserts them false either way. It runs as ONE transaction (`psql --single-transaction`) and enables LOGIN as its last statement, so a failure leaves nothing half-configured. If `studio_gov_ro` was created earlier by a different role, the owner needs CREATEROLE with ADMIN OPTION on it (or drop/recreate it).

## Neon: `--neon-plaintext-password`
Neon's control plane rejects SCRAM verifiers in `ALTER ROLE ... PASSWORD` ("Neon only supports being given plaintext passwords"). On Neon run:
`ops/neon/run-roles.sh --neon-plaintext-password OWNER_URL_FILE OUT_FILE`
The random 192-bit plaintext is then sent by `ALTER ROLE ... PASSWORD :'rolepw'` (psql variable read from the 0600 tmpfs file; still never on argv or echoed). Still one transaction, and that ALTER is the last statement before `LOGIN`, so a failure anywhere earlier can never put the password into a `STATEMENT:` error log.
**Trade-off:** in this mode the plaintext does reach the server, so **Neon's server-side logs may hold it if the ALTER itself fails** (or if statement logging is on). If `run-roles.sh` fails at or after the ALTER (non-zero exit with the role already changed), treat the password as exposed: re-run the script to rotate it, and do not use the old output file. The default (without the flag) keeps the plaintext off the server entirely and is what to use anywhere that accepts verifiers.

## What it guarantees
- By default the **plaintext password never reaches the server** (see the Neon flag above for the exception): the script derives a SCRAM-SHA-256 verifier (RFC 5802/7677, 16-byte salt, 4096 iterations) and `0001_roles.sql` sets `PASSWORD :'verifier'`. Server logs (`log_statement=all`, `STATEMENT:` lines on errors) and `pg_stat_activity` only ever see the verifier. The plaintext exists only in the 0600 output file (inside the URL).
- No secret on any command line or in the environment: the owner URL is read from a file and handed to psql as a service file.
- Re-running is a no-op except password rotation (new salt, new password). Rotate by running it again, then update both env stores.

## Temp files and abnormal exit
Secrets (`pw`, `verifier`, `svc` = the owner URL as a psql service file) live in a `studio-roles.*` directory under `$XDG_RUNTIME_DIR` or `/dev/shm` (tmpfs, RAM only). The script refuses a disk-backed temp dir unless `--allow-disk-tmp` is given.
- Normal exit, INT and TERM: a trap shreds and removes them.
- **kill -9, OOM kill or power loss: the trap cannot run.** Clean up by hand:
  `find "$XDG_RUNTIME_DIR" /dev/shm -maxdepth 2 -path '*studio-roles.*' -type f -exec shred -u {} +; rmdir "$XDG_RUNTIME_DIR"/studio-roles.* /dev/shm/studio-roles.* 2>/dev/null`
  (tmpfs is cleared on reboot anyway). With `--allow-disk-tmp` also check `${TMPDIR:-/tmp}/studio-roles.*`.
- `shred` overwrites in place and is **not reliable on journaling or copy-on-write filesystems** (ext4 data=journal, btrfs, ZFS, APFS) or SSD wear-levelling: that is why the files belong on tmpfs. Treat anything that touched a disk as possibly recoverable and rotate the password.
- The output URL file is the one deliberate secret on disk: 0600, refuses to overwrite. Move it to the secret stores and `shred -u` it.

## Probe
`studio/apps/agent/tests/test_lc1_live_probe.py` (needs `GOV_RO_DATABASE_URL`) proves the role is read-only by grants, not just by settings; `tests/test_studio_roles.py` and `tests/test_studio_probe_sensitivity.py` run it against a scratch Postgres, including over-privileged roles it must catch.
