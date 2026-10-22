# First-session verification (fable G-D5, adapted for the extract job)

Run ONCE, before the first extract, on the Mini, after the Opus refute of the job:

    ops/db13/extract/run-extract.sh verify

It opens ONE ssh tunnel and ONE connection from `ada.env` (values never printed), runs the job's own session setup
(`BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ`, `statement_timeout 60s`, `idle_in_transaction_session_timeout 5min`),
then six checks, and prints PASS / FAIL / INFO lines only. Nothing else runs; the extract is NOT started.

| # | Check (what it runs) | Expected output |
|---|---|---|
| 0 | `SHOW transaction_read_only`, `SHOW statement_timeout` inside the job's txn (the job itself refuses otherwise) | no line on success; `REFUSED: DB13 session is not read-only`, exit 2 on failure |
| 1 | `SHOW transaction_read_only` | `PASS transaction_read_only on` |
| 2 | `SHOW default_transaction_read_only` | `INFO default_transaction_read_only=on` or `=off`. Informational: V's per-person role is probably `off`; the READ ONLY transaction is what protects DB13 |
| 3 | `SELECT current_user` equals the configured `PG_USER` (value not printed) | `PASS current_user is the configured role` |
| 4 | `count(*)` of `pg_stat_activity` for `current_user` | `PASS pg_stat_activity count for current_user <= 3` (this session counts, so 1..3) |
| 5 | `SELECT count(*)` over the `doctors` extract query (the only table read) | `PASS one SELECT count on one query (doctors)` |
| 6 | `CREATE TABLE studio_dw_verify_must_fail (a int)` | `PASS write attempt refused with the read-only error`, i.e. the server said `cannot execute CREATE TABLE in a read-only transaction` |

Exit code 0 only if all six PASS.

## STOP rule
Any `FAIL`, any `REFUSED`, exit code other than 0, or any error: stop. Do not start the extract, do not retry with other
options, do not "just check one more thing". Report the exact output lines (they carry no values) to gov-orch.
A `FAIL` on check 6 (the write succeeded) is an incident: touch `~/.config/studio-dw-extract/DISABLED`, unload the plist,
and tell V, because it means the connection is not read-only. Fix, then rerun this file from the top.
