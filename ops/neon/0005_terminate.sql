-- After the committed NOLOGIN (run-roles.sh --nologin, and a failed --login): end the role's LIVE sessions, because
-- NOLOGIN only blocks new connections. Prints one number: the sessions terminated. Needs the owner to be allowed to
-- signal the role's backends (member of the role with INHERIT, or pg_signal_backend); otherwise Postgres raises
-- "permission denied" and run-roles.sh reports the sessions it could not end (exit 5). Not a transaction of its own
-- choosing: a single SELECT, nothing is written, no password involved.
\set ON_ERROR_STOP on
SELECT count(*) FILTER (WHERE pg_terminate_backend(pid))
FROM pg_stat_activity
WHERE usename = :'role' AND pid <> pg_backend_pid();
