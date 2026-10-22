-- Role flags for the Studio per-screen access (gov/role-parity): adds COLUMN grants on the three hospital-role flags
-- to the live staff read, so a Site Governance Officer, Site Medical Head or HR user gets the screens their even-elo
-- page grants. Run ONLY as the database OWNER over the DIRECT url, AFTER 0001_roles.sql:
--   SQL_FILE=ops/neon/0011_profiles_role_flags.sql ops/neon/run-roles.sh OWNER_URL_FILE
-- Idempotent, ONE transaction, ADDITIVE (grants only, revokes nothing). NOT RUN by the builder.
--
-- Real schema (src/lib/migrations.ts, v3.0a/v3.0c): the three flags were DROPPED from public.profiles and exist only as
-- EXISTS-subquery columns of the view profiles_with_roles (is_sgc_member = the Site Governance Officer / SGO role,
-- is_site_medical_head, is_hr). The view runs with its owner's rights, so no grant on profile_hospital_roles or on
-- profiles is needed or given. The view is `SELECT p.*`, so only COLUMN grants are safe: a table-wide grant would
-- expose password_hash and email. is_super_admin is already granted by 0001.
-- Re-running 0001 revokes this grant (it starts from nothing): run 0011 again afterwards.
\set ECHO none
\set QUIET on
\set ON_ERROR_STOP on

DO $$
DECLARE
  me pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO me FROM pg_roles WHERE rolname = current_user;
  IF me.rolsuper THEN
    RAISE EXCEPTION 'run 0011_profiles_role_flags.sql as the database owner, not a superuser: refusing';
  END IF;
  IF me.rolname IN ('studio_gov_ro', 'studio_app') THEN
    RAISE EXCEPTION 'run 0011_profiles_role_flags.sql as the database owner, not a Studio role: refusing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_gov_ro') THEN
    RAISE EXCEPTION 'studio_gov_ro does not exist: run 0001_roles.sql first';
  END IF;
  IF to_regclass('public.profiles_with_roles') IS NULL THEN
    RAISE EXCEPTION 'public.profiles_with_roles does not exist: the even-elo migrations must be applied first';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles_with_roles'
        AND column_name IN ('is_sgc_member', 'is_site_medical_head', 'is_hr')) <> 3 THEN
    RAISE EXCEPTION 'profiles_with_roles lacks is_sgc_member / is_site_medical_head / is_hr: refusing';
  END IF;
END
$$;

GRANT SELECT (is_sgc_member, is_site_medical_head, is_hr) ON public.profiles_with_roles TO studio_gov_ro;

-- POST-CHECK (same transaction): no membership; no table-level SELECT; on the view the role can read EXACTLY
-- id, status, is_super_admin and the three flags (so never password_hash, email, a PIN or any other column); on
-- profiles EXACTLY id and must_change_pin.
DO $$
DECLARE
  bad text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'studio_gov_ro') THEN
    RAISE EXCEPTION 'studio_gov_ro is a member of another role: rolling back';
  END IF;
  IF has_table_privilege('studio_gov_ro', 'public.profiles_with_roles', 'SELECT')
     OR has_table_privilege('studio_gov_ro', 'public.profiles', 'SELECT') THEN
    RAISE EXCEPTION 'studio_gov_ro has table-wide SELECT on profiles or its view: rolling back';
  END IF;
  SELECT string_agg(a.attname, ', ') INTO bad
  FROM pg_attribute a
  WHERE a.attrelid = 'public.profiles_with_roles'::regclass AND a.attnum > 0 AND NOT a.attisdropped
    AND has_column_privilege('studio_gov_ro', 'public.profiles_with_roles', a.attname, 'SELECT')
    AND a.attname NOT IN ('id', 'status', 'is_super_admin', 'is_sgc_member', 'is_site_medical_head', 'is_hr');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'studio_gov_ro can read unexpected profiles_with_roles columns (%): rolling back', bad;
  END IF;
  SELECT string_agg(c, ', ') INTO bad
  FROM unnest(ARRAY['id', 'status', 'is_super_admin', 'is_sgc_member', 'is_site_medical_head', 'is_hr']) c
  WHERE NOT has_column_privilege('studio_gov_ro', 'public.profiles_with_roles', c, 'SELECT');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'studio_gov_ro cannot read profiles_with_roles columns (%): rolling back', bad;
  END IF;
  SELECT string_agg(a.attname, ', ') INTO bad
  FROM pg_attribute a
  WHERE a.attrelid = 'public.profiles'::regclass AND a.attnum > 0 AND NOT a.attisdropped
    AND has_column_privilege('studio_gov_ro', 'public.profiles', a.attname, 'SELECT')
    AND a.attname NOT IN ('id', 'must_change_pin');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'studio_gov_ro can read unexpected profiles columns (%): rolling back', bad;
  END IF;
END
$$;
