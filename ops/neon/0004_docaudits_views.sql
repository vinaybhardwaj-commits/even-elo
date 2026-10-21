-- Column-scoped READ VIEWS for the Studio read role (studio_gov_ro): Document audits (document_audits and
-- document_audit_findings). Run ONLY as the database OWNER over the DIRECT url, after 0001_roles.sql:
--   SQL_FILE=ops/neon/0004_docaudits_views.sql ops/neon/run-roles.sh OWNER_URL_FILE
-- (0004 by slice order; it is not 0004_nologin.sql, which run-roles.sh --nologin selects by name).
-- Same design as 0003_studio_views.sql (independent of it: it only touches its own two views, so either
-- order is safe). Idempotent, ONE transaction. NOT RUN by the builder.
--
-- The role gets USAGE on schema studio_ro and SELECT on the two views, and NOTHING on the base tables.
-- Views are owner-owned (security_invoker NOT set) and security_barrier.
-- Left out on purpose (free text, contact data, staff identity, URLs): finding_body, doctor_response_comment,
-- evidence_excerpt, citations_json, patient_json, cdmss_sync_error, content_hash, queue_item_ref,
-- authored_by_name and authored_by_profile_id (the RMO; only a boolean author_confirmed is exposed),
-- cdmss_pdf_url (only a boolean has_pdf), doctor_uid, source_audit_id, doctor-side text of any kind.
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
    RAISE EXCEPTION 'run 0004_docaudits_views.sql as the database owner, not a superuser: refusing';
  END IF;
  IF me.rolname IN ('studio_gov_ro', 'studio_app') THEN
    RAISE EXCEPTION 'run 0004_docaudits_views.sql as the database owner, not a Studio role: refusing';
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

DROP VIEW IF EXISTS studio_ro.document_audit_finding_list;
DROP VIEW IF EXISTS studio_ro.document_audit_list;

CREATE VIEW studio_ro.document_audit_list WITH (security_barrier = true) AS
SELECT d.id AS audit_id, d.external_ref, d.hospital_code, d.physician_id, d.doc_type, d.note_date AS doc_day,
       d.ingested_at, d.last_synced_at, d.triage_routed_at, d.note_class AS doc_class,
       (d.cdmss_pdf_url IS NOT NULL AND d.cdmss_pdf_url ~* '^https?://') AS has_pdf, d.source, d.created_at
FROM public.document_audits d;

CREATE VIEW studio_ro.document_audit_finding_list WITH (security_barrier = true) AS
SELECT f.id AS finding_id, f.audit_id, f.physician_id, f.finding_label, f.severity, f.status,
       (f.authored_by_name <> 'CDMSS audit (pending RMO review)') AS author_confirmed, f.authored_at,
       f.recurrence_count, f.portal_visible, f.response_owner, f.signal_reference, f.signal_type,
       f.note_class AS doc_class, f.cdmss_routed, f.doctor_response_verb AS response_verb,
       f.doctor_responded_at AS responded_at, f.cdmss_sync_state AS sync_state,
       f.cdmss_sync_attempts AS sync_attempts, f.cdmss_sync_permanent AS sync_permanent, f.created_at
FROM public.document_audit_findings f;

-- Revoke from every grantee of THESE two views other than the owner, then grant to the Studio read role only.
DO $$
DECLARE
  g record;
BEGIN
  FOR g IN
    SELECT DISTINCT c.oid::regclass AS rel, a.grantee
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
         LATERAL aclexplode(c.relacl) a
    WHERE n.nspname = 'studio_ro' AND c.relkind = 'v'
      AND c.relname IN ('document_audit_list', 'document_audit_finding_list') AND a.grantee <> c.relowner
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
GRANT SELECT ON studio_ro.document_audit_list, studio_ro.document_audit_finding_list TO studio_gov_ro;

-- POST-CHECK (same transaction).
DO $$
DECLARE
  t text;
  bad text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'studio_gov_ro') THEN
    RAISE EXCEPTION 'studio_gov_ro is a member of another role: rolling back';
  END IF;
  FOREACH t IN ARRAY ARRAY['document_audits', 'document_audit_findings'] LOOP
    IF has_any_column_privilege('studio_gov_ro', format('public.%I', t)::regclass, 'SELECT') THEN
      RAISE EXCEPTION 'studio_gov_ro can read base table %: rolling back', t;
    END IF;
  END LOOP;
  SELECT string_agg(c.relname || ' -> ' || coalesce(pg_get_userbyid(NULLIF(a.grantee, 0)), 'PUBLIC'), ', ') INTO bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, LATERAL aclexplode(c.relacl) a
  WHERE n.nspname = 'studio_ro' AND c.relkind = 'v' AND c.relname IN ('document_audit_list', 'document_audit_finding_list')
    AND a.grantee <> c.relowner
    AND NOT (pg_get_userbyid(a.grantee) = 'studio_gov_ro' AND a.privilege_type = 'SELECT');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'document-audit view has an unexpected grant (%): rolling back', bad;
  END IF;
  SELECT string_agg(c.relname || '.' || a.attname, ', ') INTO bad
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'studio_ro' AND c.relname IN ('document_audit_list', 'document_audit_finding_list')
    AND a.attnum > 0 AND NOT a.attisdropped
    AND a.attname ~ '(text|note|reason|narrative|email|phone|name|url|payload|packet|file|reply$)';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'document-audit view exposes a column that looks like free text or contact data (%): rolling back', bad;
  END IF;
END
$$;
