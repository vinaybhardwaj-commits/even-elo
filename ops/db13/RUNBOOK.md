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
3. **One READ ONLY transaction per table that only FETCHES.** Rows are written to a per-run spill file on the Mini (`~/Library/Caches/gov-studio-extract/run-<id>/<table>.spill`, dir 0700, file 0600, never /tmp), the DB13 transaction is COMMITTED, and only then is the spill loaded into Neon. The spill is deleted after each table and, in any case, on success, failure and every signal; a spill left by a SIGKILL is swept at the next start. The cap is 15 minutes of DB13 fetch per table (a table that does is aborted with status `timeout`, the other tables continue, the run ends `partial`, and that table's watermark does not advance). Each table: `BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ`; `SET statement_timeout='60s'`; `SET idle_in_transaction_session_timeout='5min'` (no Neon writes now happen inside the DB13 transaction; the margin is kept); then `SHOW transaction_read_only` must be `on` and `statement_timeout` `1min`, **else it stops before any data query** (`REFUSED`, exit 2). Every statement, session ones included, passes the pin check and the 2/s throttle.
4. Per table the snapshot `SELECT now(), pg_current_snapshot()` is taken inside that table's transaction and stored in `studio_dw.extract_run_tables` (also rows read, fetches, transaction seconds, watermark from/to, status). `extract_runs.db13_snapshot_now` is the OLDEST table snapshot ("DB13 as of").
5. **One query per table, no paging, no ORDER BY**: a server-side (named) cursor over `SELECT <pinned columns> FROM t [WHERE _update_time > watermark - 30 min]`, `FETCH 2000` per round trip, each FETCH throttled to <= 2/s (one seq scan per table per run), rows go to the spill, then each batch is upserted into Neon in its own Neon transaction (`fetch_seconds` and `load_seconds` are recorded separately in `extract_run_tables`; a fetch timeout loads nothing). The diagnosis child table is one plain cursor over the whole table, loaded under the run's id; `studio_ro.dw_dpipe_prescription_diagnosis` shows only the newest run that finished ok, and older runs' rows are deleted after the new one is marked ok. The job stops on the first non-timeout error (run `failed`, class only).
6. **Large tables** (`individuals-prescriptions`, `dpipe_prescription_pipeline`, its diagnosis table, `kx_billing_records`) are read only 22:00-07:00 IST. Outside it, `run` skips them (status `skipped`, run `partial`) and reads the small tables. `run --i-know-its-peak` overrides this and requires V's own flag file `~/.config/studio-dw-extract/ALLOW_PEAK` (the job never creates it; exit 6 otherwise).
7. Incremental = rows whose filter column is newer than that table's last ok snapshot minus 30 minutes (commit lag). Filter columns: `_update_time` for `individuals-prescriptions` (the mirror's update time); `uploaded_at` for `dpipe_prescription_pipeline` (a pipeline view with no `_update_time`; edits that do not move `uploaded_at` wait for a `--full` run); `modified_at` (`kx_ip_admissions`, `kx_discharged_completed_patients`), `updated_at` (`surgery_cases`), `bill_date_time` with a 7-day lookback (`kx_billing_records`) are UNVERIFIED stand-ins until someone confirms those tables carry `_update_time`. `doctors` and the diagnosis table are always full. First run or `--full`: everything; `--full` also deletes destination rows that vanished at the source. A filtered cursor still scans the whole table (nothing is indexed on these columns); the 60 s statement timeout applies to each FETCH, so a sparse filter on the 4.4 GB table may trip it: watch the first supervised run.
8. **Signals.** SIGTERM, SIGHUP and SIGINT unwind through the cleanup: the 0600 ssh config is removed, the ssh child is terminated, the DB13 and Neon connections are closed, the DB13 transaction is rolled back and the run is recorded as `killed` (exit 128+signal). `launchctl bootout` is therefore safe.
Logs hold counts and timings only (`table=... rows=... fetches=... seconds=...`), never row data.

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
Per the ruling there is no PHI gating. Beyond the catalogue columns it carries `uhid` (discharged, billing), `age`, `individual_uid`, `uid`/`consult_uid`/`kx_encounter_id`. Doctor e-mail, name, type and flags are NOT extracted (no catalogue id needs them; names come from the CDMSS directory). Never: patient names, addresses, kin, phones; doctors' bank, proofs, mobile, tariffs; money columns. A new column needs a catalogue entry first.

## Load rules
One tunnel, one connection, <= 2 qps, 60 s timeout, off-peak by default (22:00-07:00 IST); on-demand allowed at the same caps. `individuals-prescriptions` is 4.4 GB without uid/time indexes: it is read by ONE sequential pass per run, off-peak only. Logs go to `~/Library/Logs/gov-studio-extract/` (counts only).

## If something fails
The job exits non-zero and the run row says `failed` with an error class (no data). Do not retry in a loop. A `REFUSED` (exit 2) means DB13's session was not read-only: leave it disabled and tell gov-orch.

## Added after the second refute
- **Disk preflight.** Before any DB13 statement the job refuses (`FAILED: DiskLow`, sizes only) if free space under `~/Library/Caches/gov-studio-extract` is below 3 x the largest estimated spill among the tables it will read (prescriptions est. 4.4 GB, so ~13 GB). Configure with `GOV_STUDIO_SPILL_FACTOR` and `GOV_STUDIO_SPILL_LARGEST_BYTES`. Estimates live in `spec.py` (`est_bytes`, UNVERIFIED).
- **Sweep first.** Every start takes the run lock, then removes leftover spill dirs, `gov-studio-ssh-*` config dirs and orphaned `ssh -N -F .../gov-studio-ssh-...` processes, BEFORE the kill-flag check, so a SIGKILLed run's plaintext spill cannot outlive a disabled job. A start that cannot get the lock sweeps nothing.
- **Diagnosis cap 25 min** (others 15), logged with its reason each run. Chosen over splitting by `_parent_id` range: no new SQL, no second full scan of the primary, no more complex child replace; 25 min stays under the 30 min line. A table above its cap times out every night and the run is `partial`: alert on that.
- A failed Neon status update on an error path never replaces the original error or signal (exit stays 128+signal).
