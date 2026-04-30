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
];
