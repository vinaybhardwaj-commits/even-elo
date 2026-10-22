# DB13 nightly extract: runbook (V's pivot, 22 Oct 2026)

Nothing goes to Even IT. The job uses only the access the Mini already holds for Human RAG (`~/.config/hrag/ada.env`:
`ADA_HOST SSH_USER SSH_KEY PG_HOST PG_PORT PG_DB PG_USER PG_PASSWORD DATA_BACKEND`). `PG_USER` is V's per-person role
(`pg_read_all_data`, no CREATEROLE); the job adds its own protection: every DB13 session is a READ ONLY transaction.

## What runs where
| Piece | Where | What |
|---|---|---|
| `ops/db13/extract/` (`spec.py` = the 8 column-scoped SELECTs with metric ids; `job.py`; `cli.py`) | the Mini | one ssh tunnel + one Postgres connection; batches; writes governance Neon |
| `ops/neon/0012_studio_dw.sql` | governance Neon, run by the DB owner | schema `studio_dw`, role `studio_dw_writer` (NOLOGIN), `studio_ro.dw_*` views |
| `com.even.studio-dw-extract.plist` + `run-extract.sh` | the Mini | launchd 22:30 daily; the job also refuses outside 22:00-07:00 IST when started as `scheduled` |

## What the job does
1. Reads `ada.env` (must be 0600) at runtime; values are never printed or logged. Errors print the exception CLASS only.
2. Opens ONE ssh tunnel with `ssh -N -F <temp 0600 config> gov-studio-ada` (host, user, key PATH and the single forward are in the temp config, deleted on exit; BatchMode, strict host key) and ONE connection with `application_name=gov-studio-extract` (`sslmode=disable`: the PG hop has no TLS, ssh carries it). Credentials live in the process only: the password goes to libpq and nowhere else (not argv, config, log or Neon).
2a. **Pinned queries.** Every DB13 data query is rendered from `spec.py` by `queries.py`; its SHA-256 must be in `manifest.json` (committed beside it) or the job raises `QueryNotPinned` before sending anything. After a reviewed change to `spec.py`: `cd ops/db13 && python3 -m extract.manifest write`, and the Opus refute reads the manifest diff.
3. `BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ`; `SET statement_timeout='60s'`; `SET idle_in_transaction_session_timeout='30s'`; then `SHOW transaction_read_only` must be `on` and `statement_timeout` `1min`, **else it stops before any data query** (exit 2). REPEATABLE READ gives one snapshot for the whole run; the run lasts minutes, so DB13's vacuum horizon is held that long. Keep runs off-peak.
4. Records `SELECT now(), pg_current_snapshot()` from inside that transaction ("DB13 as of").
5. Per table, keyset batches (`WHERE key > last ORDER BY key LIMIT 2000`), at most 2 queries per second (hard cap in code), and stops on the first error (the run row is marked `failed` with the error class). Keys: `_id` for `individuals-prescriptions` and `kx_*`, `presc_uid`, `uid`; the diagnosis table pages over distinct `_parent_id`. All of these are UNVERIFIED as indexed except the `kx_*` `_id`; confirm with `EXPLAIN` in the first supervised run.
6. Incremental = rows whose filter column is newer than the previous successful run's DB13 snapshot time (`uploaded_at`, `modified_at`, `updated_at`, `bill_date_time` with a 7-day lookback); tables without one (`doctors`, the diagnosis table) are always full. First run, or `--full`: everything; `--full` also deletes destination rows that vanished at the source. Column types of the filter columns are UNVERIFIED; a mismatch fails the run safely.
7. Writes `studio_dw.*` and one `studio_dw.extract_runs` row per run: `run_id, mode, started_at, ended_at, status, db13_snapshot_now, db13_snapshot, rows` (per table)`, watermarks, queries, error_class`.
Logs hold counts and timings only (`table=... rows=... batches=... seconds=...`), never row data.

## Commands (on the Mini)
```bash
ops/db13/extract/run-extract.sh verify              # FIRST: see VERIFY.md; stop on any FAIL
ops/db13/extract/run-extract.sh run                 # on demand, incremental, same caps, any time
ops/db13/extract/run-extract.sh run --full          # full refresh (also --tables doctors,surgery_cases)
ops/db13/extract/run-extract.sh scheduled           # what launchd calls (off-peak only)
```
Governance DSN for `studio_dw_writer`: a 0600 file at `~/.config/studio-dw-extract/writer-url` (override `STUDIO_DW_DSN_FILE`), produced by the Neon-API password step below. One run at a time (flock).

## Install order
1. Owner runs `0012_studio_dw.sql` (after 0001 and 0003): `SQL_FILE=ops/neon/0012_studio_dw.sql ops/neon/run-roles.sh OWNER_URL_FILE`. One transaction; the post-check rolls it back if `studio_gov_ro` can read any `studio_dw` table, or the writer holds anything outside `studio_dw`.
2. Password and LOGIN for `studio_dw_writer` exactly as for `studio_gov_ro` (ops/neon README: `neon-role.sh reset-password`, then enable LOGIN; the Neon API must be able to see SQL-created roles, still UNVERIFIED). Put the DSN in the 0600 file; never in a repo.
3. Opus refute of the job, then `verify`, then one supervised `run --full`, then install the plist:
   `sed "s#__REPO__#$PWD#" ops/db13/extract/com.even.studio-dw-extract.plist > ~/Library/LaunchAgents/com.even.studio-dw-extract.plist && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.even.studio-dw-extract.plist` (set the Mini's timezone to IST).

## Kill switch
- Flag file: `touch ~/.config/studio-dw-extract/DISABLED` (every start exits 3 before touching anything); remove it to resume.
- Unload: `launchctl bootout gui/$(id -u)/com.even.studio-dw-extract` and delete the plist.
- Hard stop: `ALTER ROLE studio_dw_writer NOLOGIN` (owner), or remove V's ada key access as before.

## Reading the data
Screens and chat read only `studio_ro.dw_*` and `studio_ro.dw_extract_status` (as `studio_gov_ro`); "DB13 as of" = `max(db13_snapshot_now)` of the latest `status='ok'` run. `studio_gov_ro` has no access to `studio_dw` itself.

## What the extract holds (PHI)
Per the ruling there is no PHI gating. Beyond the catalogue columns it carries `uhid` (discharged, billing), `age`, `individual_uid`, `uid`/`consult_uid`/`kx_encounter_id`, and doctor `email`. Never: patient names, addresses, kin, phones; doctors' bank, proofs, mobile, tariffs; money columns. A new column needs a catalogue entry first.

## Load rules
One tunnel, one connection, <= 2 qps, 60 s timeout, off-peak by default (22:00-07:00 IST); on-demand allowed at the same caps. `individuals-prescriptions` is 4.4 GB without uid/time indexes: the job pages on `_id` and filters on `uploaded_at`, so an incremental run may walk the `_id` index; watch the first supervised run's timings.

## If something fails
The job exits non-zero and the run row says `failed` with an error class (no data). Do not retry in a loop. A `REFUSED` (exit 2) means DB13's session was not read-only: leave it disabled and tell gov-orch.
