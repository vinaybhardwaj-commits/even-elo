-- Neon role for the Studio read-only governance connection (GOV_RO_DATABASE_URL).
-- Run ONLY through ops/neon/run-roles.sh (owner role, DIRECT connection). Idempotent.
-- Never run against Neon from CI or from a build step; the password never appears in this file:
-- a SCRAM-SHA-256 verifier arrives as the psql variable :rolepw, read from a 0600 file by run-roles.sh.
--
-- Grants are exactly: USAGE on schema public; SELECT on six governance tables; COLUMN grants
-- (id, status, is_super_admin) on profiles_with_roles and (id, must_change_pin) on profiles.
-- profiles_with_roles is `SELECT p.*`, so a table-wide grant on it (or on profiles) would expose
-- password_hash and email. Nothing else is granted: no INSERT/UPDATE/DELETE/TRUNCATE, no sequences,
-- no functions, no CREATE, no role memberships.
\set ECHO none
\set QUIET on
\set ON_ERROR_STOP on

-- Runs in ONE transaction (run-roles.sh uses psql --single-transaction): a failure anywhere rolls the
-- whole thing back, and LOGIN is switched on by the very last statement, so the role is never LOGIN-able
-- without its grants. Works for a NON-superuser CREATEROLE owner (Neon owners are never superusers):
-- NOSUPERUSER is only in CREATE ROLE, and NOCREATEDB / NOREPLICATION / NOBYPASSRLS are re-asserted in the
-- ALTER only when the executing role itself holds that attribute (Postgres refuses to even mention an
-- attribute you do not hold); otherwise the live probe asserts them false.
-- --password-preset: the role MUST already exist (the Neon API created it with its password).
\set mustexist `[ "${ROLE_MUST_EXIST:-0}" = 1 ] && echo 1 || echo 0`
\if :mustexist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_gov_ro') THEN
    RAISE EXCEPTION 'studio_gov_ro does not exist: create it with ops/neon/neon-role.sh first (password preset)';
  END IF;
END
$$;
\endif

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_gov_ro') THEN
    CREATE ROLE studio_gov_ro NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5;
  END IF;
END
$$;

-- A separate command on purpose: the creator's implicit ADMIN OPTION on the new role (PG16) is only
-- visible to the next command, not to the DO block that created the role.
DO $$
DECLARE
  me pg_roles%ROWTYPE;
  opts text := 'NOINHERIT NOCREATEROLE CONNECTION LIMIT 5';
BEGIN
  SELECT * INTO me FROM pg_roles WHERE rolname = current_user;
  IF me.rolsuper OR me.rolcreatedb THEN opts := opts || ' NOCREATEDB'; END IF;
  IF me.rolsuper OR me.rolreplication THEN opts := opts || ' NOREPLICATION'; END IF;
  IF me.rolsuper OR me.rolbypassrls THEN opts := opts || ' NOBYPASSRLS'; END IF;
  EXECUTE 'ALTER ROLE studio_gov_ro NOLOGIN ' || opts;
END
$$;

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

-- Password: only when run-roles.sh supplied a SCRAM-SHA-256 VERIFIER file (computed client-side, so the
-- plaintext never reaches the server: not in logs, STATEMENT: lines or pg_stat_activity). With
-- run-roles.sh --password-preset (Neon: the API set the password) there is no file and no password
-- statement at all. Plaintext passwords over SQL are never sent. Last statement before LOGIN. Never echoed.
\set haspw `[ -s "$ROLE_PASSWORD_FILE" ] && echo 1 || echo 0`
\if :haspw
\set rolepw `cat "$ROLE_PASSWORD_FILE"`
ALTER ROLE studio_gov_ro PASSWORD :'rolepw';
\endif

-- LAST statement: only now may the role log in (everything above succeeded, same transaction).
ALTER ROLE studio_gov_ro LOGIN;
