-- Role for the CDMSS module's read-only connection (CDMSS Neon database). studio_cdmss_ro can read ONLY the
-- column-scoped views in schema cdmss_ro (built by 0002_cdmss_ro_views.sql). Run ONLY through ops/cdmss/run-cdmss-ro.sh
-- (database OWNER, DIRECT url, never a superuser). Idempotent. NOT RUN by the builder.
-- No password clause anywhere: the role is created NOLOGIN by SQL (a role made through the Neon API/Console gets
-- neon_superuser, which the owner cannot revoke; an SQL-created role gets no memberships). The password is issued
-- later through the Neon API only and LOGIN is enabled in a separate step; this file never enables LOGIN.
-- Do NOT copy newcat_ro (Even-CDMSS migrations/0062): that role has whole-table SELECT on 17 tables (uhid, patient_name,
-- operative note text, feedback comments). Here the role holds no privilege on any table in schema public.
\set ECHO none
\set QUIET on
\set ON_ERROR_STOP on

DO $$
DECLARE
  me pg_roles%ROWTYPE;
  sch_owner name;
BEGIN
  SELECT * INTO me FROM pg_roles WHERE rolname = current_user;
  IF me.rolsuper THEN
    RAISE EXCEPTION 'run 0001_cdmss_ro_role.sql as the database owner, not a superuser: refusing';
  END IF;
  IF me.rolname = 'studio_cdmss_ro' THEN
    RAISE EXCEPTION 'run 0001_cdmss_ro_role.sql as the database owner, not studio_cdmss_ro: refusing';
  END IF;
  -- PREFLIGHT: an existing studio_cdmss_ro that is a member of any role (e.g. neon_superuser) is refused.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_cdmss_ro')
     AND EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'studio_cdmss_ro') THEN
    RAISE EXCEPTION 'studio_cdmss_ro is already a member of another role (neon_superuser?): refusing; drop it and let this file create it';
  END IF;
  SELECT pg_get_userbyid(nspowner) INTO sch_owner FROM pg_namespace WHERE nspname = 'cdmss_ro';
  IF sch_owner IS NOT NULL AND sch_owner <> current_user THEN
    RAISE EXCEPTION 'schema cdmss_ro is owned by another role: refusing';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_cdmss_ro') THEN
    CREATE ROLE studio_cdmss_ro NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5;
  END IF;
END
$$;

-- A separate command on purpose (see ops/neon/0001_roles.sql): the creator's implicit ADMIN OPTION is only visible
-- to the next command. NOCREATEDB / NOREPLICATION / NOBYPASSRLS are only mentioned when the executing role holds them.
DO $$
DECLARE
  me pg_roles%ROWTYPE;
  opts text := 'NOINHERIT NOCREATEROLE CONNECTION LIMIT 5';
BEGIN
  SELECT * INTO me FROM pg_roles WHERE rolname = current_user;
  IF me.rolsuper OR me.rolcreatedb THEN opts := opts || ' NOCREATEDB'; END IF;
  IF me.rolsuper OR me.rolreplication THEN opts := opts || ' NOREPLICATION'; END IF;
  IF me.rolsuper OR me.rolbypassrls THEN opts := opts || ' NOBYPASSRLS'; END IF;
  EXECUTE 'ALTER ROLE studio_cdmss_ro ' || opts;
END
$$;

ALTER ROLE studio_cdmss_ro SET default_transaction_read_only = on;
ALTER ROLE studio_cdmss_ro SET statement_timeout = '20s';
ALTER ROLE studio_cdmss_ro SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE studio_cdmss_ro SET search_path = cdmss_ro, pg_catalog;

-- The schema the views live in. Owner-owned; nobody but the owner gets anything until 0002 grants USAGE.
CREATE SCHEMA IF NOT EXISTS cdmss_ro;
REVOKE ALL ON SCHEMA cdmss_ro FROM PUBLIC;

-- Start from nothing, in both schemas (column privileges go with their table). No default privileges are created.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM studio_cdmss_ro;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM studio_cdmss_ro;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM studio_cdmss_ro;
REVOKE ALL ON SCHEMA public FROM studio_cdmss_ro;
REVOKE ALL ON ALL TABLES IN SCHEMA cdmss_ro FROM studio_cdmss_ro;
REVOKE ALL ON SCHEMA cdmss_ro FROM studio_cdmss_ro;

-- POST-CHECK (same transaction): no membership at all.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'studio_cdmss_ro') THEN
    RAISE EXCEPTION 'studio_cdmss_ro ended up a member of another role: rolling back';
  END IF;
END
$$;
