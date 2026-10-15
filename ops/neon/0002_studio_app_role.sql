-- Neon role for the Studio STATE database (STUDIO_DATABASE_URL): checkpoints, studio_audit, studio_nonce.
-- Run ONLY through `run-roles.sh --role studio_app` as the owner of the STUDIO database. Idempotent.
-- Creates the role NOLOGIN with no password clause and no memberships; the grants on the Studio tables come
-- from studio/apps/agent/migrations/0001_studio.sql (apply_migration.py --app-role studio_app), and the
-- password is issued by the Neon API (neon-role.sh reset-password) before 0003_login.sql enables LOGIN.
-- Created BY SQL on purpose (API-created roles get neon_superuser, which the owner cannot revoke).
\set ECHO none
\set QUIET on
\set ON_ERROR_STOP on

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app')
     AND EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'studio_app') THEN
    RAISE EXCEPTION 'studio_app is already a member of another role (neon_superuser?): refusing; drop it and let run-roles.sh create it';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app') THEN
    CREATE ROLE studio_app NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20;
  END IF;
END
$$;

DO $$
DECLARE
  me pg_roles%ROWTYPE;
  opts text := 'NOINHERIT NOCREATEROLE CONNECTION LIMIT 20';
BEGIN
  SELECT * INTO me FROM pg_roles WHERE rolname = current_user;
  IF me.rolsuper OR me.rolcreatedb THEN opts := opts || ' NOCREATEDB'; END IF;
  IF me.rolsuper OR me.rolreplication THEN opts := opts || ' NOREPLICATION'; END IF;
  IF me.rolsuper OR me.rolbypassrls THEN opts := opts || ' NOBYPASSRLS'; END IF;
  EXECUTE 'ALTER ROLE studio_app ' || opts;
END
$$;

ALTER ROLE studio_app SET statement_timeout = '30s';
ALTER ROLE studio_app SET idle_in_transaction_session_timeout = '60s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'studio_app') THEN
    RAISE EXCEPTION 'studio_app ended up a member of another role: rolling back';
  END IF;
END
$$;
-- The role stays NOLOGIN until 0003_login.sql.
