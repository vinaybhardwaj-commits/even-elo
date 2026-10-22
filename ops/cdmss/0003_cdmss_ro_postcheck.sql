-- POST-CHECK for studio_cdmss_ro, run by ops/cdmss/run-cdmss-ro.sh in the SAME transaction as 0001 and 0002 (a failure
-- rolls all three back). Standalone-safe: read-only, changes nothing. Checks, against the live catalog:
--   1. the role holds no privilege on any relation or column in schema public (base tables), and no membership;
--   2. cdmss_ro contains views only, each with SELECT and nothing else for the role (exact ACL);
--   3. COLUMN ALLOWLIST: every column of every cdmss_ro view is in the list below and every listed column exists
--      (a view or column added to 0002 without editing this list fails the run, and so does a missing one);
--   4. no column name from the PHI/free-text denylist appears anywhere in cdmss_ro.
-- The allowlist is the contract for what the CDMSS module can read. Widening it is a reviewed edit of THIS file.
\set ECHO none
\set QUIET on
\set ON_ERROR_STOP on

DO $$
DECLARE
  bad text;
  n_views int;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO bad FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND (has_any_column_privilege('studio_cdmss_ro', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
          OR has_table_privilege('studio_cdmss_ro', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'postcheck: studio_cdmss_ro holds a privilege on a base relation: %', bad; END IF;

  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'studio_cdmss_ro') THEN
    RAISE EXCEPTION 'postcheck: studio_cdmss_ro is a member of another role';
  END IF;

  SELECT string_agg(c.relname, ', ') INTO bad FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'cdmss_ro' AND c.relkind <> 'v';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'postcheck: cdmss_ro holds a non-view relation: %', bad; END IF;

  SELECT string_agg(c.relname, ', ') INTO bad FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'cdmss_ro' AND c.relkind = 'v'
     AND (NOT has_table_privilege('studio_cdmss_ro', c.oid, 'SELECT')
          OR has_table_privilege('studio_cdmss_ro', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR has_any_column_privilege('studio_cdmss_ro', c.oid, 'INSERT,UPDATE,REFERENCES')
          OR c.reloptions IS NULL OR NOT ('security_barrier=true' = ANY (c.reloptions)));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'postcheck: cdmss_ro view ACL is not exactly SELECT, or not security_barrier: %', bad; END IF;

  -- exact grant list: the role appears in the ACL of each view with the single privilege r (SELECT)
  SELECT string_agg(c.relname, ', ') INTO bad FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
         LATERAL aclexplode(COALESCE(c.relacl, '{}'::aclitem[])) a
   WHERE n.nspname = 'cdmss_ro' AND c.relkind = 'v'
     AND (a.grantee = 'studio_cdmss_ro'::regrole AND a.privilege_type <> 'SELECT' OR a.grantee = 0);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'postcheck: unexpected ACL entry (PUBLIC or non-SELECT) on: %', bad; END IF;

  IF NOT has_schema_privilege('studio_cdmss_ro', 'cdmss_ro', 'USAGE') OR has_schema_privilege('studio_cdmss_ro', 'cdmss_ro', 'CREATE') THEN
    RAISE EXCEPTION 'postcheck: schema cdmss_ro must be USAGE-only for studio_cdmss_ro';
  END IF;
  IF has_schema_privilege('studio_cdmss_ro', 'public', 'USAGE,CREATE') AND EXISTS (
       SELECT 1 FROM pg_namespace WHERE nspname = 'public' AND nspacl IS NOT NULL
         AND EXISTS (SELECT 1 FROM aclexplode(nspacl) x WHERE x.grantee = 'studio_cdmss_ro'::regrole)) THEN
    RAISE EXCEPTION 'postcheck: studio_cdmss_ro has a direct grant on schema public';
  END IF;

  -- COLUMN ALLOWLIST
  CREATE TEMP TABLE _cdmss_allow ON COMMIT DROP AS
  SELECT v.view_name, c.col
  FROM (VALUES
  ('ams_formulary', 'item_code generic generic_canon dosage_form major_grouping minor_grouping audit_category restricted high_risk lasa ved'),
  ('ccb_brief', 'brief_id app_source presc_uid note_date coverage priority pitch_allowed n_findings n_cited citation_coverage_pct distinct_sources engine_version created_at'),
  ('doctor_dim', 'doctor_uid doctor_name directory_speciality roster_specialty channel audit_active operational_active disabled directory_updated_at roster_updated_at'),
  ('gov_signal', 'signal_id app_source reference doctor_uid signal_type importance response_required status window_from window_to sla_due_at note_class created_at updated_at'),
  ('ipd_discharge_audit', 'audit_id app_source ip_uid speciality speciality_label discharge_type los_days discharged_at discharged_day_ist care_value_index band score_appropriateness score_efficiency score_safety score_cost score_documentation score_patient_centred completeness_pct n_findings n_low_value n_context_dependent billed_total engine_version grader_tier model provider audited_at site_code site_basis'),
  ('ipd_episode_audit', 'audit_id app_source encounter_id ip_uid facility_name site_code site_basis speciality speciality_label admitted_at discharged_at los_days discharge_type divergence_index divergence_band band_uncertain scoring_status completeness_pct n_findings n_divergence_pass n_fidelity_pass n_omission n_commission n_timing n_sequencing n_divergent n_context_dependent n_unassessable n_concordant n_low_value n_dropped_invalid n_parse_failed capped_count penalty_total expectations_evaluated checkpoint_count run_seq engine_version audited_at'),
  ('lvc_concept', 'concept_id direction action target n_strings volume review_lane first_seen last_seen'),
  ('lvc_rule', 'rule_id region society specialty action_type category status merged_into source_release_year proposed_by ratified_by ratified_at created_at updated_at is_live statement'),
  ('lvc_rule_event', 'event_id rule_ref version event effective_at ratified_by created_at'),
  ('opd_engine_version', 'engine_version shape_ok in_family n_rows n_excluded first_audited_at last_audited_at'),
  ('opd_finding', 'audit_id app_source uid doctor_uid note_day_ist engine_version finding_no domain verdict confidence source informational signal_type lvc_category direction concept_id rule_ref finding_ref stable_ref'),
  ('opd_note_audit', 'audit_id app_source uid doctor_uid note_date note_day_ist prescription_type consult_type note_quality_index raw_band displayed_band score_documentation score_note_quality score_appropriateness score_prescribing_safety score_patient_centred pdqi9_assessed pdqi9_assessed_basis scorecard_recorded completeness_pct n_missing_mandatory n_findings n_low_value n_context_dependent n_interaction_alerts complexity_band engine_version grader_tier is_reference_model model provider audited_at'),
  ('ot_note_audit', 'audit_id app_source note_class uid hospital_uid facility_id site_code site_basis surgery_name note_day doctor_uid map_status surgeon_mapped n_findings engine_version model audited_at'),
  ('preop_finding', 'finding_id app_source episode_key engine_version hospital site_code site_basis department surgeon surgery_date tier rcri_lo rcri_hi mfi_lo mfi_hi cci_lo cci_hi needs_review booking_only pac_on_file pac_status pac_finalized_at pac_verdict version_no reviewed_at computed_at created_at updated_at'),
  ('readmission_finding', 'finding_id app_source engine_version finding_class index_encounter_id readmit_encounter_id site_code site_basis lane tags gap_days index_department readmit_department index_doctor readmit_doctor index_discharge_at readmit_admit_at audit_status not_auditable_reason planned same_condition avoidable preventable_injury negligence judgement_rule_version n_omissions needs_human_review lab_tier audited_at created_at'),
  ('site_dim', 'vocabulary match_kind raw_value site_code code_evidence'),
  ('site_observed', 'source vocabulary raw_value site_code n_rows')
  ) AS v(view_name, cols), LATERAL regexp_split_to_table(v.cols, ' ') AS c(col);

  SELECT string_agg(i.table_name || '.' || i.column_name, ', ') INTO bad
    FROM information_schema.columns i
   WHERE i.table_schema = 'cdmss_ro'
     AND NOT EXISTS (SELECT 1 FROM _cdmss_allow a WHERE a.view_name = i.table_name AND a.col = i.column_name);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'postcheck: column not in the allowlist: %', bad; END IF;

  SELECT string_agg(a.view_name || '.' || a.col, ', ') INTO bad
    FROM _cdmss_allow a
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns i
                      WHERE i.table_schema = 'cdmss_ro' AND i.table_name = a.view_name AND i.column_name = a.col);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'postcheck: allowlisted column missing from the live view: %', bad; END IF;

  SELECT count(*) INTO n_views FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'cdmss_ro' AND c.relkind = 'v';
  IF n_views <> (SELECT count(DISTINCT view_name) FROM _cdmss_allow) THEN
    RAISE EXCEPTION 'postcheck: view count % differs from the allowlist', n_views;
  END IF;

  -- DENYLIST: PHI / free-text column names must never appear in cdmss_ro, allowlisted or not.
  SELECT string_agg(i.table_name || '.' || i.column_name, ', ') INTO bad
    FROM information_schema.columns i
   WHERE i.table_schema = 'cdmss_ro'
     AND i.column_name IN ('uhid', 'patient_name', 'member_id', 'member_uid', 'individual_uid', 'document_id', 'consult_uid',
         'kx_encounter_id', 'form_uid', 'payer_index', 'payer_readmit', 'cm_note', 'finding', 'findings', 'note', 'component_json',
         'surgeon_raw', 'real_course', 'commentary', 'report', 'snapshot', 'narrative', 'envelope', 'extracted_json', 'comment',
         'rationale', 'evidence', 'subject', 'latest_response', 'ruling', 'age', 'sex', 'procedure', 'why_line', 'missing_line',
         'situation_line', 'omission_evidence', 'lab_source_provenance', 'last_error', 'error_detail', 'raw_judge_error',
         'admission_context', 'mobile_last4', 'alias_uids', 'dedup_key');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'postcheck: denylisted column present: %', bad; END IF;
END
$$;
