-- PRE-CHECK for the CDMSS read layer (G-23: no migration ledger). READ-ONLY; run by ops/cdmss/run-cdmss-ro.sh BEFORE anything is
-- applied, and by --check / --precheck. Lists EVERY base-table column that 0002_cdmss_ro_views.sql reads and that is missing from
-- the live database (information_schema.columns, schema public), so one run shows the whole gap instead of the first CREATE VIEW
-- error. A table that is absent counts as all its columns missing. The list is generated from the view dependencies
-- (pg_depend/pg_rewrite) and a test regenerates it from a scratch build and fails on drift: edit 0002 and this file together.
\set ECHO none
\set QUIET on
\set ON_ERROR_STOP on

DO $$
DECLARE
  missing text;
  total int;
BEGIN
  CREATE TEMP TABLE _cdmss_src ON COMMIT DROP AS
  SELECT v.tbl, c.col FROM (VALUES
  ('ccb_briefs', 'app_source citation_coverage_pct coverage created_at distinct_sources engine_version envelope id individual_uid kx_encounter_id n_cited n_findings note_date pitch_allowed presc_uid priority uhid'),
  ('doctor_directory', 'doctor_name doctor_uid speciality updated_at'),
  ('doctor_roster', 'alias_uids audit_active channel disabled doctor_uid name operational_active specialty updated_at'),
  ('formulary', 'audit_category dosage_form generic generic_canon high_risk item_code lasa major_grouping minor_grouping restricted ved'),
  ('ipd_discharge_audits', 'app_source audited_at band billed_total care_value_index completeness_pct discharge_type discharged_at document_id engine_version findings id ip_uid los_days member_id model n_context_dependent n_findings n_low_value provider report score_appropriateness score_cost score_documentation score_efficiency score_patient_centred score_safety speciality suggestions'),
  ('ipd_episode_audits', 'admission_context admitted_at app_source audited_at band_uncertain capped_count checkpoint_count commentary completeness_pct discharge_type discharged_at divergence_band divergence_index encounter_id engine_version error_detail evidence_tiers expectations_evaluated facility_name findings id ip_uid is_current los_days member_id n_commission n_concordant n_context_dependent n_divergence_pass n_divergent n_dropped_invalid n_fidelity_pass n_findings n_low_value n_omission n_parse_failed n_sequencing n_timing n_unassessable penalty_total real_course run_seq scoring_status speciality'),
  ('lvc_concepts', 'action concept_id direction first_seen last_seen n_strings review_lane target volume'),
  ('lvc_recommendations', 'action_type category created_at id proposed_by ratified_at ratified_by region society source_release_year specialty statement status updated_at'),
  ('opd_gov_signal', 'app_source created_at doctor_uid importance latest_response note_class reference response_required ruling signal_id signal_type sla_due_at source_triage_ref status updated_at window_from window_to'),
  ('opd_note_audits', 'app_source audited_at band completeness_items completeness_pct complexity_band complexity_inputs consult_type consult_uid displayed_band doctor_uid engine_version excluded_reason findings id kx_encounter_id missing_fields model n_context_dependent n_findings n_interaction_alerts n_low_value n_missing_mandatory note_date note_quality_index pdqi9 prescription_type provider score_appropriateness score_documentation score_note_quality score_patient_centred score_prescribing_safety scorecard suggestions uid'),
  ('ot_note_audits', 'app_source audited_at component_json doctor_uid encounter_id engine_version facility_id findings hospital_uid id map_status model n_findings note note_class note_day surgeon_raw surgery_name uhid uid'),
  ('preop_findings', 'age app_source booking_only cci_hi cci_lo computed_at created_at department engine_version episode_key extraction hospital id individual_uid mfi_hi mfi_lo missing_line narrative needs_review pac_finalized_at pac_on_file pac_status pac_verdict patient_name procedure rcri_hi rcri_lo reviewed_at sex situation_line snapshot surgeon surgery_date tier uhid updated_at version_no why_line'),
  ('readmission_findings', 'app_source audit_status audited_at avoidable clinical_review_actor clinical_review_at clinical_review_clock_class clinical_review_decision clinical_review_exclusion_claim clinical_review_lt24h_kind clinical_review_model clinical_review_quote clinical_review_turn_id cm_note created_at dedup_key engine_version finding finding_class form_uid gap_days id index_department index_discharge_at index_doctor index_encounter_id judgement_rule_version lab_source_provenance lab_tier lane last_error member_uid n_omissions needs_human_review negligence not_auditable_reason omission_evidence payer_index payer_readmit planned preventable_injury readmit_admit_at readmit_department readmit_doctor readmit_encounter_id same_condition tags uhid')
  ) AS v(tbl, cols), LATERAL regexp_split_to_table(v.cols, ' ') AS c(col);
  SELECT count(*) INTO total FROM _cdmss_src;
  SELECT string_agg(s.tbl || '.' || s.col, ', ' ORDER BY s.tbl, s.col) INTO missing FROM _cdmss_src s
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns i WHERE i.table_schema = 'public' AND i.table_name = s.tbl AND i.column_name = s.col);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'precheck: % of % source columns are missing live (nothing applied): %', (SELECT count(*) FROM regexp_split_to_table(missing, ', ')), total, missing;
  END IF;
  RAISE NOTICE 'precheck: all % source columns present', total;
END
$$;
