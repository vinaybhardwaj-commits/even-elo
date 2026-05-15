/**
 * Even-ELO migrations — inline so they bundle cleanly in Vercel serverless.
 *
 * Each migration is identified by a stable id. The migrate endpoint maintains
 * a `_migrations` marker table and skips migrations whose id is already
 * recorded. Idempotent.
 *
 * Schema source of truth: EVEN-EPI-PRD.md §4.
 * Stream catalogue: EVEN-EPI-PRD.md §5.
 * Position seed list: EVEN-EPI-PRD.md §4.2.
 *
 * Don't reorder. Append new migrations at the end.
 */

export interface Migration {
  id: string;
  description: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: "001_init",
    description: "Create 8 PRD tables + extensions + indexes",
    sql: `
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      -- 4.1 vcs
      CREATE TABLE IF NOT EXISTS vcs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        full_name text NOT NULL,
        specialty text NOT NULL,
        registration_no text,
        status text NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'suspended', 'terminated')),
        notes text,
        created_by_position text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_vcs_status ON vcs(status);
      CREATE INDEX IF NOT EXISTS idx_vcs_specialty ON vcs(specialty);

      -- 4.2 positions (replaces principals)
      CREATE TABLE IF NOT EXISTS positions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        position_name text UNIQUE NOT NULL,
        team text NOT NULL
          CHECK (team IN ('OT','Anesthesia','MS','ICN','Pharmacy','CC','Billing','UnitHead','Admin')),
        description text,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      -- 4.3 surgical_cases
      CREATE TABLE IF NOT EXISTS surgical_cases (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        vc_id uuid NOT NULL REFERENCES vcs(id) ON DELETE RESTRICT,
        case_ref text UNIQUE NOT NULL,
        patient_name text,
        patient_mrn text,
        surgery_date date NOT NULL,
        procedure_label text,
        los_days integer,
        case_status text NOT NULL DEFAULT 'completed'
          CHECK (case_status IN ('completed','cancelled','voided')),
        source text NOT NULL
          CHECK (source IN ('continuous','catchup_upload')),
        entered_by_position text NOT NULL,
        entered_at timestamptz NOT NULL DEFAULT now(),
        notes text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_cases_vc_date ON surgical_cases(vc_id, surgery_date DESC);
      CREATE INDEX IF NOT EXISTS idx_cases_status ON surgical_cases(case_status);

      -- 4.4 streams
      CREATE TABLE IF NOT EXISTS streams (
        id text PRIMARY KEY,
        component text NOT NULL
          CHECK (component IN ('caseload','outcomes','adherence')),
        label text NOT NULL,
        team_owner text NOT NULL,
        data_type text NOT NULL
          CHECK (data_type IN ('binary','numeric','derived')),
        default_rule text NOT NULL
          CHECK (default_rule IN ('no_event','unknown','excluded','derived')),
        direction text NOT NULL
          CHECK (direction IN ('higher_better','lower_better')),
        floor_value numeric,
        target_value numeric,
        requires_reason_when text,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      -- 4.5 case_observations (insert-only with is_current toggle)
      CREATE TABLE IF NOT EXISTS case_observations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        case_id uuid NOT NULL REFERENCES surgical_cases(id) ON DELETE CASCADE,
        stream_id text NOT NULL REFERENCES streams(id),
        value jsonb NOT NULL,
        entered_by_position text NOT NULL,
        entered_at timestamptz NOT NULL DEFAULT now(),
        superseded_at timestamptz,
        is_current boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_obs_case_stream_current
        ON case_observations(case_id, stream_id, is_current);
      CREATE INDEX IF NOT EXISTS idx_obs_stream_current_recent
        ON case_observations(stream_id, is_current, entered_at DESC);

      -- 4.6 weight_versions (exactly one is_current=true)
      CREATE TABLE IF NOT EXISTS weight_versions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        caseload_pct integer NOT NULL,
        outcomes_pct integer NOT NULL,
        adherence_pct integer NOT NULL,
        effective_from timestamptz NOT NULL DEFAULT now(),
        set_by_position text NOT NULL,
        rationale text,
        is_current boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        CHECK (caseload_pct + outcomes_pct + adherence_pct = 100),
        CHECK (caseload_pct BETWEEN 0 AND 100),
        CHECK (outcomes_pct BETWEEN 0 AND 100),
        CHECK (adherence_pct BETWEEN 0 AND 100)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_weight_versions_current
        ON weight_versions(is_current) WHERE is_current = true;

      -- 4.7 score_snapshots (append-only)
      CREATE TABLE IF NOT EXISTS score_snapshots (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        vc_id uuid NOT NULL REFERENCES vcs(id) ON DELETE CASCADE,
        caseload_score numeric,
        outcomes_score numeric,
        adherence_score numeric,
        composite numeric NOT NULL,
        tier text NOT NULL
          CHECK (tier IN ('distinguished','standard','watch','pip','suspension_review','no_recent_activity')),
        low_confidence boolean NOT NULL DEFAULT false,
        weights_version_id uuid NOT NULL REFERENCES weight_versions(id),
        trigger text NOT NULL
          CHECK (trigger IN ('observation_write','case_create','case_status_change','weight_change','manual')),
        triggered_by_position text NOT NULL,
        computed_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_vc_recent
        ON score_snapshots(vc_id, computed_at DESC);

      -- 4.8 audit_log (append-only)
      CREATE TABLE IF NOT EXISTS audit_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_position text NOT NULL,
        action text NOT NULL,
        entity_type text NOT NULL,
        entity_id text NOT NULL,
        before_json jsonb,
        after_json jsonb,
        at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_audit_recent ON audit_log(at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
    `,
  },

  {
    id: "002_seed_streams",
    description: "Seed 18 streams (1 caseload + 8 outcomes + 9 adherence)",
    sql: `
      INSERT INTO streams (id, component, label, team_owner, data_type, default_rule, direction, floor_value, target_value, requires_reason_when) VALUES
        -- Caseload (1)
        ('cases_per_month',         'caseload',  'Cases at EHRC this month',          'OT',         'derived', 'derived',  'higher_better',  1, 8,  NULL),
        -- Outcomes (8)
        ('mortality_30d',           'outcomes',  '30-day mortality',                   'MS',         'binary',  'no_event', 'lower_better',   NULL, NULL, NULL),
        ('readmission_30d',         'outcomes',  '30-day readmission',                 'MS',         'binary',  'no_event', 'lower_better',   NULL, NULL, NULL),
        ('ssi',                     'outcomes',  'Surgical site infection',            'ICN',        'binary',  'no_event', 'lower_better',   NULL, NULL, NULL),
        ('unplanned_return_ot',     'outcomes',  'Unplanned return to OT',             'OT',         'binary',  'no_event', 'lower_better',   NULL, NULL, NULL),
        ('nps_discharge',           'outcomes',  'NPS at discharge',                   'CC',         'numeric', 'excluded', 'higher_better',  6, 9,  NULL),
        ('nps_day7',                'outcomes',  'NPS Day-7',                          'CC',         'numeric', 'excluded', 'higher_better',  6, 9,  NULL),
        ('complaint_raised',        'outcomes',  'Complaint raised',                   'CC',         'binary',  'no_event', 'lower_better',   NULL, NULL, NULL),
        ('family_comm_done',        'outcomes',  'Family communication completed',     'CC',         'binary',  'unknown',  'higher_better',  NULL, NULL, NULL),
        -- Adherence (9)
        ('pac_done',                'adherence', 'PAC completed',                      'Anesthesia', 'binary',  'unknown',  'higher_better',  NULL, NULL, NULL),
        ('ot_on_time',              'adherence', 'OT on-time arrival',                 'OT',         'binary',  'unknown',  'higher_better',  NULL, NULL, NULL),
        ('ot_equipment_protocol',   'adherence', 'OT equipment per protocol',          'OT',         'binary',  'unknown',  'higher_better',  NULL, NULL, NULL),
        ('ot_overrun_minutes',      'adherence', 'OT minutes overrun',                 'OT',         'numeric', 'excluded', 'lower_better',   30, 0, NULL),
        ('discharge_summary_24h',   'adherence', 'Discharge summary in 24h',           'MS',         'binary',  'unknown',  'higher_better',  NULL, NULL, NULL),
        ('round_attendance',        'adherence', 'Round attendance',                   'MS',         'binary',  'unknown',  'higher_better',  NULL, NULL, NULL),
        ('abx_stewardship',         'adherence', 'Antibiotic stewardship appropriate', 'Pharmacy',   'binary',  'unknown',  'higher_better',  NULL, NULL, NULL),
        ('insurance_denial',        'adherence', 'Insurance denial',                   'Billing',    'binary',  'no_event', 'lower_better',   NULL, NULL, NULL),
        ('unit_head_anomaly',       'adherence', 'Unit Head anomaly flag',             'UnitHead',   'binary',  'no_event', 'lower_better',   NULL, NULL, 'true')
      ON CONFLICT (id) DO NOTHING;
    `,
  },

  {
    id: "003_seed_positions",
    description: "Seed 9 positions (PRD §4.2)",
    sql: `
      INSERT INTO positions (position_name, team, description) VALUES
        ('OT Coordinator',          'OT',         'Creates cases · OT discipline + return-to-OT'),
        ('Anesthesia Coordinator',  'Anesthesia', 'PAC completion'),
        ('Medical Superintendent',  'MS',         'Mortality, readmission, discharge summary, rounds'),
        ('ICN Lead',                'ICN',        'Surgical site infections'),
        ('Clinical Pharmacologist', 'Pharmacy',   'Antibiotic stewardship'),
        ('Customer Care Lead',      'CC',         'NPS, complaints, family communication'),
        ('Billing Lead',            'Billing',    'Insurance denials'),
        ('Unit Head',               'UnitHead',   'Anomaly flags, behavioural patterns'),
        ('Committee Admin',         'Admin',      'Roster, weights, stream config')
      ON CONFLICT (position_name) DO NOTHING;
    `,
  },

  {
    id: "004_seed_weights",
    description: "Seed pilot weight version 33/34/33 (current)",
    sql: `
      INSERT INTO weight_versions
        (caseload_pct, outcomes_pct, adherence_pct, set_by_position, rationale, is_current)
      SELECT 33, 34, 33, 'Committee Admin', 'Pilot launch — equal weighting per proposal §6', true
      WHERE NOT EXISTS (SELECT 1 FROM weight_versions WHERE is_current = true);
    `,
  },

  {
    id: "005_round_attendance_reason",
    description:
      "round_attendance: optional reason field shown when val=false (Inadequate). PRD D20.",
    sql: `
      UPDATE streams
      SET requires_reason_when = 'false:optional', updated_at = now()
      WHERE id = 'round_attendance';
    `,
  },

  {
    id: "006_insurance_denial_reason",
    description:
      "insurance_denial: optional reason field shown when val=true (denied). PRD §5 A8.",
    sql: `
      UPDATE streams
      SET requires_reason_when = 'true:optional', updated_at = now()
      WHERE id = 'insurance_denial';
    `,
  },
  // ────────────────────────────────────────────────────────────
  // EPI v2.0 — schema additions (lock-down spec §F.7 + EPI.0a plan)
  // ────────────────────────────────────────────────────────────
  {
    id: "007_epi_schema",
    description: "EPI v2.0 schema additions: hospitals, profiles, physicians, engagements, qualifications, privileges, audit_log_v2 + ALTER positions for hospital scoping",
    sql: `
      -- 1. hospitals (network-wide tenant table)
      CREATE TABLE IF NOT EXISTS hospitals (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code        text NOT NULL UNIQUE,
        name        text NOT NULL,
        is_active   boolean NOT NULL DEFAULT true,
        created_at  timestamptz NOT NULL DEFAULT now()
      );

      -- 2. positions: drop v1 team CHECK (EPI broadens role list), add hospital_id
      ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_team_check;
      ALTER TABLE positions ADD COLUMN IF NOT EXISTS hospital_id uuid REFERENCES hospitals(id);
      CREATE INDEX IF NOT EXISTS idx_positions_hospital ON positions(hospital_id);

      -- 3. profiles (auth identity, 1:1 user-to-position-per-hospital)
      CREATE TABLE IF NOT EXISTS profiles (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email           text NOT NULL UNIQUE,
        full_name       text NOT NULL,
        password_hash   text NOT NULL,
        position_id     uuid NOT NULL REFERENCES positions(id),
        hospital_id     uuid NOT NULL REFERENCES hospitals(id),
        status          text NOT NULL DEFAULT 'pending_approval'
          CHECK (status IN ('pending_approval','active','suspended','rejected')),
        is_super_admin       boolean NOT NULL DEFAULT false,
        is_sgc_member        boolean NOT NULL DEFAULT false,
        is_hr                boolean NOT NULL DEFAULT false,
        is_site_medical_head boolean NOT NULL DEFAULT false,
        last_login_at   timestamptz,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_profiles_hospital ON profiles(hospital_id);
      CREATE INDEX IF NOT EXISTS idx_profiles_position ON profiles(position_id);
      CREATE INDEX IF NOT EXISTS idx_profiles_status   ON profiles(status);

      -- 4. physicians (network-wide; hospital relationships live in physician_engagements)
      CREATE TABLE IF NOT EXISTS physicians (
        id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        full_name            text NOT NULL,
        preferred_name       text,
        primary_specialty    text,
        registration_number  text,
        registration_council text,
        registration_expiry  date,
        email                text,
        phone                text,
        date_joined_network  date,
        current_status       text NOT NULL DEFAULT 'active'
          CHECK (current_status IN ('active','inactive','terminated')),
        notes                text,
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_at           timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_physicians_status ON physicians(current_status);

      -- 5. physician_engagements (one row per physician × hospital × engagement_type)
      CREATE TABLE IF NOT EXISTS physician_engagements (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        physician_id      uuid NOT NULL REFERENCES physicians(id) ON DELETE CASCADE,
        hospital_id       uuid NOT NULL REFERENCES hospitals(id),
        engagement_type   text NOT NULL
          CHECK (engagement_type IN ('employed','part_time','visiting_consultant')),
        start_date        date NOT NULL,
        end_date          date,
        specialty         text,
        status            text NOT NULL DEFAULT 'active'
          CHECK (status IN ('active','probation','terminated')),
        terminated_reason text,
        created_at        timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_engagements_physician ON physician_engagements(physician_id);
      CREATE INDEX IF NOT EXISTS idx_engagements_hospital  ON physician_engagements(hospital_id);

      -- 6. qualifications (file_data jsonb stores 2MB-cap base64-encoded cert per lock-down decision #26)
      CREATE TABLE IF NOT EXISTS qualifications (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        physician_id    uuid NOT NULL REFERENCES physicians(id) ON DELETE CASCADE,
        degree          text NOT NULL,
        institution     text,
        institution_tier text CHECK (institution_tier IN ('A','B','C','Unknown')),
        year_completed  integer,
        country         text,
        verified        boolean NOT NULL DEFAULT false,
        verified_by     uuid REFERENCES profiles(id),
        verified_at     timestamptz,
        file_data       jsonb,
        created_at      timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_quals_physician ON qualifications(physician_id);

      -- 7. privileges
      CREATE TABLE IF NOT EXISTS privileges (
        id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        physician_id           uuid NOT NULL REFERENCES physicians(id) ON DELETE CASCADE,
        hospital_id            uuid NOT NULL REFERENCES hospitals(id),
        procedure_or_specialty text NOT NULL,
        granted_date           date NOT NULL,
        granted_by             uuid REFERENCES profiles(id),
        withdrawn_date         date,
        withdrawn_reason       text,
        basis                  text CHECK (basis IN ('initial','annual_review','case_review','vc_observation_pass')),
        created_at             timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_privs_physician ON privileges(physician_id);
      CREATE INDEX IF NOT EXISTS idx_privs_hospital  ON privileges(hospital_id);

      -- 8. audit_log_v2 (parallel to v1 audit_log; new EPI writes go here, v1 audit_log keeps history)
      CREATE TABLE IF NOT EXISTS audit_log_v2 (
        id            bigserial PRIMARY KEY,
        actor_user_id uuid REFERENCES profiles(id),
        actor_ip      text,
        action        text NOT NULL,
        entity_type   text NOT NULL,
        entity_id     text,
        before_json   jsonb,
        after_json    jsonb,
        created_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_audit_v2_entity ON audit_log_v2(entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS idx_audit_v2_actor  ON audit_log_v2(actor_user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_v2_time   ON audit_log_v2(created_at DESC);
    `,
  },

  // ────────────────────────────────────────────────────────────
  // EPI.1d — clinical_metrics_monthly (PRD §6.3 / §7.3)
  // ────────────────────────────────────────────────────────────
  {
    id: "008_clinical_metrics_monthly",
    description: "Monthly clinical metrics per (physician × hospital × month). Manual CSV upload from /admin/metrics.",
    sql: `
      CREATE TABLE IF NOT EXISTS clinical_metrics_monthly (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        physician_id    uuid NOT NULL REFERENCES physicians(id) ON DELETE CASCADE,
        hospital_id     uuid NOT NULL REFERENCES hospitals(id),
        year            integer NOT NULL CHECK (year >= 2020 AND year <= 2100),
        month           integer NOT NULL CHECK (month BETWEEN 1 AND 12),
        opd_count       integer,
        ipd_admissions  integer,
        ot_cases        integer,
        revenue_inr     numeric(14,2),
        uploaded_by     uuid REFERENCES profiles(id),
        uploaded_at     timestamptz NOT NULL DEFAULT now(),
        source_file     text,
        UNIQUE (physician_id, hospital_id, year, month)
      );
      CREATE INDEX IF NOT EXISTS idx_metrics_physician ON clinical_metrics_monthly(physician_id, year DESC, month DESC);
      CREATE INDEX IF NOT EXISTS idx_metrics_hospital  ON clinical_metrics_monthly(hospital_id);
    `,
  },

  // ────────────────────────────────────────────────────────────
  // EPI.2a — incidents + incident_replies (PRD §6.4 + locked §E.4)
  // ────────────────────────────────────────────────────────────
  {
    id: "009_incidents",
    description: "Incident submission + right-of-reply tables. 8 categories per locked decision #20; severity submitter-set with super-admin re-classify; anonymous flag with audit-log-only identity disclosure per #19.",
    sql: `
      CREATE TABLE IF NOT EXISTS incidents (
        id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        target_physician_id         uuid NOT NULL REFERENCES physicians(id),
        submitted_at                timestamptz NOT NULL DEFAULT now(),
        submitted_from_ip           text,
        submitter_user_id           uuid NOT NULL REFERENCES profiles(id),
        submitter_position_at_time  text NOT NULL,
        anonymous_flag              boolean NOT NULL DEFAULT false,
        hospital_id                 uuid REFERENCES hospitals(id),
        category                    text NOT NULL CHECK (category IN (
          'clinical','patient_safety','medical_error','professionalism',
          'documentation','etiquette','vendor_compliance','other'
        )),
        severity                    text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
        narrative                   text NOT NULL,
        evidence_urls               text[],
        status                      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','retracted')),
        retracted_by                uuid REFERENCES profiles(id),
        retracted_at                timestamptz,
        retraction_reason           text,
        created_at                  timestamptz NOT NULL DEFAULT now(),
        updated_at                  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_incidents_target   ON incidents(target_physician_id, submitted_at DESC);
      CREATE INDEX IF NOT EXISTS idx_incidents_status   ON incidents(status, submitted_at DESC);
      CREATE INDEX IF NOT EXISTS idx_incidents_submitter ON incidents(submitter_user_id);

      CREATE TABLE IF NOT EXISTS incident_replies (
        id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        incident_id              uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        replied_by_profile_id    uuid NOT NULL REFERENCES profiles(id),
        reply_text               text NOT NULL,
        replied_at               timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_replies_incident ON incident_replies(incident_id, replied_at ASC);
    `,
  },

  // ────────────────────────────────────────────────────────────
  // EPI.3a — vc_prescreens (PRD §6.2 + locked decision #11/#31)
  // ────────────────────────────────────────────────────────────
  {
    id: "010_vc_prescreens",
    description: "VC onboarding pre-screen table. Physician row created only on decision='confirm_privileges' in EPI.3c; this table carries prospective email/name/specialty pre-confirmation. 12-month re-invitation cooldown enforced server-side; super_admin can override.",
    sql: `
      CREATE TABLE IF NOT EXISTS vc_prescreens (
        id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        prospective_email        text NOT NULL,
        prospective_full_name    text NOT NULL,
        prospective_specialty    text,
        hospital_id              uuid NOT NULL REFERENCES hospitals(id),
        years_post_postgraduate  integer,
        prior_corporate_hospitals text[],
        commitments_acknowledged jsonb,
        red_flags                text,
        decision                 text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','invite','reject')),
        decision_rationale       text,
        cooldown_override        boolean NOT NULL DEFAULT false,
        stage                    text NOT NULL DEFAULT 'prescreen' CHECK (stage IN ('prescreen','observation','decision','onboarded','rejected','terminated')),
        prescreened_by           uuid NOT NULL REFERENCES profiles(id),
        prescreened_at           timestamptz NOT NULL DEFAULT now(),
        decided_at               timestamptz,
        physician_id             uuid REFERENCES physicians(id),
        created_at               timestamptz NOT NULL DEFAULT now(),
        updated_at               timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_prescreens_stage    ON vc_prescreens(stage, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_prescreens_email    ON vc_prescreens(lower(prospective_email));
      CREATE INDEX IF NOT EXISTS idx_prescreens_hospital ON vc_prescreens(hospital_id);
    `,
  },
];

