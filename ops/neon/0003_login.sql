-- Final step, run by `run-roles.sh --login [--role R]` AFTER the Neon API issued the password
-- (neon-role.sh reset-password). One transaction, no password anywhere:
--   1. the role must exist, hold NO memberships (the API may add neon_superuser on reset: that is caught here),
--      and already carry its grants (a probe privilege per role); otherwise the transaction aborts and the
--      role stays NOLOGIN;
--   2. ALTER ROLE ... LOGIN;
--   3. the membership check runs again.
-- psql variables (not secrets): role, probe_table, probe_priv.
\set ECHO none
\set QUIET on
\set ON_ERROR_STOP on

-- psql does not substitute :variables inside $$ bodies, so hand them over as transaction-local settings.
SELECT set_config('studio.role', :'role', true),
       set_config('studio.probe_table', :'probe_table', true),
       set_config('studio.probe_priv', :'probe_priv', true) \gset

DO $$
DECLARE
  r text := current_setting('studio.role');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
    RAISE EXCEPTION 'role % does not exist: run run-roles.sh (setup) first', r;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles x ON x.oid = m.member WHERE x.rolname = r) THEN
    RAISE EXCEPTION 'role % is a member of another role (neon_superuser added by the API?): refusing to enable LOGIN', r;
  END IF;
  IF to_regclass(current_setting('studio.probe_table')) IS NULL
     OR NOT has_table_privilege(r, current_setting('studio.probe_table'), current_setting('studio.probe_priv')) THEN
    RAISE EXCEPTION 'role % lacks its grants (% on %): refusing to enable LOGIN', r, current_setting('studio.probe_priv'), current_setting('studio.probe_table');
  END IF;
END
$$;

ALTER ROLE :"role" LOGIN;

DO $$
DECLARE
  r text := current_setting('studio.role');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles x ON x.oid = m.member WHERE x.rolname = r) THEN
    RAISE EXCEPTION 'role % is a member of another role after enabling LOGIN: rolling back', r;
  END IF;
END
$$;
