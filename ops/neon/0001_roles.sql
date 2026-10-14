-- Neon role for the Studio read-only governance connection (GOV_RO_DATABASE_URL).
-- Run ONLY through ops/neon/run-roles.sh (owner role, DIRECT connection). Idempotent.
-- No password clause anywhere: the role is created NOLOGIN here; its password is issued by the Neon API
-- (neon-role.sh reset-password) and LOGIN is enabled afterwards by 0003_login.sql (run-roles.sh --login).
-- The role is created BY SQL on purpose: roles created through the Neon API/Console are granted
-- neon_superuser, which the owner cannot revoke; SQL-created roles get no memberships.
--
-- Grants are exactly: USAGE on schema public; SELECT on six governance tables; COLUMN grants
-- (id, status, is_super_admin) on profiles_with_roles and (id, must_change_pin) on profiles.
-- profiles_with_roles is `SELECT p.*`, so a table-wide grant on it (or on profiles) would expose
-- password_hash and email. Nothing else is granted: no INSERT/UPDATE/DELETE/TRUNCATE, no sequences,
-- no functions, no CREATE, and NO role memberships (checked before and after, inside the transaction).
\set ECHO none
\set QUIET on
\set ON_ERROR_STOP on

-- Runs in ONE transaction (run-roles.sh uses psql --single-transaction): a failure anywhere rolls the
-- whole thing back. The role is created NOLOGIN and this file never enables LOGIN, so it is never
-- LOGIN-able without its grants. Works for a NON-superuser CREATEROLE owner (Neon owners are never superusers):
-- NOSUPERUSER is only in CREATE ROLE, and NOCREATEDB / NOREPLICATION / NOBYPASSRLS are re-asserted in the
-- ALTER only when the executing role itself holds that attribute (Postgres refuses to even mention an
-- attribute you do not hold); otherwise the live probe asserts them false.
-- PREFLIGHT: an existing studio_gov_ro that is a member of any role (e.g. neon_superuser, because it was
-- created through the Neon API) is refused; the whole transaction rolls back and nothing is changed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_gov_ro')
     AND EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'studio_gov_ro') THEN
    RAISE EXCEPTION 'studio_gov_ro is already a member of another role (neon_superuser?): refusing; drop it and let run-roles.sh create it';
  END IF;
END
$$;

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
  EXECUTE 'ALTER ROLE studio_gov_ro ' || opts;
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

-- POST-CHECK (same transaction): the role must hold no membership at all.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'studio_gov_ro') THEN
    RAISE EXCEPTION 'studio_gov_ro ended up a member of another role: rolling back';
  END IF;
END
$$;

-- The role stays NOLOGIN. LOGIN is enabled by 0003_login.sql (run-roles.sh --login) only after the Neon API
-- has issued the password and the membership check passed again.
