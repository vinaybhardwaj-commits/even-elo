-- Neon role for the Studio read-only governance connection (GOV_RO_DATABASE_URL).
-- Run ONLY through ops/neon/run-roles.sh (owner role, DIRECT connection). Idempotent.
-- Never run against Neon from CI or from a build step; the password never appears in this file:
-- it arrives as the psql variable :pw, read from a 0600 file by run-roles.sh.
--
-- Grants are exactly: USAGE on schema public; SELECT on six governance tables; COLUMN grants
-- (id, status, is_super_admin) on profiles_with_roles and (id, must_change_pin) on profiles.
-- profiles_with_roles is `SELECT p.*`, so a table-wide grant on it (or on profiles) would expose
-- password_hash and email. Nothing else is granted: no INSERT/UPDATE/DELETE/TRUNCATE, no sequences,
-- no functions, no CREATE, no role memberships.
\set ECHO none
\set QUIET on
\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_gov_ro') THEN
    CREATE ROLE studio_gov_ro LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5;
  END IF;
END
$$;

ALTER ROLE studio_gov_ro LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5;
ALTER ROLE studio_gov_ro SET default_transaction_read_only = on;
ALTER ROLE studio_gov_ro SET statement_timeout = '15s';
ALTER ROLE studio_gov_ro SET idle_in_transaction_session_timeout = '30s';

-- Start from nothing (column privileges go with their table).
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM studio_gov_ro;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM studio_gov_ro;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM studio_gov_ro;
REVOKE ALL ON SCHEMA public FROM studio_gov_ro;

GRANT USAGE ON SCHEMA public TO studio_gov_ro;
GRANT SELECT ON physicians, physician_engagements, hospitals, gov_signal_snapshots, gov_interventions, incidents TO studio_gov_ro;
GRANT SELECT (id, status, is_super_admin) ON profiles_with_roles TO studio_gov_ro;
GRANT SELECT (id, must_change_pin) ON profiles TO studio_gov_ro;

-- Password: only when run-roles.sh supplied one (psql variable, never echoed).
\set haspw `[ -s "$PWFILE" ] && echo 1 || echo 0`
\if :haspw
\set pw `cat "$PWFILE"`
ALTER ROLE studio_gov_ro PASSWORD :'pw';
\endif
