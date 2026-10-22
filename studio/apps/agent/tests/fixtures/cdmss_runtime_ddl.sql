-- Runtime-created CDMSS DDL that is NOT in Even-CDMSS/migrations (G-23: no migration ledger). Transcribed by hand
-- from the CREATE/ALTER statements the app runs itself, at Even-CDMSS bccf852:
--   opd_note_audits ALTERs      app/api/admin/migrate-opd-audits/route.ts
--   readmission_findings        app/api/admin/migrate-readmissions/route.ts
--   doctor_directory            app/api/admin/sync-doctor-directory/route.ts
--   doctor_roster / metrics     lib/doctor-metrics-store.ts
--   opd_gov_signal              lib/opd-gov-signal-store.ts
--   opd_audit_feedback          app/api/admin/migrate-opd-audits/route.ts
--   lvc_recommendations ALTERs  app/api/admin/migrate-opd-audits/route.ts
-- Test fixture only; never run against a real database.
ALTER TABLE opd_note_audits ADD COLUMN IF NOT EXISTS missing_fields JSONB;
ALTER TABLE opd_note_audits ADD COLUMN IF NOT EXISTS complexity_band TEXT;
ALTER TABLE opd_note_audits ADD COLUMN IF NOT EXISTS complexity_inputs JSONB;
ALTER TABLE opd_note_audits ADD COLUMN IF NOT EXISTS excluded_reason TEXT;
ALTER TABLE lvc_recommendations ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE lvc_recommendations ADD COLUMN IF NOT EXISTS plain_rationale TEXT;

CREATE TABLE IF NOT EXISTS opd_audit_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  app_source TEXT NOT NULL DEFAULT 'standalone', audit_id UUID NOT NULL, uid TEXT, verdict TEXT, comment TEXT, author TEXT);

CREATE TABLE IF NOT EXISTS readmission_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), audited_at TIMESTAMPTZ,
  app_source TEXT NOT NULL DEFAULT 'standalone', dedup_key TEXT NOT NULL, engine_version TEXT NOT NULL DEFAULT 'readmission/0.1',
  finding_class TEXT NOT NULL, index_encounter_id TEXT NOT NULL, readmit_encounter_id TEXT, form_uid TEXT, uhid TEXT, member_uid TEXT,
  lane TEXT NOT NULL, tags JSONB, gap_days INT, index_department TEXT, readmit_department TEXT, index_doctor TEXT, readmit_doctor TEXT,
  index_discharge_at TIMESTAMPTZ, readmit_admit_at TIMESTAMPTZ, payer_index TEXT, payer_readmit TEXT, cm_note TEXT,
  form_is_planned BOOLEAN, form_same_condition BOOLEAN, audit_status TEXT NOT NULL DEFAULT 'detected', not_auditable_reason TEXT,
  planned TEXT, same_condition TEXT, avoidable TEXT, lab_timing_profile TEXT, n_omissions INT NOT NULL DEFAULT 0,
  needs_human_review BOOLEAN, promoted_to_full BOOLEAN NOT NULL DEFAULT FALSE, finding JSONB, attempts INT NOT NULL DEFAULT 0,
  last_error TEXT, model TEXT, provider TEXT, trace_id TEXT,
  lab_tier TEXT, lab_source_provenance JSONB, omission_evidence JSONB,
  preventable_injury TEXT, negligence TEXT, judgement_rule_version TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS readmission_findings_key_engine_uq ON readmission_findings (dedup_key, engine_version);

CREATE TABLE IF NOT EXISTS doctor_directory (doctor_uid TEXT PRIMARY KEY, doctor_name TEXT, speciality TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS doctor_roster (
  doctor_uid text PRIMARY KEY, name text, name_normalized text, specialty text, channel text, mobile_last4 text,
  has_email boolean NOT NULL DEFAULT false, audit_active boolean NOT NULL DEFAULT false, operational_active boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(), alias_uids jsonb NOT NULL DEFAULT '[]'::jsonb, disabled boolean NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS doctor_operational_metrics (
  doctor_uid text PRIMARY KEY, week date, total_consults integer, csat_pct numeric, patient_noshow_rate numeric,
  cancellation_rate numeric, missing_prescription_rate numeric, specialty text, channel text, updated_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS opd_gov_signal (
  signal_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), app_source text NOT NULL DEFAULT 'standalone', reference text UNIQUE NOT NULL,
  doctor_uid text NOT NULL, signal_type text NOT NULL, importance text NOT NULL, response_required text NOT NULL,
  status text NOT NULL DEFAULT 'routed', source_triage_ref uuid, window_from date, window_to date, sla_due_at timestamptz,
  latest_response jsonb, ruling jsonb, note_class text NOT NULL DEFAULT 'opd',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
