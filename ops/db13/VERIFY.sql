-- VERIFY.sql — first session as gov_studio_ro (fable G-D5). Run through the SSH tunnel,
-- ONE connection, nothing else first. Plain SQL: no psql meta-commands, so any client works.
-- Connect with:  psql "host=127.0.0.1 port=<LOCAL_PORT> dbname=<DB13> user=gov_studio_ro"
-- Run statements in order, one at a time. Compare each result to EXPECTED.
-- STOP RULE: any result that differs from EXPECTED, any error other than the one named in
-- step 6, or any write that succeeds => close the connection, tell Even IT and gov-orch,
-- do NOT run anything else, do not start the extract. A write that succeeds is an incident:
-- Even IT removes the ada key line (kill switch) first and asks questions after.
-- Do not add other queries to this session.

-- 1. EXPECTED: on
SHOW default_transaction_read_only;

-- 2. EXPECTED: gov_studio_ro
SELECT current_user;

-- 3. EXPECTED: 1min   (60s is displayed as 1min)
SHOW statement_timeout;

-- 4. EXPECTED: one row, n between 1 and 3 (this session counts, so never 0)
SELECT count(*) AS n FROM pg_stat_activity WHERE usename = current_user;

-- 5. EXPECTED: one row, one integer. First and only table read of the session.
SELECT count(*) AS doctors_rows FROM gov_studio.v_doctors;

-- 6. EXPECTED: ERROR:  cannot execute CREATE TABLE in a read-only transaction
--    Any other outcome (success, "permission denied", "must be owner") = STOP.
CREATE TABLE gov_studio.verify_must_fail (a int);
