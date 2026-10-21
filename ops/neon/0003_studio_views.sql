-- Column-scoped READ VIEWS for the Studio read role (studio_gov_ro): Physician 360, OPD governance and
-- Patient feedback. Run ONLY as the database OWNER over the DIRECT url, after 0001_roles.sql:
--   SQL_FILE=ops/neon/0003_studio_views.sql ops/neon/run-roles.sh OWNER_URL_FILE
-- (the file name is 0003 by order; it is not 0003_login.sql, which run-roles.sh --login selects by name).
-- Idempotent and re-runnable; ONE transaction (psql --single-transaction): a failure rolls everything back.
--
-- Design: the role gets USAGE on schema studio_ro and SELECT on the views below, and NOTHING on the base
-- tables. The views are owned by the owner (security_invoker is NOT set, so the owner's rights read the
-- base tables) and are security_barrier. Free-text columns are never selected: no reply text, decision
-- notes, withdrawal reasons, packet payloads, certificate files, narratives, reporter details, notes,
-- source file names, or user ids of staff. Columns left out on purpose are listed per view.
\set ECHO none
\set QUIET on
\set ON_ERROR_STOP on

-- PREFLIGHT: not a superuser (a view owned by a superuser would be a standing bypass), not one of the
-- Studio roles themselves, studio_gov_ro must already exist (0001), and an existing studio_ro schema must
-- belong to the executing role.
DO $$
DECLARE
  me pg_roles%ROWTYPE;
  sch_owner name;
BEGIN
  SELECT * INTO me FROM pg_roles WHERE rolname = current_user;
  IF me.rolsuper THEN
    RAISE EXCEPTION 'run 0003_studio_views.sql as the database owner, not a superuser: refusing';
  END IF;
  IF me.rolname IN ('studio_gov_ro', 'studio_app') THEN
    RAISE EXCEPTION 'run 0003_studio_views.sql as the database owner, not a Studio role: refusing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_gov_ro') THEN
    RAISE EXCEPTION 'studio_gov_ro does not exist: run 0001_roles.sql first';
  END IF;
  SELECT pg_get_userbyid(nspowner) INTO sch_owner FROM pg_namespace WHERE nspname = 'studio_ro';
  IF sch_owner IS NOT NULL AND sch_owner <> current_user THEN
    RAISE EXCEPTION 'schema studio_ro is owned by another role: refusing';
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS studio_ro;
REVOKE ALL ON SCHEMA studio_ro FROM PUBLIC;

-- DROP + CREATE (not CREATE OR REPLACE) so a re-run can also remove a column; grants are re-applied below.
DROP VIEW IF EXISTS studio_ro.physician_privileges;
DROP VIEW IF EXISTS studio_ro.physician_oppe;
DROP VIEW IF EXISTS studio_ro.physician_metrics;
DROP VIEW IF EXISTS studio_ro.physician_qualifications;
DROP VIEW IF EXISTS studio_ro.capture_gaps;
DROP VIEW IF EXISTS studio_ro.incident_reply_status;
DROP VIEW IF EXISTS studio_ro.physician_feedback;

-- Left out: withdrawn_reason (free text), granted_by (staff id).
CREATE VIEW studio_ro.physician_privileges WITH (security_barrier = true) AS
SELECT p.id AS privilege_id, p.physician_id, h.code AS hospital_code, p.procedure_or_specialty, p.is_core, p.basis,
       p.granted_date, p.expires_at, p.withdrawn_date, p.created_at
FROM public.privileges p
JOIN public.hospitals h ON h.id = p.hospital_id;

-- Left out: packet_jsonb (payload), decision_notes (free text), reviewer_id (staff id).
CREATE VIEW studio_ro.physician_oppe WITH (security_barrier = true) AS
SELECT o.id AS review_id, o.physician_id, h.code AS hospital_code, o.period_start, o.period_end, o.due_at, o.status,
       o.completed_at, o.created_at
FROM public.oppe_reviews o
JOIN public.hospitals h ON h.id = o.hospital_id;

-- Left out: source_file (file name), uploaded_by (staff id).
CREATE VIEW studio_ro.physician_metrics WITH (security_barrier = true) AS
SELECT m.id AS metric_id, m.physician_id, h.code AS hospital_code, m.year, m.month, m.opd_count, m.ipd_admissions,
       m.ot_cases, m.revenue_inr, m.uploaded_at
FROM public.clinical_metrics_monthly m
JOIN public.hospitals h ON h.id = m.hospital_id;

-- Left out: institution (name), file_data (certificate file), verified_by (staff id).
CREATE VIEW studio_ro.physician_qualifications WITH (security_barrier = true) AS
SELECT q.id AS qualification_id, q.physician_id, q.degree, q.institution_tier, q.year_completed, q.country,
       q.verified, q.verified_at, q.created_at
FROM public.qualifications q;

-- Not per physician. Left out: note (free text), source_doc (document name).
CREATE VIEW studio_ro.capture_gaps WITH (security_barrier = true) AS
SELECT g.id AS gap_id, g.title, g.attr, g.status, g.baseline_mean, g.shipped_at, g.created_at
FROM public.gov_capture_gaps g;

-- Counts/status/timestamps only. Left out: reply_text, replied_by_profile_id, replied_by_physician_id.
CREATE VIEW studio_ro.incident_reply_status WITH (security_barrier = true) AS
SELECT r.id AS reply_id, r.incident_id, i.target_physician_id AS physician_id, i.status AS incident_status,
       (r.replied_by_physician_id IS NOT NULL) AS replied_by_physician, r.replied_at
FROM public.incident_replies r
JOIN public.incidents i ON i.id = r.incident_id;

-- Per-physician feedback, aggregated per month. Only: physician id, source, polarity, severity, status,
-- month, count. Left out: narrative, category, evidence_urls, reporter name/email, patient_ref, ratings,
-- commendation_category, submitter ids, the anonymous flag, ip, retraction reason.
CREATE VIEW studio_ro.physician_feedback WITH (security_barrier = true) AS
SELECT i.target_physician_id AS physician_id, i.source, i.polarity, COALESCE(i.severity, 'n/a') AS severity,
       i.status, date_trunc('month', i.submitted_at)::date AS month, count(*)::int AS incidents
FROM public.incidents i
GROUP BY i.target_physician_id, i.source, i.polarity, COALESCE(i.severity, 'n/a'), i.status, date_trunc('month', i.submitted_at)::date;

-- Grants: nothing on the views for anyone but the Studio read role; no grant on any base table.
-- Revoke from EVERY grantee other than the owner (default privileges may have granted to other roles), on
-- THESE seven views only: later slices (0007_docaudits_views.sql) own further studio_ro views and their grants,
-- and re-running this file must not strip them.
DO $$
DECLARE
  g record;
BEGIN
  FOR g IN
    SELECT DISTINCT c.oid::regclass AS rel, a.grantee
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
         LATERAL aclexplode(c.relacl) a
    WHERE n.nspname = 'studio_ro' AND c.relkind = 'v' AND a.grantee <> c.relowner
      AND c.relname IN ('physician_privileges', 'physician_oppe', 'physician_metrics', 'physician_qualifications',
                        'capture_gaps', 'incident_reply_status', 'physician_feedback')
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
GRANT SELECT ON studio_ro.physician_privileges, studio_ro.physician_oppe, studio_ro.physician_metrics,
  studio_ro.physician_qualifications, studio_ro.capture_gaps, studio_ro.incident_reply_status,
  studio_ro.physician_feedback TO studio_gov_ro;

-- POST-CHECK (same transaction): the role holds no new membership, no privilege on the six new base
-- tables, and no column of any studio_ro view is an obvious free-text column name.
DO $$
DECLARE
  t text;
  bad text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'studio_gov_ro') THEN
    RAISE EXCEPTION 'studio_gov_ro is a member of another role: rolling back';
  END IF;
  FOREACH t IN ARRAY ARRAY['privileges', 'oppe_reviews', 'clinical_metrics_monthly', 'qualifications', 'gov_capture_gaps', 'incident_replies'] LOOP
    IF has_any_column_privilege('studio_gov_ro', format('public.%I', t)::regclass, 'SELECT') THEN
      RAISE EXCEPTION 'studio_gov_ro can read base table %: rolling back', t;
    END IF;
  END LOOP;
  -- Exact ACLs: every studio_ro view is held by the owner and, for SELECT only, by studio_gov_ro.
  SELECT string_agg(c.relname || ' -> ' || coalesce(pg_get_userbyid(NULLIF(a.grantee, 0)), 'PUBLIC'), ', ') INTO bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, LATERAL aclexplode(c.relacl) a
  WHERE n.nspname = 'studio_ro' AND c.relkind = 'v' AND a.grantee <> c.relowner
    AND NOT (pg_get_userbyid(a.grantee) = 'studio_gov_ro' AND a.privilege_type = 'SELECT');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'studio_ro view has an unexpected grant (%): rolling back', bad;
  END IF;
  SELECT string_agg(c.relname || '.' || a.attname, ', ') INTO bad
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'studio_ro' AND a.attnum > 0 AND NOT a.attisdropped
    AND a.attname ~ '(text|note|reason|narrative|email|phone|name|url|payload|packet|file|reply$)';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'studio_ro exposes a column that looks like free text or contact data (%): rolling back', bad;
  END IF;
END
$$;
