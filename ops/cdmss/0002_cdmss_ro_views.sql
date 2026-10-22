-- Column-scoped READ VIEWS for studio_cdmss_ro: schema cdmss_ro, 17 views over the CDMSS Neon database. Run ONLY as the
-- database OWNER over the DIRECT url, after 0001_cdmss_ro_role.sql, through ops/cdmss/run-cdmss-ro.sh. Idempotent
-- (drops and recreates only its own views), ONE transaction. NOT RUN by the builder.
--
-- Every view is owner-owned (security_invoker NOT set) and security_barrier. The role gets USAGE on schema cdmss_ro and
-- SELECT on exactly these views, and NOTHING on any base table. Columns are listed explicitly; no SELECT *.
-- PHI POLICY (gov-orch ruling, V 13/21 Oct; confirmed by the user): governance has no PHI gating, so identity keys (uhid,
-- individual_uid, member ids, consult_uid, kx_encounter_id, document_id) and the stored finding text / evidence / rationale /
-- quote columns ARE exposed. Still left out: secrets and tokens, raw prompts, LLM traces (trace_id, raw_judge_error,
-- stage_timings, model-call parameters). ccb_briefs.doctor_uid is UNVERIFIED-live (in no migration or runtime DDL): omitted.
-- Canonical rules baked in (lib/audit-canonical.ts CANONICAL_RANK_SQL; lib/stewardship-canonical.ts OPD_CANON_WHERE):
--   rank = grader tier (qwen/-mini LAST) > highest engine version (numeric, component-wise) > reference model > latest audited_at.
--   The version tail is cast to int[] ONLY behind a shape guard inside a CASE, so a suffixed or odd version cannot raise.
--   OPD (G-10/G-13/G-18/G-20): one row per (app_source, uid); excluded_reason IS NULL applied BEFORE ranking; engine family is
--   DERIVED FROM THE DATA by shape (opd-note-audit/<digits.digits...>, numeric tail >= 0.81.3), never a hard-coded list of
--   19 entries; cdmss_ro.opd_engine_version lists every version seen and whether it is in the family (the guard to watch).
--   app_source is a column and part of the identity (the app's APP_SOURCE env value is not knowable from SQL).
-- Band (G-14): raw_band = stored `band`; displayed_band = hysteresis band (NULL = no anchor yet). Neither is renamed "band".
-- PDQI-9 (G-16): pdqi9_assessed is false when the scorecard records note_quality weight 0, or (no scorecard) pdqi9 is empty.
--   An NQI mean over rows with pdqi9_assessed = false is biased up; filter or split on it.
\set ECHO none
\set QUIET on
\set ON_ERROR_STOP on

DO $$
DECLARE
  me pg_roles%ROWTYPE;
  sch_owner name;
BEGIN
  SELECT * INTO me FROM pg_roles WHERE rolname = current_user;
  IF me.rolsuper THEN RAISE EXCEPTION 'run 0002_cdmss_ro_views.sql as the database owner, not a superuser: refusing'; END IF;
  IF me.rolname = 'studio_cdmss_ro' THEN RAISE EXCEPTION 'run 0002_cdmss_ro_views.sql as the database owner, not studio_cdmss_ro: refusing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_cdmss_ro') THEN
    RAISE EXCEPTION 'studio_cdmss_ro does not exist: run 0001_cdmss_ro_role.sql first';
  END IF;
  SELECT pg_get_userbyid(nspowner) INTO sch_owner FROM pg_namespace WHERE nspname = 'cdmss_ro';
  IF sch_owner IS NULL THEN RAISE EXCEPTION 'schema cdmss_ro does not exist: run 0001_cdmss_ro_role.sql first'; END IF;
  IF sch_owner <> current_user THEN RAISE EXCEPTION 'schema cdmss_ro is owned by another role: refusing'; END IF;
END
$$;

REVOKE ALL ON SCHEMA cdmss_ro FROM PUBLIC;

-- Drop only our own views (dependents first).
DROP VIEW IF EXISTS cdmss_ro.site_observed;
DROP VIEW IF EXISTS cdmss_ro.opd_finding;
DROP VIEW IF EXISTS cdmss_ro.opd_engine_version;
DROP VIEW IF EXISTS cdmss_ro.opd_note_audit;
DROP VIEW IF EXISTS cdmss_ro.ipd_discharge_audit;
DROP VIEW IF EXISTS cdmss_ro.ipd_episode_audit;
DROP VIEW IF EXISTS cdmss_ro.ot_note_audit;
DROP VIEW IF EXISTS cdmss_ro.preop_finding;
DROP VIEW IF EXISTS cdmss_ro.readmission_finding;
DROP VIEW IF EXISTS cdmss_ro.ams_formulary;
DROP VIEW IF EXISTS cdmss_ro.lvc_rule;
DROP VIEW IF EXISTS cdmss_ro.lvc_concept;
DROP VIEW IF EXISTS cdmss_ro.lvc_rule_event;
DROP VIEW IF EXISTS cdmss_ro.gov_signal;
DROP VIEW IF EXISTS cdmss_ro.ccb_brief;
DROP VIEW IF EXISTS cdmss_ro.doctor_dim;
DROP VIEW IF EXISTS cdmss_ro.site_dim;

-- ---------------------------------------------------------------------------------------------------------------
-- SITE: one vocabulary -> canonical site code. Values from code evidence ONLY (Even-CDMSS lib/readmission-rates-core.ts):
--   facility_name   'Even', 'Even-EHRC' -> EHRC   (FACILITY_EHRC_ALIASES; the 19 Aug 2026 relabel keeps the canonical key)
--                   'Even-EHBR'          -> EHBR   (FACILITY_EHBR)
--   encounter_prefix (readmission-rates-core.ts:201-204 facilityOfEncounter, "measured"): id.trim().toUpperCase() startsWith 'IP-' -> EHRC;
--                    'IPNO' or 'ADM' -> EHBR. The views do the same: starts_with(upper(btrim(id)), raw_value).
-- hospital_uid (OT) and pre-op hospitalName/hospital uid have NO name lookup anywhere in the repo, so they have NO rows
-- here and resolve to 'UNMAPPED' (never dropped, never guessed). Add a row here only with code or database evidence.
CREATE VIEW cdmss_ro.site_dim WITH (security_barrier = true) AS
SELECT v.vocabulary, v.match_kind, v.raw_value, v.site_code, v.code_evidence
FROM (VALUES
  ('facility_name',    'exact',  'Even',      'EHRC', 'readmission-rates-core.ts FACILITY_EHRC / FACILITY_EHRC_ALIASES'),
  ('facility_name',    'exact',  'Even-EHRC', 'EHRC', 'readmission-rates-core.ts FACILITY_EHRC_ALIASES (relabel 19 Aug 2026)'),
  ('facility_name',    'exact',  'Even-EHBR', 'EHBR', 'readmission-rates-core.ts FACILITY_EHBR'),
  ('encounter_prefix', 'prefix', 'IP-',       'EHRC', 'readmission-rates-core.ts:201-204 (measured)'),
  ('encounter_prefix', 'prefix', 'IPNO',      'EHBR', 'readmission-rates-core.ts:201-204 startsWith IPNO'),
  ('encounter_prefix', 'prefix', 'ADM',       'EHBR', 'readmission-rates-core.ts:201-204 (measured)')
) AS v(vocabulary, match_kind, raw_value, site_code, code_evidence);

-- ---------------------------------------------------------------------------------------------------------------
-- F1 OPD. One canonical row per (app_source, uid).
CREATE VIEW cdmss_ro.opd_note_audit WITH (security_barrier = true) AS
SELECT DISTINCT ON (a.app_source, a.uid)
  a.id AS audit_id,
  a.app_source,
  a.uid,
  a.consult_uid,
  a.kx_encounter_id,
  a.doctor_uid,
  a.note_date,
  (a.note_date AT TIME ZONE 'Asia/Kolkata')::date AS note_day_ist,
  a.prescription_type,
  a.consult_type,
  a.note_quality_index,
  a.band AS raw_band,
  a.displayed_band,
  a.score_documentation,
  a.score_note_quality,
  a.score_appropriateness,
  a.score_prescribing_safety,
  a.score_patient_centred,
  CASE
    WHEN sc.n_nq > 0 THEN sc.n_nq_weighted > 0
    ELSE COALESCE(jsonb_typeof(a.pdqi9) = 'object' AND a.pdqi9 <> '{}'::jsonb, false)
  END AS pdqi9_assessed,
  CASE WHEN sc.n_nq > 0 THEN 'scorecard' ELSE 'pdqi9_column' END AS pdqi9_assessed_basis,
  (a.scorecard IS NOT NULL) AS scorecard_recorded,
  a.completeness_pct,
  a.n_missing_mandatory,
  a.n_findings,
  a.n_low_value,
  a.n_context_dependent,
  a.n_interaction_alerts,
  a.complexity_band,
  a.pdqi9,
  a.scorecard,
  a.completeness_items,
  a.missing_fields,
  a.complexity_inputs,
  a.findings,
  a.suggestions,
  a.engine_version,
  CASE WHEN a.model LIKE 'qwen%' OR a.engine_version LIKE '%-mini' THEN 'local' ELSE 'cloud' END AS grader_tier,
  (a.model IN ('google/gemini-2.5-pro', 'gemini-2.5-pro')) AS is_reference_model,
  a.model,
  a.provider,
  a.audited_at
FROM public.opd_note_audits a
LEFT JOIN LATERAL (
  SELECT count(*) FILTER (WHERE d->>'domain' = 'note_quality') AS n_nq,
         count(*) FILTER (WHERE d->>'domain' = 'note_quality'
                            AND CASE WHEN jsonb_typeof(d->'weight') = 'number' THEN (d->>'weight')::numeric > 0 ELSE false END) AS n_nq_weighted
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.scorecard->'domains') = 'array' THEN a.scorecard->'domains' ELSE '[]'::jsonb END) d
) sc ON true
WHERE a.excluded_reason IS NULL
  AND a.engine_version LIKE 'opd-note-audit/%'
  AND split_part(a.engine_version, '/', 2) ~ '^[0-9]+(\.[0-9]+)*$'
  AND string_to_array(split_part(a.engine_version, '/', 2), '.')::int[] >= ARRAY[0, 81, 3]
ORDER BY a.app_source, a.uid,
  CASE WHEN a.model LIKE 'qwen%' OR a.engine_version LIKE '%-mini' THEN 1 ELSE 0 END,
  CASE WHEN split_part(a.engine_version, '/', 2) ~ '^[0-9]+(\.[0-9]+)*$'
       THEN string_to_array(split_part(a.engine_version, '/', 2), '.')::int[] END DESC NULLS LAST,
  CASE WHEN a.model IN ('google/gemini-2.5-pro', 'gemini-2.5-pro') THEN 0 ELSE 1 END,
  a.audited_at DESC NULLS LAST,
  a.id;

-- The guard for the derived family: every OPD engine version in the table, and whether the canonical view reads it.
-- A version with in_family = false and a large n_rows is the signal that the floor/shape rule needs a look.
CREATE VIEW cdmss_ro.opd_engine_version WITH (security_barrier = true) AS
SELECT a.engine_version,
       (a.engine_version LIKE 'opd-note-audit/%' AND split_part(a.engine_version, '/', 2) ~ '^[0-9]+(\.[0-9]+)*$') AS shape_ok,
       CASE WHEN a.engine_version LIKE 'opd-note-audit/%' AND split_part(a.engine_version, '/', 2) ~ '^[0-9]+(\.[0-9]+)*$'
            THEN string_to_array(split_part(a.engine_version, '/', 2), '.')::int[] >= ARRAY[0, 81, 3]
            ELSE false END AS in_family,
       count(*) AS n_rows,
       count(*) FILTER (WHERE a.excluded_reason IS NOT NULL) AS n_excluded,
       min(a.audited_at) AS first_audited_at,
       max(a.audited_at) AS last_audited_at
FROM public.opd_note_audits a
GROUP BY a.engine_version;

-- Finding-level rows unnested from the canonical notes (subject, evidence, rationale included).
CREATE VIEW cdmss_ro.opd_finding WITH (security_barrier = true) AS
SELECT c.audit_id, c.app_source, c.uid, c.doctor_uid, c.note_day_ist, c.engine_version,
       f.n AS finding_no,
       f.e->>'subject' AS subject,
       f.e->>'domain' AS domain,
       f.e->>'verdict' AS verdict,
       CASE WHEN f.e->>'confidence' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (f.e->>'confidence')::numeric END AS confidence,
       f.e->'evidence' AS evidence,
       f.e->>'rationale' AS rationale,
       f.e->>'source' AS source,
       CASE WHEN f.e->>'informational' IN ('true', 'false') THEN (f.e->>'informational')::boolean END AS informational,
       f.e->>'signal_type' AS signal_type,
       f.e->>'lvc_category' AS lvc_category,
       f.e->>'direction' AS direction,
       f.e->>'concept_id' AS concept_id,
       f.e->>'rule_ref' AS rule_ref,
       f.e->>'finding_ref' AS finding_ref,
       f.e->>'stable_ref' AS stable_ref
FROM cdmss_ro.opd_note_audit c
JOIN public.opd_note_audits a ON a.id = c.audit_id
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(a.findings) = 'array' THEN a.findings ELSE '[]'::jsonb END)
  WITH ORDINALITY AS f(e, n);

-- ---------------------------------------------------------------------------------------------------------------
-- F2 IPD discharge audit. One row per (app_source, document_id) by the same rank .
CREATE VIEW cdmss_ro.ipd_discharge_audit WITH (security_barrier = true) AS
SELECT DISTINCT ON (a.app_source, a.document_id)
  a.id AS audit_id,
  a.app_source,
  a.document_id,
  a.ip_uid,
  a.member_id,
  a.speciality,
  COALESCE(NULLIF(btrim(a.speciality), ''), 'Unassigned') AS speciality_label,
  a.discharge_type,
  a.los_days,
  a.discharged_at,
  (a.discharged_at AT TIME ZONE 'Asia/Kolkata')::date AS discharged_day_ist,
  a.care_value_index,
  a.band,
  a.score_appropriateness, a.score_efficiency, a.score_safety, a.score_cost, a.score_documentation, a.score_patient_centred,
  a.completeness_pct,
  a.n_findings, a.n_low_value, a.n_context_dependent,
  a.billed_total,
  a.findings,
  a.suggestions,
  a.report,
  a.engine_version,
  CASE WHEN a.model LIKE 'qwen%' OR a.engine_version LIKE '%-mini' THEN 'local' ELSE 'cloud' END AS grader_tier,
  a.model,
  a.provider,
  a.audited_at,
  COALESCE(pf.site_code, 'UNMAPPED') AS site_code,
  CASE WHEN pf.site_code IS NOT NULL THEN 'encounter_prefix' ELSE 'none' END AS site_basis
FROM public.ipd_discharge_audits a
LEFT JOIN LATERAL (
  SELECT m.site_code FROM cdmss_ro.site_dim m
  WHERE m.vocabulary = 'encounter_prefix' AND starts_with(upper(btrim(a.ip_uid)), m.raw_value)
  ORDER BY length(m.raw_value) DESC LIMIT 1
) pf ON true
-- audit-canonical.ts:226-229 canonicalBy drops ONLY isMiniEngine rows (/-mini$/, :69) before ranking, NULL-safe. qwen rows and NULL-model
-- rows stay and are ranked by CANONICAL_RANK_SQL (qwen last via the grader tier); grader_tier shows 'local' for them.
WHERE a.document_id IS NOT NULL
  AND COALESCE(a.engine_version, '') !~ '-mini$'
ORDER BY a.app_source, a.document_id,
  CASE WHEN a.model LIKE 'qwen%' OR a.engine_version LIKE '%-mini' THEN 1 ELSE 0 END,
  CASE WHEN split_part(a.engine_version, '/', 2) ~ '^[0-9]+(\.[0-9]+)*$'
       THEN string_to_array(split_part(a.engine_version, '/', 2), '.')::int[] END DESC NULLS LAST,
  CASE WHEN a.model IN ('google/gemini-2.5-pro', 'gemini-2.5-pro') THEN 0 ELSE 1 END,
  a.audited_at DESC NULLS LAST,
  a.id;

-- F3 IPD episode audit. Current rows only (is_current, ipd-episode/store.ts:107,413), newest engine version per (app_source, encounter_id);
-- CDMSS has no canonicalBy for episodes (is_current is its dedup).
-- Site: facility_name first (canonicalised through site_dim), else the ip_uid prefix, else UNMAPPED.
CREATE VIEW cdmss_ro.ipd_episode_audit WITH (security_barrier = true) AS
SELECT DISTINCT ON (a.app_source, a.encounter_id)
  a.id AS audit_id,
  a.app_source,
  a.encounter_id,
  a.ip_uid,
  a.member_id,
  a.facility_name,
  COALESCE(fn.site_code, pf.site_code, 'UNMAPPED') AS site_code,
  CASE WHEN fn.site_code IS NOT NULL THEN 'facility_name' WHEN pf.site_code IS NOT NULL THEN 'encounter_prefix' ELSE 'none' END AS site_basis,
  a.speciality,
  COALESCE(NULLIF(btrim(a.speciality), ''), 'Unassigned') AS speciality_label,
  a.admitted_at,
  a.discharged_at,
  a.los_days,
  a.discharge_type,
  a.divergence_index,
  a.divergence_band,
  a.band_uncertain,
  a.scoring_status,
  a.completeness_pct,
  a.n_findings, a.n_divergence_pass, a.n_fidelity_pass, a.n_omission, a.n_commission, a.n_timing, a.n_sequencing,
  a.n_divergent, a.n_context_dependent, a.n_unassessable, a.n_concordant, a.n_low_value, a.n_dropped_invalid, a.n_parse_failed,
  a.capped_count,
  a.penalty_total,
  a.expectations_evaluated,
  a.checkpoint_count,
  a.run_seq,
  a.findings,
  a.real_course,
  a.commentary,
  a.admission_context,
  a.evidence_tiers,
  a.error_detail,
  a.engine_version,
  a.audited_at
FROM public.ipd_episode_audits a
LEFT JOIN LATERAL (
  SELECT m.site_code FROM cdmss_ro.site_dim m
  WHERE m.vocabulary = 'facility_name' AND m.raw_value = btrim(a.facility_name) LIMIT 1
) fn ON true
LEFT JOIN LATERAL (
  SELECT m.site_code FROM cdmss_ro.site_dim m
  WHERE m.vocabulary = 'encounter_prefix' AND starts_with(upper(btrim(a.ip_uid)), m.raw_value)
  ORDER BY length(m.raw_value) DESC LIMIT 1
) pf ON true
WHERE a.is_current
ORDER BY a.app_source, a.encounter_id,
  CASE WHEN split_part(a.engine_version, '/', 2) ~ '^[0-9]+(\.[0-9]+)*$'
       THEN string_to_array(split_part(a.engine_version, '/', 2), '.')::int[] END DESC NULLS LAST,
  a.run_seq DESC NULLS LAST,
  a.audited_at DESC NULLS LAST,
  a.id;

-- F4/F5 OT document audit. One row per (app_source, uid), by the full CANONICAL_RANK_SQL as the OT reader does it
-- (document-audits-export-read.ts:81-87 canonicalDistinctOnSql identity uid; audit-canonical.ts:315-319).
-- hospital_uid has no name lookup in code, so site_code is UNMAPPED until site_dim gains evidence-backed rows.
CREATE VIEW cdmss_ro.ot_note_audit WITH (security_barrier = true) AS
SELECT DISTINCT ON (a.app_source, a.uid)
  a.id AS audit_id,
  a.app_source,
  a.note_class,
  a.uid,
  a.encounter_id,
  a.uhid,
  a.hospital_uid,
  a.facility_id,
  'UNMAPPED'::text AS site_code,
  'none'::text AS site_basis,
  a.surgery_name,
  a.surgeon_raw,
  a.note_day,
  a.doctor_uid,
  a.map_status,
  (a.map_status = 'mapped' AND a.doctor_uid IS NOT NULL) AS surgeon_mapped,
  a.n_findings,
  a.findings,
  a.note,
  a.component_json,
  a.engine_version,
  a.model,
  a.audited_at
FROM public.ot_note_audits a
ORDER BY a.app_source, a.uid,
  CASE WHEN a.model LIKE 'qwen%' OR a.engine_version LIKE '%-mini' THEN 1 ELSE 0 END,
  CASE WHEN split_part(a.engine_version, '/', 2) ~ '^[0-9]+(\.[0-9]+)*$'
       THEN string_to_array(split_part(a.engine_version, '/', 2), '.')::int[] END DESC NULLS LAST,
  CASE WHEN a.model IN ('google/gemini-2.5-pro', 'gemini-2.5-pro') THEN 0 ELSE 1 END,
  a.audited_at DESC NULLS LAST,
  a.id;

-- F8 Pre-op risk. Newest engine version per (app_source, episode_key). CDMSS itself reads ONE engine (PREOP_ENGINE_VERSION =
-- 'preop-risk/0.1', preop/store.ts:51,126); no canonicalBy and no grader tier apply to this family. Identical while that engine is
-- the newest; engine_version is exposed so a consumer can pin it. `hospital` is "name or uid": it resolves
-- only if it is literally one of the facility_name strings; otherwise UNMAPPED.
CREATE VIEW cdmss_ro.preop_finding WITH (security_barrier = true) AS
SELECT DISTINCT ON (a.app_source, a.episode_key)
  a.id AS finding_id,
  a.app_source,
  a.episode_key,
  a.individual_uid,
  a.uhid,
  a.patient_name,
  a.age,
  a.sex,
  a.procedure,
  a.engine_version,
  a.hospital,
  COALESCE(fn.site_code, 'UNMAPPED') AS site_code,
  CASE WHEN fn.site_code IS NOT NULL THEN 'facility_name' ELSE 'none' END AS site_basis,
  a.department,
  a.surgeon,
  a.surgery_date,
  a.tier,
  a.rcri_lo, a.rcri_hi, a.mfi_lo, a.mfi_hi, a.cci_lo, a.cci_hi,
  a.needs_review,
  a.booking_only,
  a.pac_on_file,
  a.pac_status,
  a.pac_finalized_at,
  a.pac_verdict,
  a.version_no,
  a.reviewed_at,
  a.why_line,
  a.missing_line,
  a.situation_line,
  a.snapshot,
  a.extraction,
  a.narrative,
  a.computed_at,
  a.created_at,
  a.updated_at
FROM public.preop_findings a
LEFT JOIN LATERAL (
  SELECT m.site_code FROM cdmss_ro.site_dim m
  WHERE m.vocabulary = 'facility_name' AND m.raw_value = btrim(a.hospital) LIMIT 1
) fn ON true
ORDER BY a.app_source, a.episode_key,
  CASE WHEN split_part(a.engine_version, '/', 2) ~ '^[0-9]+(\.[0-9]+)*$'
       THEN string_to_array(split_part(a.engine_version, '/', 2), '.')::int[] END DESC NULLS LAST,
  a.updated_at DESC NULLS LAST,
  a.id;

-- F7 Readmission. Newest engine version per (app_source, dedup_key). CDMSS reads ONE engine (READMIT_ENGINE_VERSION,
-- readmission/rates.ts:33,104,135; NUMERATOR_SQL :44-48 engine_version = $1); no canonicalBy / grader tier. engine_version is exposed. Site = index encounter prefix.
CREATE VIEW cdmss_ro.readmission_finding WITH (security_barrier = true) AS
SELECT DISTINCT ON (a.app_source, a.dedup_key)
  a.id AS finding_id,
  a.app_source,
  a.dedup_key,
  a.engine_version,
  a.finding_class,
  a.index_encounter_id,
  a.readmit_encounter_id,
  a.uhid,
  a.member_uid,
  a.form_uid,
  a.payer_index,
  a.payer_readmit,
  COALESCE(pf.site_code, 'UNMAPPED') AS site_code,
  CASE WHEN pf.site_code IS NOT NULL THEN 'encounter_prefix' ELSE 'none' END AS site_basis,
  a.lane,
  a.tags,
  a.gap_days,
  a.index_department,
  a.readmit_department,
  a.index_doctor,
  a.readmit_doctor,
  a.index_discharge_at,
  a.readmit_admit_at,
  a.audit_status,
  a.not_auditable_reason,
  a.planned,
  a.same_condition,
  a.avoidable,
  a.preventable_injury,
  a.negligence,
  a.judgement_rule_version,
  a.n_omissions,
  a.needs_human_review,
  a.lab_tier,
  a.cm_note,
  a.finding,
  a.omission_evidence,
  a.lab_source_provenance,
  a.last_error,
  a.clinical_review_decision,
  a.clinical_review_clock_class,
  a.clinical_review_lt24h_kind,
  a.clinical_review_exclusion_claim,
  a.clinical_review_quote,
  a.clinical_review_actor,
  a.clinical_review_at,
  a.clinical_review_turn_id,
  a.clinical_review_model,
  a.audited_at,
  a.created_at
FROM public.readmission_findings a
LEFT JOIN LATERAL (
  SELECT m.site_code FROM cdmss_ro.site_dim m
  WHERE m.vocabulary = 'encounter_prefix' AND starts_with(upper(btrim(a.index_encounter_id)), m.raw_value)
  ORDER BY length(m.raw_value) DESC LIMIT 1
) pf ON true
ORDER BY a.app_source, a.dedup_key,
  CASE WHEN split_part(a.engine_version, '/', 2) ~ '^[0-9]+(\.[0-9]+)*$'
       THEN string_to_array(split_part(a.engine_version, '/', 2), '.')::int[] END DESC NULLS LAST,
  a.created_at DESC NULLS LAST,
  a.id;

-- F6 Antimicrobial stewardship: no AMS tables exist (G-12). The formulary is the only non-PHI reference; AMS findings
-- come through cdmss_ro.opd_finding (signal_type / lvc_category). `restricted` = WHO Reserve only; there is no Access/Watch.
CREATE VIEW cdmss_ro.ams_formulary WITH (security_barrier = true) AS
SELECT f.item_code, f.generic, f.generic_canon, f.dosage_form, f.major_grouping, f.minor_grouping,
       f.audit_category, f.restricted, f.high_risk, f.lasa, f.ved
FROM public.formulary f;

-- F9 LVC governance (rules, concepts, activation ledger). Not PHI. Rule `statement` is rule wording, not patient text.
CREATE VIEW cdmss_ro.lvc_rule WITH (security_barrier = true) AS
SELECT r.id AS rule_id, r.region, r.society, r.specialty, r.action_type, r.category, r.status, r.merged_into,
       r.source_release_year, r.proposed_by, r.ratified_by, r.ratified_at, r.created_at, r.updated_at,
       (r.status = 'active' AND r.merged_into IS NULL) AS is_live,
       r.statement
FROM public.lvc_recommendations r;

CREATE VIEW cdmss_ro.lvc_concept WITH (security_barrier = true) AS
SELECT c.concept_id, c.direction, c.action, c.target, c.n_strings, c.volume, c.review_lane, c.first_seen, c.last_seen
FROM public.lvc_concepts c;

CREATE VIEW cdmss_ro.lvc_rule_event WITH (security_barrier = true) AS
SELECT e.id AS event_id, e.rule_ref, e.version, e.event, e.effective_at, e.ratified_by, e.created_at
FROM public.lvc_rule_activation_events e;

-- Worklists (V8): thread headers plus latest_response / ruling.
CREATE VIEW cdmss_ro.gov_signal WITH (security_barrier = true) AS
SELECT s.signal_id, s.app_source, s.reference, s.doctor_uid, s.signal_type, s.importance, s.response_required, s.status,
       s.source_triage_ref, s.window_from, s.window_to, s.sla_due_at, s.latest_response, s.ruling, s.note_class, s.created_at, s.updated_at
FROM public.opd_gov_signal s;

-- CCB briefs (60-day conversion input), envelope included. doctor_uid / doctor_speciality are UNVERIFIED-live (in no migration
-- and no runtime DDL), so NOT selected; add them after an information_schema check.
CREATE VIEW cdmss_ro.ccb_brief WITH (security_barrier = true) AS
SELECT b.id AS brief_id, b.app_source, b.presc_uid, b.individual_uid, b.uhid, b.kx_encounter_id, b.note_date, b.coverage, b.priority, b.pitch_allowed, b.n_findings,
       b.n_cited, b.citation_coverage_pct, b.distinct_sources, b.envelope, b.engine_version, b.created_at
FROM public.ccb_briefs b;

-- Doctor directory (STAFF identity, not patient PHI). Two sources, two speciality vocabularies (G-06): both are exposed
-- under their own names. alias_uids is exposed (mobile-collapsed twins); mobile_last4 / has_email are left out.
CREATE VIEW cdmss_ro.doctor_dim WITH (security_barrier = true) AS
SELECT COALESCE(d.doctor_uid, r.doctor_uid) AS doctor_uid,
       COALESCE(d.doctor_name, r.name) AS doctor_name,
       d.speciality AS directory_speciality,
       r.specialty AS roster_specialty,
       r.channel,
       r.audit_active,
       r.operational_active,
       r.disabled,
       r.alias_uids,
       d.updated_at AS directory_updated_at,
       r.updated_at AS roster_updated_at
FROM public.doctor_directory d
FULL JOIN public.doctor_roster r ON r.doctor_uid = d.doctor_uid;

-- Every distinct raw site value seen in the data, with what it resolved to and how many rows carry it: the proof that
-- nothing is dropped, and the to-do list for site_dim ('UNMAPPED' rows).
CREATE VIEW cdmss_ro.site_observed WITH (security_barrier = true) AS
SELECT x.source, x.vocabulary, x.raw_value, COALESCE(m.site_code, 'UNMAPPED') AS site_code, x.n_rows
FROM (
  SELECT 'ipd_episode_audit.facility_name' AS source, 'facility_name' AS vocabulary, btrim(facility_name) AS raw_value, count(*) AS n_rows
    FROM public.ipd_episode_audits WHERE is_current GROUP BY btrim(facility_name)
  UNION ALL
  SELECT 'ot_note_audit.hospital_uid', 'hospital_uid', btrim(hospital_uid), count(*) FROM public.ot_note_audits GROUP BY btrim(hospital_uid)
  UNION ALL
  SELECT 'preop_finding.hospital', 'facility_name', btrim(hospital), count(*) FROM public.preop_findings GROUP BY btrim(hospital)
  UNION ALL
  SELECT 'ipd_discharge_audit.ip_uid', 'encounter_prefix',
         COALESCE(substring(upper(btrim(ip_uid)) from '^[A-Z]+-?'), ''), count(*) FROM public.ipd_discharge_audits GROUP BY 3
  UNION ALL
  SELECT 'readmission_finding.index_encounter_id', 'encounter_prefix',
         COALESCE(substring(upper(btrim(index_encounter_id)) from '^[A-Z]+-?'), ''), count(*) FROM public.readmission_findings GROUP BY 3
) x
LEFT JOIN cdmss_ro.site_dim m
  ON m.vocabulary = x.vocabulary
 AND ((m.match_kind = 'exact' AND m.raw_value = x.raw_value) OR (m.match_kind = 'prefix' AND starts_with(upper(btrim(x.raw_value)), m.raw_value)));

-- ---------------------------------------------------------------------------------------------------------------
-- GRANTS: USAGE on the schema and SELECT on exactly the views above. Nothing else, to nobody else.
GRANT USAGE ON SCHEMA cdmss_ro TO studio_cdmss_ro;
DO $$
DECLARE v text;
BEGIN
  FOR v IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'cdmss_ro' AND c.relkind = 'v' ORDER BY 1 LOOP
    EXECUTE format('REVOKE ALL ON cdmss_ro.%I FROM PUBLIC', v);
    EXECUTE format('GRANT SELECT ON cdmss_ro.%I TO studio_cdmss_ro', v);
  END LOOP;
END
$$;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM studio_cdmss_ro;

-- POST-CHECK (same transaction; a failure rolls everything back): no privilege of any kind on a base table or column in
-- public, no membership, only views in cdmss_ro, each with SELECT and nothing else for the role.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO bad FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND (has_any_column_privilege('studio_cdmss_ro', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
          OR has_table_privilege('studio_cdmss_ro', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'studio_cdmss_ro holds a privilege in schema public: %', bad; END IF;
  SELECT string_agg(c.relname, ', ') INTO bad FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'cdmss_ro' AND c.relkind <> 'v';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'cdmss_ro holds a non-view relation: %', bad; END IF;
  SELECT string_agg(c.relname, ', ') INTO bad FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'cdmss_ro' AND c.relkind = 'v'
     AND (NOT has_table_privilege('studio_cdmss_ro', c.oid, 'SELECT')
          OR has_table_privilege('studio_cdmss_ro', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'cdmss_ro view ACL is not exactly SELECT: %', bad; END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'studio_cdmss_ro') THEN
    RAISE EXCEPTION 'studio_cdmss_ro is a member of another role: rolling back';
  END IF;
END
$$;
