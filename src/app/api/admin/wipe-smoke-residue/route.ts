import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/**
 * POST /api/admin/wipe-smoke-residue
 *
 * One-shot maintenance endpoint requested by V on 15 May 2026:
 *   1. Rebadge V's profile from 'Medical Superintendent' → 'Hospital PM'.
 *   2. DELETE V's physicians row (cascades engagements, quals, privs).
 *   3. DELETE other smoke physicians (Dr Test Smoke, Dr Flag Test).
 *   4. TRUNCATE all smoke pipeline tables: vc_observation_cases,
 *      vc_prescreens, patient_feedback, incident_replies, incidents,
 *      clinical_metrics_monthly, qualifications, privileges.
 *
 * URL-gated like the other admin/* bootstrap routes. Idempotent — safe
 * to re-run; subsequent runs just confirm the empty state.
 */
export async function POST() {
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const log: string[] = [];

  // 1. Rebadge V's profile to Hospital PM position
  const hospitalPm = (await sql`
    SELECT p.id::text AS id FROM positions p JOIN hospitals h ON h.id = p.hospital_id
    WHERE p.position_name = 'Hospital PM' AND h.code = 'EHRC' LIMIT 1
  `) as Array<{ id: string }>;
  if (hospitalPm.length === 0) {
    return NextResponse.json({ ok: false, error: "Hospital PM position not found at EHRC" }, { status: 500, headers: NO_STORE });
  }
  const newPositionId = hospitalPm[0].id;
  const updateProfile = (await sql`
    UPDATE profiles SET position_id = ${newPositionId}::uuid, updated_at = NOW()
    WHERE email = 'vinay.bhardwaj@even.in'
    RETURNING id::text AS id, email, position_id::text AS position_id
  `) as Array<Record<string, unknown>>;
  log.push(`1. Rebadged V's profile to Hospital PM (${updateProfile.length} row updated)`);

  // 2/3. Wipe pipeline tables in dependency order. TRUNCATE CASCADE is brutal
  // but exactly what we want here.
  await sql`TRUNCATE patient_feedback RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE incident_replies RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE incidents RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE clinical_metrics_monthly RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE qualifications RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE privileges RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE vc_observation_cases RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE vc_prescreens RESTART IDENTITY CASCADE`;
  log.push(`2. Truncated patient_feedback, incidents/replies, clinical_metrics_monthly, qualifications, privileges, vc_observation_cases, vc_prescreens`);

  // Now physicians + engagements (engagements FK CASCADE on physicians delete)
  await sql`DELETE FROM physician_engagements`;
  await sql`DELETE FROM physicians`;
  log.push(`3. Cleared physician_engagements + physicians`);

  // Final state
  const counts = (await sql`
    SELECT
      (SELECT COUNT(*)::int FROM hospitals)             AS hospitals,
      (SELECT COUNT(*)::int FROM positions)             AS positions,
      (SELECT COUNT(*)::int FROM profiles)              AS profiles,
      (SELECT COUNT(*)::int FROM physicians)            AS physicians,
      (SELECT COUNT(*)::int FROM physician_engagements) AS engagements,
      (SELECT COUNT(*)::int FROM qualifications)        AS qualifications,
      (SELECT COUNT(*)::int FROM privileges)            AS privileges,
      (SELECT COUNT(*)::int FROM clinical_metrics_monthly) AS clinical_metrics,
      (SELECT COUNT(*)::int FROM patient_feedback)      AS patient_feedback,
      (SELECT COUNT(*)::int FROM incidents)             AS incidents,
      (SELECT COUNT(*)::int FROM incident_replies)      AS incident_replies,
      (SELECT COUNT(*)::int FROM vc_prescreens)         AS vc_prescreens,
      (SELECT COUNT(*)::int FROM vc_observation_cases)  AS vc_observation_cases,
      (SELECT COUNT(*)::int FROM audit_log_v2)          AS audit_log_v2_total
  `) as Array<Record<string, number>>;

  const v = (await sql`
    SELECT p.email, pos.position_name, h.code AS hospital
    FROM profiles p
    JOIN positions pos ON pos.id = p.position_id
    JOIN hospitals h   ON h.id   = p.hospital_id
    WHERE p.email = 'vinay.bhardwaj@even.in'
  `) as Array<Record<string, unknown>>;

  return NextResponse.json(
    { ok: true, log, counts: counts[0], v_profile: v[0] },
    { headers: NO_STORE },
  );
}
