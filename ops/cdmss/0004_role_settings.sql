-- ROLE-LEVEL SETTINGS for studio_cdmss_ro, run by ops/cdmss/run-cdmss-ro.sh (as the database OWNER, over the DIRECT url) after 0001-0003, in
-- the SAME transaction. Why a separate file: the Asus relay (pgbouncer) sets default_transaction_read_only / statement_timeout with a per-
-- connection connect_query, but its DISCARD ALL reset undoes that after the first client leaves. Role-level settings are the ones that
-- survive DISCARD ALL (they are the session defaults a reset returns to), so they are the fence that holds for every agent connection.
-- (0001 already set read-only and 20s / 30s; this file is the final word: 30s statement, 60s idle-in-transaction. Idempotent.)
-- run-cdmss-ro.sh --check runs this file with :apply_settings = 0: the ALTERs are skipped and only the POST-CHECK runs (read-only).
-- POST-CHECK: pg_db_role_setting holds EXACTLY these four settings for the role (no more, no fewer, no per-database overrides):
--   default_transaction_read_only=on, idle_in_transaction_session_timeout=60s, search_path=cdmss_ro, pg_catalog (from 0001), statement_timeout=30s.
\set ECHO none
\set QUIET on
\set ON_ERROR_STOP on

DO $$
DECLARE
  me pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO me FROM pg_roles WHERE rolname = current_user;
  IF me.rolsuper THEN RAISE EXCEPTION 'run 0004_role_settings.sql as the database owner, not a superuser: refusing'; END IF;
  IF me.rolname = 'studio_cdmss_ro' THEN RAISE EXCEPTION 'run 0004_role_settings.sql as the database owner, not studio_cdmss_ro: refusing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_cdmss_ro') THEN
    RAISE EXCEPTION 'studio_cdmss_ro does not exist: run 0001_cdmss_ro_role.sql first';
  END IF;
END
$$;

\if :apply_settings
ALTER ROLE studio_cdmss_ro SET default_transaction_read_only = on;
ALTER ROLE studio_cdmss_ro SET statement_timeout = '30s';
ALTER ROLE studio_cdmss_ro SET idle_in_transaction_session_timeout = '60s';
\endif

DO $$
DECLARE
  got text[];
  want text[] := ARRAY['default_transaction_read_only=on', 'idle_in_transaction_session_timeout=60s',
                       'search_path=cdmss_ro, pg_catalog', 'statement_timeout=30s'];
  n_rows int;
BEGIN
  SELECT count(*) INTO n_rows FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole WHERE r.rolname = 'studio_cdmss_ro';
  IF n_rows <> 1 THEN
    RAISE EXCEPTION '0004 postcheck: studio_cdmss_ro must have exactly one pg_db_role_setting row (the all-databases one), found %', n_rows;
  END IF;
  SELECT array_agg(c ORDER BY c) INTO got
    FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole, unnest(s.setconfig) AS c
   WHERE r.rolname = 'studio_cdmss_ro' AND s.setdatabase = 0;
  IF got IS DISTINCT FROM want THEN
    RAISE EXCEPTION '0004 postcheck: studio_cdmss_ro role settings are % (expected exactly %)', got, want;
  END IF;
END
$$;
