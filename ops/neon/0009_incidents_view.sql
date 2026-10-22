-- Incidents READ VIEW for the Studio read role (Fable condition 2, 21 Oct M1 ruling), step 1 of 2: ADDITIVE ONLY.
-- Adds studio_ro.incident_register (status, polarity, severity, submitted_at: exactly what the incident_summary and
-- overview_counts tools select) and grants it to studio_gov_ro. It revokes NOTHING, so the currently deployed agent
-- (which still reads public.incidents) keeps working. Run order: 0009 -> deploy the agent that reads the view -> 0010.
-- Run ONLY as the database OWNER over the DIRECT url, AFTER 0003_studio_views.sql:
--   SQL_FILE=ops/neon/0009_incidents_view.sql ops/neon/run-roles.sh OWNER_URL_FILE
-- Idempotent, ONE transaction. NOT RUN by the builder.
--
-- Left out of the view: narrative, category, evidence_urls, reporter name/email, patient_ref, ratings, submitter ids,
-- target_physician_id, the anonymous flag, ip, retraction reason (0003 physician_feedback keeps its own bucketed form).
-- 0001_roles.sql no longer grants public.incidents; 0010_incidents_revoke.sql removes it from a database that has it.
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
    RAISE EXCEPTION 'run 0009_incidents_view.sql as the database owner, not a superuser: refusing';
  END IF;
  IF me.rolname IN ('studio_gov_ro', 'studio_app') THEN
    RAISE EXCEPTION 'run 0009_incidents_view.sql as the database owner, not a Studio role: refusing';
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

CREATE OR REPLACE VIEW studio_ro.incident_register WITH (security_barrier = true) AS
SELECT i.status, i.polarity, i.severity, i.submitted_at
FROM public.incidents i;

-- Revoke from EVERY grantee other than the owner on THIS view only, then grant the Studio read role SELECT.
DO $$
DECLARE
  g record;
BEGIN
  FOR g IN
    SELECT c.oid::regclass AS rel, a.grantee
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, LATERAL aclexplode(c.relacl) a
    WHERE n.nspname = 'studio_ro' AND c.relkind = 'v' AND a.grantee <> c.relowner AND c.relname = 'incident_register'
  LOOP
    IF g.grantee = 0 THEN
      EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', g.rel);
    ELSE
      EXECUTE format('REVOKE ALL ON %s FROM %I', g.rel, pg_get_userbyid(g.grantee));
    END IF;
  END LOOP;
END
$$;
GRANT USAGE ON SCHEMA studio_ro TO studio_gov_ro;
GRANT SELECT ON studio_ro.incident_register TO studio_gov_ro;

-- POST-CHECK (same transaction): no membership, exact ACLs on every studio_ro view, the view readable, its columns
-- exactly the list. (The base-table assertion lives in 0010: this file leaves public.incidents as it found it.)
DO $$
DECLARE
  bad text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'studio_gov_ro') THEN
    RAISE EXCEPTION 'studio_gov_ro is a member of another role: rolling back';
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
