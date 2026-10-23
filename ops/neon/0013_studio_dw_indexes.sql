-- Phase 1.1: indexes on the DB13 extract destination (studio_dw), so the module's DW reads stop scanning the whole table.
-- Live fact (23 Oct): the dw_rx read (uid = ANY(~2,100 uids)) was a Parallel Seq Scan on studio_dw.individuals_prescriptions
-- (400k rows, 31k buffers, ~250 MB) per call; under concurrency governance-DB reads took 16-19 s each.
-- Run ONLY as the database OWNER over the DIRECT url, AFTER 0012:
--   SQL_FILE=ops/neon/0013_studio_dw_indexes.sql ops/neon/run-roles.sh OWNER_URL_FILE
-- (run-roles.sh applies the file with psql --single-transaction.) Idempotent, ONE transaction, ADDITIVE, NOT RUN by the builder.
--
-- PLAIN CREATE INDEX, not CONCURRENTLY: CONCURRENTLY cannot run inside the single transaction the apply path uses. A plain build takes a
-- SHARE lock (reads continue, writes wait) for the seconds it needs on ~400k rows; the nightly extract (22:30 IST) is the only writer,
-- so run this outside that window. No grant changes: indexes carry no privileges, studio_gov_ro still cannot read studio_dw.
-- Index names are fixed and no unique constraint is added or changed, so the extract's INSERT .. ON CONFLICT ("_id") upserts and
-- DELETE .. WHERE _run_id <> ... statements are unaffected (they only maintain the extra btrees).
--
--   individuals_prescriptions (uid)         the dw_rx read: uid = ANY(...)  (the table's key is "_id", so uid had no index)
--   individuals_prescriptions ("timestamp") window / recency predicates and the DISTINCT ON (uid) .. ORDER BY "timestamp" DESC
--   extract_runs (started_at DESC)          studio_ro.dw_extract_status: ORDER BY started_at DESC LIMIT 30 on every "DB13 as of" read
--   extract_run_tables (table_name, started_at DESC)   the extract's watermark read: DISTINCT ON (table_name) .. ORDER BY table_name, started_at DESC
-- studio_dw.doctors (uid) is the table's PRIMARY KEY, so it already has a btree: a second index would only slow the extract.
-- Other studio_dw tables are keyed by their primary key and the module reads none of them by anything else.
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
    RAISE EXCEPTION 'run 0013_studio_dw_indexes.sql as the database owner, not a superuser: refusing';
  END IF;
  IF me.rolname IN ('studio_gov_ro', 'studio_app', 'studio_dw_writer') THEN
    RAISE EXCEPTION 'run 0013_studio_dw_indexes.sql as the database owner, not a Studio role: refusing';
  END IF;
  SELECT pg_get_userbyid(nspowner) INTO sch_owner FROM pg_namespace WHERE nspname = 'studio_dw';
  IF sch_owner IS NULL THEN
    RAISE EXCEPTION 'schema studio_dw does not exist: run 0012_studio_dw.sql first';
  END IF;
  IF sch_owner <> current_user THEN
    RAISE EXCEPTION 'schema studio_dw is owned by another role: refusing';
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS individuals_prescriptions_uid_idx ON studio_dw.individuals_prescriptions (uid);
CREATE INDEX IF NOT EXISTS individuals_prescriptions_timestamp_idx ON studio_dw.individuals_prescriptions ("timestamp");
CREATE INDEX IF NOT EXISTS extract_runs_started_at_idx ON studio_dw.extract_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS extract_run_tables_name_started_idx ON studio_dw.extract_run_tables (table_name, started_at DESC);

-- POST-CHECK (same transaction): the indexes exist and are valid, the table keys are untouched, and nothing leaked.
DO $$
DECLARE
  t text;
  idx text;
BEGIN
  FOREACH idx IN ARRAY ARRAY['individuals_prescriptions_uid_idx', 'individuals_prescriptions_timestamp_idx', 'extract_runs_started_at_idx', 'extract_run_tables_name_started_idx'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'studio_dw' AND c.relname = idx AND i.indisvalid AND NOT i.indisunique) THEN
      RAISE EXCEPTION 'index studio_dw.% is missing, invalid or unique: rolling back', idx;
    END IF;
  END LOOP;
  -- the primary keys the extract's ON CONFLICT targets are still there
  IF (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'studio_dw' AND i.indisprimary AND c.relname IN ('individuals_prescriptions', 'dpipe_prescription_pipeline', 'kx_ip_admissions',
            'kx_discharged_completed_patients', 'kx_billing_records', 'surgery_cases', 'doctors')) <> 7 THEN
    RAISE EXCEPTION 'a studio_dw primary key is missing: rolling back';
  END IF;
  -- probe unchanged: studio_gov_ro can read nothing in studio_dw (same check as 0012)
  IF has_schema_privilege('studio_gov_ro', 'studio_dw', 'USAGE') OR has_schema_privilege('studio_gov_ro', 'studio_dw', 'CREATE') THEN
    RAISE EXCEPTION 'studio_gov_ro has a privilege on schema studio_dw: rolling back';
  END IF;
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'studio_dw' AND c.relkind IN ('r', 'v', 'm', 'p') LOOP
    IF has_any_column_privilege('studio_gov_ro', format('studio_dw.%I', t)::regclass, 'SELECT') THEN
      RAISE EXCEPTION 'studio_gov_ro can read studio_dw.%: rolling back', t;
    END IF;
  END LOOP;
END
$$;
