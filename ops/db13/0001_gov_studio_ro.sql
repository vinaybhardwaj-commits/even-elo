-- 0001_gov_studio_ro.sql  (DB13, PostgreSQL 17)
-- Run ONCE by Even IT (Shubh) as the DB13 admin, in the DB13 database:
--     psql -X -v ON_ERROR_STOP=1 -f 0001_gov_studio_ro.sql "host=... dbname=<DB13 db> user=<admin>"
-- Ruling: fable G-D1..G-D5 (22 Oct 2026). Everything is one transaction; the
-- post-check at the end RAISES (and so rolls everything back) if the role can
-- read anything in public or holds any write privilege.
--
-- NO PASSWORD IS SET HERE. After this file succeeds, set it yourself:
--     \password gov_studio_ro          (psql hashes client-side; SCRAM verifier only)
-- or, on Cloud SQL, use IAM database authentication. Never send a plaintext password through SQL.
-- If the role was created through gcloud / the console instead, run:
--     REVOKE cloudsqlsuperuser FROM gov_studio_ro;
-- (this file never grants it; the post-check fails if the role is a member of ANY role).
--
-- Views are owned by the admin running this file, so the role needs no grant on
-- public tables. Each view lists ONLY columns named by METRIC-CATALOGUE-v1; a
-- column outside the catalogue needs a catalogue entry first (G-D4).

BEGIN;

-- 1. Role (idempotent) ------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gov_studio_ro') THEN
    CREATE ROLE gov_studio_ro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3;
  END IF;
END $$;

ALTER ROLE gov_studio_ro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3;
ALTER ROLE gov_studio_ro SET default_transaction_read_only = on;
ALTER ROLE gov_studio_ro SET statement_timeout = '60s';
ALTER ROLE gov_studio_ro SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE gov_studio_ro SET search_path = gov_studio;

-- 2. CONNECT on this database only -----------------------------------------
-- (PUBLIC normally has CONNECT on every database; see the check query at the
--  bottom of this file for the others. Revoking PUBLIC here would affect other
--  people's roles, so it is left to Even IT.)
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO gov_studio_ro', current_database());
  EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM gov_studio_ro', current_database());
END $$;

-- 3. Nothing in public ------------------------------------------------------
REVOKE ALL ON SCHEMA public FROM gov_studio_ro;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM gov_studio_ro;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM gov_studio_ro;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM gov_studio_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM gov_studio_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM gov_studio_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM gov_studio_ro;

-- 4. Schema gov_studio (owned by the admin running this file) -----------------
CREATE SCHEMA IF NOT EXISTS gov_studio;
REVOKE ALL ON SCHEMA gov_studio FROM PUBLIC;
GRANT USAGE ON SCHEMA gov_studio TO gov_studio_ro;

-- 5. Views (dropped and recreated so the column list is always exactly this file)
DROP VIEW IF EXISTS gov_studio.v_individuals_prescriptions;
DROP VIEW IF EXISTS gov_studio.v_dpipe_prescription_pipeline;
DROP VIEW IF EXISTS gov_studio.v_dpipe_prescription_diagnosis;
DROP VIEW IF EXISTS gov_studio.v_kx_ip_admissions;
DROP VIEW IF EXISTS gov_studio.v_kx_discharged_completed_patients;
DROP VIEW IF EXISTS gov_studio.v_kx_billing_records;
DROP VIEW IF EXISTS gov_studio.v_surgery_cases;
DROP VIEW IF EXISTS gov_studio.v_doctors;

-- 5.1 "individuals-prescriptions" (Pulse OPD Rx; 4.4 GB, no uid/time index:
--      filter by _parent_id or uploaded_at). 15 columns.
--   _parent_id             join key to dpipe diagnosis rows            (M-OPD-15, M-OPD-16)
--   uid                    KEY-PHI, = opd_note_audits.uid              (M-OPD-08..16, M-AMS-03)
--   consult_uid            KEY-PHI join to audit row                   (M-OPD-08..16)
--   kx_encounter_id        KEY-PHI join to audit row                   (M-OPD-08..16)
--   doctor_uid             doctor attribution                          (M-OPD-08..16)
--   timestamp, uploaded_at window anchor / incremental extract         (all Rx-rate metrics)
--   is_draft               exclude drafts from denominators            (M-OPD-08..16)
--   type_of_prescription, consult_type, consult_types   Rx scope      (M-OPD-08..16)
--   medications            Rx denominator, 5+ medicines, drug classes  (M-OPD-08..13, M-AMS-01..04)
--   diagnosis_icd_codes, impression_icd_codes   LBP/headache/URTI denominators (M-OPD-15, M-OPD-16, M-AMS-03, M-AMS-04)
--   further_investigation  tests per consult, imaging                  (M-OPD-14, M-OPD-15, M-OPD-16)
-- Left out: patient_details__* (no age column confirmed here), free_text,
-- presenting_complaints, assessments, all specialty fields (no catalogue metric).
CREATE VIEW gov_studio.v_individuals_prescriptions AS
SELECT "_parent_id", "uid", "consult_uid", "kx_encounter_id", "doctor_uid",
       "timestamp", "uploaded_at", "is_draft",
       "type_of_prescription", "consult_type", "consult_types",
       "medications", "diagnosis_icd_codes", "impression_icd_codes",
       "further_investigation"
FROM public."individuals-prescriptions";

-- 5.2 dpipe_prescription_pipeline. 11 columns.
--   presc_uid              = individuals-prescriptions key              (M-OPD-09, M-OPD-10, M-PRE-08)
--   individual_uid         KEY-PHI, member-level conversion match       (M-PRE-03 strict, M-PRE-08)
--   age                    PHI-adjacent; ONLY source of age             (M-OPD-09, M-OPD-10)
--   timestamp, uploaded_at window anchor                                (M-OPD-09, M-OPD-10, M-PRE-08)
--   presc_is_draft         exclude drafts                               (M-OPD-09, M-OPD-10)
--   consult_type           scope                                        (M-OPD-09, M-OPD-10)
--   diagnosis, medicines, further_investigation   (jsonb)              (M-OPD-09, M-OPD-10, M-OPD-14, M-AMS-03)
-- Left out: name, mobile, membership_id, member_uid, account_uid, company_name,
-- doctor_email, doctor_name (patient / contact identifiers; no metric needs them).
CREATE VIEW gov_studio.v_dpipe_prescription_pipeline AS
SELECT "presc_uid", "individual_uid", "age", "timestamp", "uploaded_at",
       "presc_is_draft", "consult_type",
       "diagnosis", "medicines", "further_investigation"
FROM public."dpipe_prescription_pipeline";

-- 5.3 dpipe_prescription_pipeline__diagnosis. 3 columns.
--   _parent_id, diagnosis, icd_code   LBP / headache / URTI / gastroenteritis denominators
--                                     (M-OPD-15, M-OPD-16, M-AMS-03, M-AMS-04)
CREATE VIEW gov_studio.v_dpipe_prescription_diagnosis AS
SELECT "_parent_id", "diagnosis", "icd_code"
FROM public."dpipe_prescription_pipeline__diagnosis";

-- 5.4 kx_ip_admissions (indexed on _id only). 6 columns.
--   uid, encounter_id        admission identity / join to ipd audits     (M-IPD-01..03, M-STAY-01)
--   current_treating_doctor_id   doctor hop to doctors.karexpert_metadata__practitioner_id  (G-04, G-05; M-IPD-*, M-STAY-01)
--   facility_name            site, canonicalise Even-EHRC (G-03)         (M-IPD-*, M-STAY-01)
--   admission_date_time      window anchor                               (M-STAY-01)
--   encounter_type           scope                                       (M-RDM-01)
-- Left out: uhid, patient_name/address/kin/telecom, member_id, payer_*, all other columns.
CREATE VIEW gov_studio.v_kx_ip_admissions AS
SELECT "uid", "encounter_id", "current_treating_doctor_id", "facility_name",
       "admission_date_time", "encounter_type"
FROM public."kx_ip_admissions";

-- 5.5 kx_discharged_completed_patients. 10 columns.
--   uid, encounter_id        episode identity                            (M-RDM-01..03)
--   uhid                     PHI: person key; incidence = count(DISTINCT uhid) (M-RDM-01, G-22)
--   encounter_type           = 'ip_admission' filter                     (M-RDM-01)
--   facility_name            site, canonicalise Even-EHRC                (M-RDM-01, G-03)
--   discharge_date           window                                      (M-RDM-01)
--   treating_sub_department_name   excluded-department rule              (M-RDM-01)
--   discharge_type_value     DAMA/LAMA/expired exclusions (TRUE IPD)     (M-RDM-01)
--   admission_date_time      stay start for pairing                      (M-RDM-01)
--   status                   completed-only filter                       (M-RDM-01)
-- Left out: patient age/gender, doctor names, payer_type, high_risk, summary dates, LOS.
CREATE VIEW gov_studio.v_kx_discharged_completed_patients AS
SELECT "uid", "encounter_id", "uhid", "encounter_type", "facility_name",
       "discharge_date", "treating_sub_department_name", "discharge_type_value",
       "admission_date_time", "status"
FROM public."kx_discharged_completed_patients";

-- 5.6 kx_billing_records. 4 columns.
--   uid, uhid (PHI), patient_type='IP', bill_date_time   IP conversion by uhid (M-PRE-08)
-- Left out: amount, net_amt, bill_no, every money / insurance / item column.
CREATE VIEW gov_studio.v_kx_billing_records AS
SELECT "uid", "uhid", "patient_type", "bill_date_time"
FROM public."kx_billing_records";

-- 5.7 surgery_cases. 7 columns.
--   uid, individual_uid (KEY-PHI), status<>'CANCELLED', created_at, prescribed_at,
--   planned_surgery_date            surgery conversion + pre-op bookings (M-PRE-08, M-PRE-01..03)
--   hospital_info__hospital_uid     site                                 (M-PRE-*)
-- Left out: financial__*, clinical__*, counselling, treating/admitting doctor uids.
CREATE VIEW gov_studio.v_surgery_cases AS
SELECT "uid", "individual_uid", "status", "created_at", "prescribed_at",
       "planned_surgery_date", "hospital_info__hospital_uid"
FROM public."surgery_cases";

-- 5.8 doctors. 8 columns (STAFF data).
--   uid, email, name_with_prefix    identity + e-mail map (G-06, G-07)   (all doctor-level metrics)
--   type, disabled                  roster filter                        (all doctor-level metrics)
--   karexpert_metadata__practitioner_id, ..._by_hospital (jsonb), karexpert_metadata__uid
--                                   IPD doctor hop and doctor-to-site    (G-01, G-04, G-05)
-- NEVER exposed: bank_account__*, uploaded_proofs__*, mobile,
-- karexpert_metadata__mobile, tariffs, qualification/registration, gender.
CREATE VIEW gov_studio.v_doctors AS
SELECT "uid", "email", "name_with_prefix", "type", "disabled",
       "karexpert_metadata__uid", "karexpert_metadata__practitioner_id",
       "karexpert_metadata__practitioner_id_by_hospital"
FROM public."doctors";

-- 6. SELECT on gov_studio only ------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA gov_studio FROM gov_studio_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA gov_studio TO gov_studio_ro;
-- Objects created later by this admin in gov_studio are readable; nothing else.
-- (Only applies to the role running this file; re-run this file for new views.)
ALTER DEFAULT PRIVILEGES IN SCHEMA gov_studio GRANT SELECT ON TABLES TO gov_studio_ro;

-- 7. Post-check: raise (roll back everything) on any leak ---------------------
DO $$
DECLARE
  r record;
  bad text;
BEGIN
  SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolconnlimit, rolcanlogin
    INTO r FROM pg_roles WHERE rolname = 'gov_studio_ro';
  IF r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
     OR r.rolconnlimit <> 3 OR NOT r.rolcanlogin THEN
    RAISE EXCEPTION 'post-check: role attributes are wrong';
  END IF;

  -- member of ANY role (cloudsqlsuperuser, pg_read_all_data, pg_write_all_data, ...)
  SELECT string_agg(g.rolname, ', ') INTO bad
    FROM pg_auth_members m
    JOIN pg_roles g ON g.oid = m.roleid
    JOIN pg_roles u ON u.oid = m.member
   WHERE u.rolname = 'gov_studio_ro';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'post-check: gov_studio_ro is a member of: % (REVOKE them)', bad;
  END IF;

  -- any readable relation / column outside gov_studio (system catalogs excepted)
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ') INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r','v','m','p','f')
     AND n.nspname NOT IN ('pg_catalog','information_schema','gov_studio')
     AND n.nspname NOT LIKE 'pg\_toast%' AND n.nspname NOT LIKE 'pg\_temp%'
     AND (has_table_privilege('gov_studio_ro', c.oid, 'SELECT')
          OR has_any_column_privilege('gov_studio_ro', c.oid, 'SELECT'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'post-check: gov_studio_ro can read: % (PUBLIC or default grants; Even IT must revoke)', bad;
  END IF;

  -- any write privilege anywhere (tables, columns, sequences, schemas, database)
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ') INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r','v','m','p','f','S')
     AND n.nspname NOT IN ('pg_catalog','information_schema')
     AND n.nspname NOT LIKE 'pg\_toast%' AND n.nspname NOT LIKE 'pg\_temp%'
     AND (   (c.relkind <> 'S' AND (
                 has_table_privilege('gov_studio_ro', c.oid, 'INSERT')
              OR has_table_privilege('gov_studio_ro', c.oid, 'UPDATE')
              OR has_table_privilege('gov_studio_ro', c.oid, 'DELETE')
              OR has_table_privilege('gov_studio_ro', c.oid, 'TRUNCATE')
              OR has_table_privilege('gov_studio_ro', c.oid, 'REFERENCES')
              OR has_table_privilege('gov_studio_ro', c.oid, 'TRIGGER')
              OR has_any_column_privilege('gov_studio_ro', c.oid, 'INSERT')
              OR has_any_column_privilege('gov_studio_ro', c.oid, 'UPDATE')))
          OR (c.relkind = 'S' AND has_sequence_privilege('gov_studio_ro', c.oid, 'UPDATE')));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'post-check: gov_studio_ro has write privilege on: %', bad;
  END IF;

  SELECT string_agg(nspname, ', ') INTO bad
    FROM pg_namespace
   WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema'
     AND has_schema_privilege('gov_studio_ro', oid, 'CREATE');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'post-check: gov_studio_ro can CREATE in schema(s): %', bad;
  END IF;

  IF has_database_privilege('gov_studio_ro', current_database(), 'CREATE') THEN
    RAISE EXCEPTION 'post-check: gov_studio_ro can CREATE in this database';
  END IF;
  IF NOT has_database_privilege('gov_studio_ro', current_database(), 'CONNECT') THEN
    RAISE EXCEPTION 'post-check: gov_studio_ro cannot CONNECT to this database';
  END IF;
  IF NOT has_schema_privilege('gov_studio_ro', 'gov_studio', 'USAGE') THEN
    RAISE EXCEPTION 'post-check: no USAGE on gov_studio';
  END IF;

  -- settings must be stored on the role
  IF (SELECT count(*) FROM pg_db_role_setting s JOIN pg_roles ro ON ro.oid = s.setrole
       WHERE ro.rolname = 'gov_studio_ro' AND s.setdatabase = 0
         AND s.setconfig @> ARRAY['default_transaction_read_only=on',
                                  'statement_timeout=60s',
                                  'idle_in_transaction_session_timeout=30s']) <> 1 THEN
    RAISE EXCEPTION 'post-check: role settings missing';
  END IF;
END $$;

COMMIT;

-- 8. Run these AFTER commit (read-only checks for Even IT) -------------------
-- 8a. Other databases where PUBLIC (hence gov_studio_ro) still has CONNECT.
--     G-D1 says no CONNECT anywhere else. Even IT either runs, per database,
--         REVOKE CONNECT ON DATABASE <name> FROM PUBLIC;   -- (and re-grant to the roles that need it)
--     or records here, in writing, why it is left. Rows returned = work to do.
SELECT d.datname AS other_database_with_connect,
       has_database_privilege('gov_studio_ro', d.oid, 'CONNECT') AS gov_studio_ro_can_connect
  FROM pg_database d
 WHERE d.datallowconn AND NOT d.datistemplate
   AND d.datname <> current_database()
   AND has_database_privilege('gov_studio_ro', d.oid, 'CONNECT');

-- 8b. Role summary: expect 1 row; rolconnlimit 3; both setting lines present.
SELECT r.rolname, r.rolconnlimit, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
       r.rolreplication, r.rolbypassrls, s.setconfig
  FROM pg_roles r LEFT JOIN pg_db_role_setting s ON s.setrole = r.oid AND s.setdatabase = 0
 WHERE r.rolname = 'gov_studio_ro';
