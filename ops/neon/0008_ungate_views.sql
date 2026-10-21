-- UNGATE (V, 21 Oct: "Everything stays in. Governance has no doctor or PHI gating."): appends the free-text
-- columns the source pages show to the 0003 studio_ro views. Run ONLY as the database OWNER over the DIRECT url,
-- AFTER 0003_studio_views.sql (and 0007_docaudits_views.sql):
--   SQL_FILE=ops/neon/0008_ungate_views.sql ops/neon/run-roles.sh OWNER_URL_FILE
-- Idempotent, ONE transaction. NOT RUN by the builder.
--
-- CREATE OR REPLACE VIEW appends columns AT THE END only, so the existing columns, owner, security_barrier option
-- and the SELECT grant to studio_gov_ro are kept. Each view is replaced with its 0003 column list unchanged,
-- plus the new columns. The role still gets NOTHING on any base table.
-- Re-running 0003 drops and recreates these views WITHOUT the new columns: run 0008 again after it.
-- Not exposed (staff ids, file payloads, no screen reads them): granted_by, reviewer_id, packet_jsonb,
-- source_file, uploaded_by, file_data, verified_by, replied_by_profile_id, replied_by_physician_id.
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
    RAISE EXCEPTION 'run 0008_ungate_views.sql as the database owner, not a superuser: refusing';
  END IF;
  IF me.rolname IN ('studio_gov_ro', 'studio_app') THEN
    RAISE EXCEPTION 'run 0008_ungate_views.sql as the database owner, not a Studio role: refusing';
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

CREATE OR REPLACE VIEW studio_ro.physician_privileges WITH (security_barrier = true) AS
SELECT p.id AS privilege_id, p.physician_id, h.code AS hospital_code, p.procedure_or_specialty, p.is_core, p.basis,
       p.granted_date, p.expires_at, p.withdrawn_date, p.created_at,
       p.withdrawn_reason
FROM public.privileges p
JOIN public.hospitals h ON h.id = p.hospital_id;

CREATE OR REPLACE VIEW studio_ro.physician_oppe WITH (security_barrier = true) AS
SELECT o.id AS review_id, o.physician_id, h.code AS hospital_code, o.period_start, o.period_end, o.due_at, o.status,
       o.completed_at, o.created_at,
       o.decision_notes
FROM public.oppe_reviews o
JOIN public.hospitals h ON h.id = o.hospital_id;

CREATE OR REPLACE VIEW studio_ro.physician_qualifications WITH (security_barrier = true) AS
SELECT q.id AS qualification_id, q.physician_id, q.degree, q.institution_tier, q.year_completed, q.country,
       q.verified, q.verified_at, q.created_at,
       q.institution
FROM public.qualifications q;

CREATE OR REPLACE VIEW studio_ro.capture_gaps WITH (security_barrier = true) AS
SELECT g.id AS gap_id, g.title, g.attr, g.status, g.baseline_mean, g.shipped_at, g.created_at,
       g.note, g.source_doc
FROM public.gov_capture_gaps g;

CREATE OR REPLACE VIEW studio_ro.incident_reply_status WITH (security_barrier = true) AS
SELECT r.id AS reply_id, r.incident_id, i.target_physician_id AS physician_id, i.status AS incident_status,
       (r.replied_by_physician_id IS NOT NULL) AS replied_by_physician, r.replied_at,
       r.reply_text
FROM public.incident_replies r
JOIN public.incidents i ON i.id = r.incident_id;

-- POST-CHECK (same transaction): no membership, no base-table privilege, exact ACLs on every studio_ro view,
-- and the appended columns are exactly the reviewed list.
DO $$
DECLARE
  t text;
  bad text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'studio_gov_ro') THEN
    RAISE EXCEPTION 'studio_gov_ro is a member of another role: rolling back';
  END IF;
  FOREACH t IN ARRAY ARRAY['privileges', 'oppe_reviews', 'clinical_metrics_monthly', 'qualifications', 'gov_capture_gaps', 'incident_replies',
                           'document_audits', 'document_audit_findings'] LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL AND has_any_column_privilege('studio_gov_ro', format('public.%I', t)::regclass, 'SELECT') THEN
      RAISE EXCEPTION 'studio_gov_ro can read base table %: rolling back', t;
    END IF;
  END LOOP;
  SELECT string_agg(c.relname || ' -> ' || coalesce(pg_get_userbyid(NULLIF(a.grantee, 0)), 'PUBLIC'), ', ') INTO bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, LATERAL aclexplode(c.relacl) a
  WHERE n.nspname = 'studio_ro' AND c.relkind = 'v' AND a.grantee <> c.relowner
    AND NOT (pg_get_userbyid(a.grantee) = 'studio_gov_ro' AND a.privilege_type = 'SELECT');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'studio_ro view has an unexpected grant (%): rolling back', bad;
  END IF;
  -- Every replaced view must still be readable by the Studio role.
  FOREACH t IN ARRAY ARRAY['physician_privileges', 'physician_oppe', 'physician_qualifications', 'capture_gaps', 'incident_reply_status'] LOOP
    IF NOT has_table_privilege('studio_gov_ro', format('studio_ro.%I', t)::regclass, 'SELECT') THEN
      RAISE EXCEPTION 'studio_gov_ro lost SELECT on studio_ro.%: rolling back', t;
    END IF;
  END LOOP;
  -- Explicit allowlist of the columns this file appended (any other column of these views is the 0003 list).
  SELECT string_agg(c.relname || '.' || a.attname, ', ') INTO bad
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'studio_ro' AND a.attnum > 0 AND NOT a.attisdropped
    AND c.relname IN ('physician_privileges', 'physician_oppe', 'physician_qualifications', 'capture_gaps', 'incident_reply_status')
    AND a.attname ~ '(text|note|reason|narrative|email|phone|name|url|payload|packet|file|reply$|institution$|source_doc)'
    AND (c.relname || '.' || a.attname) NOT IN (
      'physician_privileges.withdrawn_reason', 'physician_oppe.decision_notes', 'physician_qualifications.institution',
      'capture_gaps.note', 'capture_gaps.source_doc', 'incident_reply_status.reply_text');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'studio_ro exposes a free-text or contact column outside the reviewed list (%): rolling back', bad;
  END IF;
END
$$;
