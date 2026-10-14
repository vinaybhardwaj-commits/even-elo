-- Prints the number of live sessions of :role (used to report what could not be terminated).
\set ON_ERROR_STOP on
SELECT count(*) FROM pg_stat_activity WHERE usename = :'role' AND pid <> pg_backend_pid();
