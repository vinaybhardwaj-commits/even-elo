-- DB13 extract destination (V's pivot, 22 Oct 2026; fable G-D3/G-D4): schema studio_dw in the governance Neon DB,
-- written ONLY by role studio_dw_writer (NOLOGIN here; the password comes from the Neon API later and LOGIN is a
-- separate step, same as studio_gov_ro in 0001). Screens/chat read ONLY the column-scoped studio_ro.dw_* views.
-- Run ONLY as the database OWNER over the DIRECT url, AFTER 0001 and 0003 (needs studio_gov_ro and schema studio_ro):
--   SQL_FILE=ops/neon/0012_studio_dw.sql ops/neon/run-roles.sh OWNER_URL_FILE
-- Idempotent, ONE transaction. NOT RUN by the builder. Additive column changes need a new numbered file.
--
-- The table definitions below are GENERATED from ops/db13/extract/spec.py (tests compare them): columns are the
-- catalogue-named DB13 columns plus _run_id (provenance stamp, hidden from the views).
-- studio_dw_writer gets SELECT as well as INSERT/UPDATE/DELETE on studio_dw tables ONLY: Postgres needs SELECT on
-- the conflict-target columns for INSERT .. ON CONFLICT DO UPDATE and for DELETE .. WHERE. Nothing else, anywhere.
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
    RAISE EXCEPTION 'run 0012_studio_dw.sql as the database owner, not a superuser: refusing';
  END IF;
  IF me.rolname IN ('studio_gov_ro', 'studio_app', 'studio_dw_writer') THEN
    RAISE EXCEPTION 'run 0012_studio_dw.sql as the database owner, not a Studio role: refusing';
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
  -- An existing writer that is a member of any role (neon_superuser, from the API) is refused.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_dw_writer')
     AND EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'studio_dw_writer') THEN
    RAISE EXCEPTION 'studio_dw_writer is already a member of another role (neon_superuser?): refusing; drop it and rerun';
  END IF;
END
$$;

-- 1. The writer role, created BY SQL, NOLOGIN, no password clause, no memberships.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_dw_writer') THEN
    CREATE ROLE studio_dw_writer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
  END IF;
END
$$;

DO $$
DECLARE
  me pg_roles%ROWTYPE;
  opts text := 'NOINHERIT NOCREATEROLE CONNECTION LIMIT 2';
BEGIN
  SELECT * INTO me FROM pg_roles WHERE rolname = current_user;
  IF me.rolsuper OR me.rolcreatedb THEN opts := opts || ' NOCREATEDB'; END IF;
  IF me.rolsuper OR me.rolreplication THEN opts := opts || ' NOREPLICATION'; END IF;
  IF me.rolsuper OR me.rolbypassrls THEN opts := opts || ' NOBYPASSRLS'; END IF;
  EXECUTE 'ALTER ROLE studio_dw_writer ' || opts;
END
$$;
ALTER ROLE studio_dw_writer SET statement_timeout = '60s';
ALTER ROLE studio_dw_writer SET idle_in_transaction_session_timeout = '30s';

-- Start from nothing everywhere the owner controls.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM studio_dw_writer;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM studio_dw_writer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM studio_dw_writer;
REVOKE ALL ON SCHEMA public FROM studio_dw_writer;
REVOKE ALL ON SCHEMA studio_ro FROM studio_dw_writer;
REVOKE ALL ON ALL TABLES IN SCHEMA studio_ro FROM studio_dw_writer;

-- 2. Schema + tables (owner-owned).
CREATE SCHEMA IF NOT EXISTS studio_dw;
REVOKE ALL ON SCHEMA studio_dw FROM PUBLIC;
REVOKE ALL ON SCHEMA studio_dw FROM studio_gov_ro;
GRANT USAGE ON SCHEMA studio_dw TO studio_dw_writer;

-- Provenance. One row per run (extract_runs) and one per table per run (extract_run_tables): each table is read in
-- its OWN read-only DB13 transaction, so each has its own snapshot ("DB13 as of" is per table; extract_runs keeps the
-- oldest). started/ended are the Neon clock; db13_snapshot_now / db13_snapshot are SELECT now() and
-- pg_current_snapshot() taken inside that table's transaction. watermark_to of the latest ok row is the next
-- incremental run's lower bound for that table (a timeout/failed/skipped table never advances it).
-- run status: ok | partial (a table timed out or a large table was skipped) | failed | killed (signal).
CREATE TABLE IF NOT EXISTS studio_dw.extract_runs (
  run_id uuid PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('incremental', 'full')),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  status text NOT NULL CHECK (status IN ('running', 'ok', 'partial', 'failed', 'killed')),
  db13_snapshot_now timestamptz,
  rows jsonb,
  queries integer,
  error_class text
);

CREATE TABLE IF NOT EXISTS studio_dw.extract_run_tables (
  run_id uuid NOT NULL REFERENCES studio_dw.extract_runs (run_id) ON DELETE CASCADE,
  table_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'ok', 'timeout', 'skipped', 'failed', 'killed')),
  started_at timestamptz,
  ended_at timestamptz,
  db13_snapshot_now timestamptz,
  db13_snapshot text,
  rows_read integer,
  fetches integer,
  txn_seconds numeric,
  watermark_from timestamptz,
  watermark_to timestamptz,
  error_class text,
  PRIMARY KEY (run_id, table_name)
);

CREATE TABLE IF NOT EXISTS studio_dw.individuals_prescriptions (
  "_id" text PRIMARY KEY,
  "_parent_id" text,
  "uid" text,
  "consult_uid" text,
  "kx_encounter_id" text,
  "doctor_uid" text,
  "timestamp" timestamptz,
  "uploaded_at" timestamptz,
  "is_draft" boolean,
  "type_of_prescription" text,
  "consult_type" text,
  "consult_types" text[],
  "medications" jsonb,
  "diagnosis_icd_codes" text[],
  "impression_icd_codes" text[],
  "further_investigation" jsonb,
  _run_id uuid NOT NULL
);

CREATE TABLE IF NOT EXISTS studio_dw.dpipe_prescription_pipeline (
  "presc_uid" text PRIMARY KEY,
  "individual_uid" text,
  "age" integer,
  "timestamp" timestamptz,
  "uploaded_at" timestamptz,
  "presc_is_draft" boolean,
  "consult_type" text,
  "diagnosis" jsonb,
  "medicines" jsonb,
  "further_investigation" jsonb,
  _run_id uuid NOT NULL
);

CREATE TABLE IF NOT EXISTS studio_dw.dpipe_prescription_diagnosis (
  "_parent_id" text,
  "diagnosis" text,
  "icd_code" text,
  _run_id uuid NOT NULL
);
CREATE INDEX IF NOT EXISTS dpipe_prescription_diagnosis_run_idx ON studio_dw.dpipe_prescription_diagnosis (_run_id);

CREATE TABLE IF NOT EXISTS studio_dw.kx_ip_admissions (
  "_id" text PRIMARY KEY,
  "uid" text,
  "encounter_id" text,
  "current_treating_doctor_id" text,
  "facility_name" text,
  "admission_date_time" timestamptz,
  "encounter_type" text,
  _run_id uuid NOT NULL
);

CREATE TABLE IF NOT EXISTS studio_dw.kx_discharged_completed_patients (
  "_id" text PRIMARY KEY,
  "uid" text,
  "encounter_id" text,
  "uhid" text,
  "encounter_type" text,
  "facility_name" text,
  "discharge_date" timestamptz,
  "treating_sub_department_name" text,
  "discharge_type_value" text,
  "admission_date_time" timestamptz,
  "status" text,
  _run_id uuid NOT NULL
);

CREATE TABLE IF NOT EXISTS studio_dw.kx_billing_records (
  "_id" text PRIMARY KEY,
  "uid" text,
  "uhid" text,
  "patient_type" text,
  "bill_date_time" timestamptz,
  _run_id uuid NOT NULL
);

CREATE TABLE IF NOT EXISTS studio_dw.surgery_cases (
  "uid" text PRIMARY KEY,
  "individual_uid" text,
  "status" text,
  "created_at" timestamptz,
  "prescribed_at" timestamptz,
  "planned_surgery_date" date,
  "hospital_info__hospital_uid" text,
  _run_id uuid NOT NULL
);

CREATE TABLE IF NOT EXISTS studio_dw.doctors (
  "uid" text PRIMARY KEY,
  "karexpert_metadata__uid" text,
  "karexpert_metadata__practitioner_id" text,
  "karexpert_metadata__practitioner_id_by_hospital" jsonb,
  _run_id uuid NOT NULL
);

REVOKE ALL ON ALL TABLES IN SCHEMA studio_dw FROM studio_dw_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA studio_dw TO studio_dw_writer;

-- 3. Column-scoped views for Studio (the ONLY thing studio_gov_ro reads of this data).
CREATE OR REPLACE VIEW studio_ro.dw_individuals_prescriptions WITH (security_barrier = true) AS
SELECT d."_id", d."_parent_id", d."uid", d."consult_uid", d."kx_encounter_id", d."doctor_uid", d."timestamp", d."uploaded_at", d."is_draft", d."type_of_prescription", d."consult_type", d."consult_types", d."medications", d."diagnosis_icd_codes", d."impression_icd_codes", d."further_investigation"
FROM studio_dw.individuals_prescriptions d;

CREATE OR REPLACE VIEW studio_ro.dw_dpipe_prescription_pipeline WITH (security_barrier = true) AS
SELECT d."presc_uid", d."individual_uid", d."age", d."timestamp", d."uploaded_at", d."presc_is_draft", d."consult_type", d."diagnosis", d."medicines", d."further_investigation"
FROM studio_dw.dpipe_prescription_pipeline d;

-- Child table: replaced wholesale each run, so show only the newest run that finished ok.
CREATE OR REPLACE VIEW studio_ro.dw_dpipe_prescription_diagnosis WITH (security_barrier = true) AS
SELECT d."_parent_id", d."diagnosis", d."icd_code"
FROM studio_dw.dpipe_prescription_diagnosis d
WHERE d._run_id = (SELECT x.run_id FROM studio_dw.extract_run_tables x
                   WHERE x.table_name = 'dpipe_prescription_diagnosis' AND x.status = 'ok' ORDER BY x.ended_at DESC LIMIT 1);

CREATE OR REPLACE VIEW studio_ro.dw_kx_ip_admissions WITH (security_barrier = true) AS
SELECT d."_id", d."uid", d."encounter_id", d."current_treating_doctor_id", d."facility_name", d."admission_date_time", d."encounter_type"
FROM studio_dw.kx_ip_admissions d;

CREATE OR REPLACE VIEW studio_ro.dw_kx_discharged_completed_patients WITH (security_barrier = true) AS
SELECT d."_id", d."uid", d."encounter_id", d."uhid", d."encounter_type", d."facility_name", d."discharge_date", d."treating_sub_department_name", d."discharge_type_value", d."admission_date_time", d."status"
FROM studio_dw.kx_discharged_completed_patients d;

CREATE OR REPLACE VIEW studio_ro.dw_kx_billing_records WITH (security_barrier = true) AS
SELECT d."_id", d."uid", d."uhid", d."patient_type", d."bill_date_time"
FROM studio_dw.kx_billing_records d;

CREATE OR REPLACE VIEW studio_ro.dw_surgery_cases WITH (security_barrier = true) AS
SELECT d."uid", d."individual_uid", d."status", d."created_at", d."prescribed_at", d."planned_surgery_date", d."hospital_info__hospital_uid"
FROM studio_dw.surgery_cases d;

CREATE OR REPLACE VIEW studio_ro.dw_doctors WITH (security_barrier = true) AS
SELECT d."uid", d."karexpert_metadata__uid", d."karexpert_metadata__practitioner_id", d."karexpert_metadata__practitioner_id_by_hospital"
FROM studio_dw.doctors d;

-- "DB13 as of <extract time>": recent runs and their per-table snapshots; no error text, no snapshot internals.
CREATE OR REPLACE VIEW studio_ro.dw_extract_status WITH (security_barrier = true) AS
SELECT run_id, mode, status, started_at, ended_at, db13_snapshot_now, rows
FROM (SELECT * FROM studio_dw.extract_runs ORDER BY started_at DESC LIMIT 30) r;

CREATE OR REPLACE VIEW studio_ro.dw_extract_tables WITH (security_barrier = true) AS
SELECT t.run_id, t.table_name, t.status, t.started_at, t.ended_at, t.db13_snapshot_now, t.rows_read, t.fetches, t.txn_seconds
FROM studio_dw.extract_run_tables t
WHERE t.run_id IN (SELECT run_id FROM studio_dw.extract_runs ORDER BY started_at DESC LIMIT 30);

GRANT USAGE ON SCHEMA studio_ro TO studio_gov_ro;
GRANT SELECT ON studio_ro.dw_extract_status, studio_ro.dw_extract_tables, studio_ro.dw_individuals_prescriptions, studio_ro.dw_dpipe_prescription_pipeline, studio_ro.dw_dpipe_prescription_diagnosis, studio_ro.dw_kx_ip_admissions, studio_ro.dw_kx_discharged_completed_patients, studio_ro.dw_kx_billing_records, studio_ro.dw_surgery_cases, studio_ro.dw_doctors TO studio_gov_ro;

-- 4. POST-CHECK (same transaction): any leak rolls everything back.
DO $$
DECLARE
  t text;
  bad text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname IN ('studio_gov_ro', 'studio_dw_writer')) THEN
    RAISE EXCEPTION 'a Studio role is a member of another role: rolling back';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_dw_writer' AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'studio_dw_writer has a privileged attribute: rolling back';
  END IF;

  -- studio_gov_ro: nothing in studio_dw, SELECT on every dw view.
  IF has_schema_privilege('studio_gov_ro', 'studio_dw', 'USAGE') OR has_schema_privilege('studio_gov_ro', 'studio_dw', 'CREATE') THEN
    RAISE EXCEPTION 'studio_gov_ro has a privilege on schema studio_dw: rolling back';
  END IF;
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'studio_dw' AND c.relkind IN ('r', 'v', 'm', 'p') LOOP
    IF has_any_column_privilege('studio_gov_ro', format('studio_dw.%I', t)::regclass, 'SELECT') THEN
      RAISE EXCEPTION 'studio_gov_ro can read studio_dw.%: rolling back', t;
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['individuals_prescriptions', 'dpipe_prescription_pipeline', 'dpipe_prescription_diagnosis', 'kx_ip_admissions', 'kx_discharged_completed_patients', 'kx_billing_records', 'surgery_cases', 'doctors'] LOOP
    IF NOT has_table_privilege('studio_gov_ro', format('studio_ro.dw_%s', t)::regclass, 'SELECT') THEN
      RAISE EXCEPTION 'studio_gov_ro lost SELECT on studio_ro.dw_%: rolling back', t;
    END IF;
  END LOOP;
  IF NOT has_table_privilege('studio_gov_ro', 'studio_ro.dw_extract_status'::regclass, 'SELECT')
     OR NOT has_table_privilege('studio_gov_ro', 'studio_ro.dw_extract_tables'::regclass, 'SELECT') THEN
    RAISE EXCEPTION 'studio_gov_ro cannot read the studio_ro extract status views: rolling back';
  END IF;
  -- exact ACLs on the dw views (owner + studio_gov_ro SELECT only)
  SELECT string_agg(c.relname || ' -> ' || coalesce(pg_get_userbyid(NULLIF(a.grantee, 0)), 'PUBLIC'), ', ') INTO bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, LATERAL aclexplode(c.relacl) a
  WHERE n.nspname = 'studio_ro' AND c.relkind = 'v' AND c.relname LIKE 'dw\_%' AND a.grantee <> c.relowner
    AND NOT (pg_get_userbyid(a.grantee) = 'studio_gov_ro' AND a.privilege_type = 'SELECT');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'a studio_ro dw view has an unexpected grant (%): rolling back', bad;
  END IF;
  -- the views never expose the provenance stamp
  IF EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'studio_ro' AND c.relname LIKE 'dw\_%' AND a.attname = '_run_id' AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'a studio_ro dw view exposes _run_id: rolling back';
  END IF;

  -- studio_dw_writer: only SELECT/INSERT/UPDATE/DELETE on studio_dw tables; nothing anywhere else.
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ') INTO bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f', 'S')
    AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'studio_dw') AND n.nspname NOT LIKE 'pg\_toast%' AND n.nspname NOT LIKE 'pg\_temp%'
    AND (has_any_column_privilege('studio_dw_writer', c.oid, 'SELECT')
         OR has_any_column_privilege('studio_dw_writer', c.oid, 'INSERT')
         OR has_any_column_privilege('studio_dw_writer', c.oid, 'UPDATE')
         OR has_any_column_privilege('studio_dw_writer', c.oid, 'REFERENCES')
         OR (c.relkind <> 'S' AND (has_table_privilege('studio_dw_writer', c.oid, 'DELETE')
                                    OR has_table_privilege('studio_dw_writer', c.oid, 'TRUNCATE')
                                    OR has_table_privilege('studio_dw_writer', c.oid, 'TRIGGER')))
         OR (c.relkind = 'S' AND has_sequence_privilege('studio_dw_writer', c.oid, 'USAGE')));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'studio_dw_writer holds a privilege outside studio_dw: % (rolling back)', bad;
  END IF;
  SELECT string_agg(c.relname, ', ') INTO bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'studio_dw' AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
    AND (NOT (has_table_privilege('studio_dw_writer', c.oid, 'SELECT') AND has_table_privilege('studio_dw_writer', c.oid, 'INSERT')
              AND has_table_privilege('studio_dw_writer', c.oid, 'UPDATE') AND has_table_privilege('studio_dw_writer', c.oid, 'DELETE'))
         OR has_table_privilege('studio_dw_writer', c.oid, 'TRUNCATE') OR has_table_privilege('studio_dw_writer', c.oid, 'REFERENCES')
         OR has_table_privilege('studio_dw_writer', c.oid, 'TRIGGER'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'studio_dw_writer privileges on studio_dw are not exactly SELECT/INSERT/UPDATE/DELETE: % (rolling back)', bad;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema'
             AND has_schema_privilege('studio_dw_writer', oid, 'CREATE')) THEN
    RAISE EXCEPTION 'studio_dw_writer can CREATE in a schema: rolling back';
  END IF;
  IF has_database_privilege('studio_dw_writer', current_database(), 'CREATE') THEN
    RAISE EXCEPTION 'studio_dw_writer can CREATE in the database: rolling back';
  END IF;
END
$$;
-- The role stays NOLOGIN. Its password is issued by the Neon API (neon-role.sh) and LOGIN enabled afterwards,
-- exactly as for studio_gov_ro; the Mini keeps the resulting DSN in a 0600 file.
