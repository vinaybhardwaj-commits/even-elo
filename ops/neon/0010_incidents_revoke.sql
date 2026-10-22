-- Incidents grant NARROWING (Fable condition 2, 21 Oct M1 ruling), step 2 of 2: REVOKE ALL ON public.incidents FROM
-- studio_gov_ro, so the role reads incidents only through studio_ro.incident_register (0009). Run ONLY after 0009 has
-- been applied AND the agent that reads the view is deployed (the previous agent reads public.incidents and would fail
-- with a permission error). Run as the database OWNER over the DIRECT url:
--   SQL_FILE=ops/neon/0010_incidents_revoke.sql ops/neon/run-roles.sh OWNER_URL_FILE
-- Idempotent, ONE transaction. NOT RUN by the builder. Refuses if studio_ro.incident_register is missing, so it
-- cannot be applied without 0009.
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
    RAISE EXCEPTION 'run 0010_incidents_revoke.sql as the database owner, not a superuser: refusing';
  END IF;
  IF me.rolname IN ('studio_gov_ro', 'studio_app') THEN
    RAISE EXCEPTION 'run 0010_incidents_revoke.sql as the database owner, not a Studio role: refusing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_gov_ro') THEN
    RAISE EXCEPTION 'studio_gov_ro does not exist: run 0001_roles.sql first';
  END IF;
  SELECT pg_get_userbyid(nspowner) INTO sch_owner FROM pg_namespace WHERE nspname = 'studio_ro';
  IF sch_owner IS NULL THEN
    RAISE EXCEPTION 'schema studio_ro does not exist: run 0003_studio_views.sql first';
  END IF;
  IF sch_owner <> current_user THEN
    RAISE EXCEPTION 'schema studio_ro is owned by another role: refusing';
  END IF;
END
$$;


DO $$
BEGIN
  IF to_regclass('studio_ro.incident_register') IS NULL THEN
    RAISE EXCEPTION 'studio_ro.incident_register does not exist: run 0009_incidents_view.sql first';
  END IF;
END
$$;

-- The narrowing (a table-level REVOKE also removes any column-level grant on it).
REVOKE ALL ON public.incidents FROM studio_gov_ro;

-- POST-CHECK (same transaction): no membership, no privilege of any kind on the base table (column grants and
-- PUBLIC/inherited ones included), exact ACLs on every studio_ro view, the view still readable with exactly its columns.
DO $$
DECLARE
  bad text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'studio_gov_ro') THEN
    RAISE EXCEPTION 'studio_gov_ro is a member of another role: rolling back';
  END IF;
  IF to_regclass('public.incidents') IS NOT NULL AND (
       has_any_column_privilege('studio_gov_ro', 'public.incidents'::regclass, 'SELECT')
       OR has_any_column_privilege('studio_gov_ro', 'public.incidents'::regclass, 'INSERT')
       OR has_any_column_privilege('studio_gov_ro', 'public.incidents'::regclass, 'UPDATE')
       OR has_any_column_privilege('studio_gov_ro', 'public.incidents'::regclass, 'REFERENCES')
       OR has_table_privilege('studio_gov_ro', 'public.incidents'::regclass, 'DELETE')
       OR has_table_privilege('studio_gov_ro', 'public.incidents'::regclass, 'TRUNCATE')
       OR has_table_privilege('studio_gov_ro', 'public.incidents'::regclass, 'TRIGGER')) THEN
    RAISE EXCEPTION 'studio_gov_ro still holds a privilege on public.incidents: rolling back';
  END IF;
  SELECT string_agg(c.relname || ' -> ' || coalesce(pg_get_userbyid(NULLIF(a.grantee, 0)), 'PUBLIC'), ', ') INTO bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, LATERAL aclexplode(c.relacl) a
  WHERE n.nspname = 'studio_ro' AND c.relkind = 'v' AND a.grantee <> c.relowner
    AND NOT (pg_get_userbyid(a.grantee) = 'studio_gov_ro' AND a.privilege_type = 'SELECT');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'studio_ro view has an unexpected grant (%): rolling back', bad;
  END IF;
  IF NOT has_table_privilege('studio_gov_ro', 'studio_ro.incident_register'::regclass, 'SELECT') THEN
    RAISE EXCEPTION 'studio_gov_ro lost SELECT on studio_ro.incident_register: rolling back';
  END IF;
  SELECT string_agg(a.attname, ', ' ORDER BY a.attnum) INTO bad
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'studio_ro' AND c.relname = 'incident_register' AND a.attnum > 0 AND NOT a.attisdropped;
  IF bad IS DISTINCT FROM 'status, polarity, severity, submitted_at' THEN
    RAISE EXCEPTION 'studio_ro.incident_register columns are not the reviewed list (%): rolling back', bad;
  END IF;
END
$$;
