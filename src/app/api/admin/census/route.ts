import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";
import { getHospitalFilterId } from "@/lib/hospital-filter";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/**
 * GET /api/admin/census — DR.1.
 * Roster census, hospital-filter aware (Q-D). Counting rule (Q-E): one distinct
 * doctor per hospital (deduped within a hospital), counted again per other hospital.
 * VC vs Staff (Q-D3): VC if the doctor holds ANY visiting_consultant active engagement
 * at that hospital, else Staff. Specialty = primary_specialty (Q-D4).
 *  - by_hospital: [{ code, name, vc, staff, total }]
 *  - by_specialty: [{ specialty, vc, staff, total }]  (scoped by the global filter)
 */
export async function GET() {
  try { await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const hid = await getHospitalFilterId(); // null = all hospitals

  const byHospital = hid
    ? (await sql`
        WITH base AS (
          SELECT pe.hospital_id, pe.physician_id,
                 bool_or(pe.category = 'visiting_consultant') AS is_vc
          FROM physician_engagements pe JOIN physicians p ON p.id = pe.physician_id
          WHERE pe.status = 'active' AND p.current_status = 'active' AND pe.hospital_id = ${hid}::uuid
          GROUP BY pe.hospital_id, pe.physician_id)
        SELECT h.code, h.name,
          count(*) FILTER (WHERE base.is_vc)::int AS vc,
          count(*) FILTER (WHERE NOT base.is_vc)::int AS staff,
          count(*)::int AS total
        FROM base JOIN hospitals h ON h.id = base.hospital_id
        GROUP BY h.code, h.name ORDER BY h.name`) as Array<Record<string, unknown>>
    : (await sql`
        WITH base AS (
          SELECT pe.hospital_id, pe.physician_id,
                 bool_or(pe.category = 'visiting_consultant') AS is_vc
          FROM physician_engagements pe JOIN physicians p ON p.id = pe.physician_id
          WHERE pe.status = 'active' AND p.current_status = 'active'
          GROUP BY pe.hospital_id, pe.physician_id)
        SELECT h.code, h.name,
          count(*) FILTER (WHERE base.is_vc)::int AS vc,
          count(*) FILTER (WHERE NOT base.is_vc)::int AS staff,
          count(*)::int AS total
        FROM base JOIN hospitals h ON h.id = base.hospital_id
        GROUP BY h.code, h.name ORDER BY h.name`) as Array<Record<string, unknown>>;

  const bySpecialty = hid
    ? (await sql`
        WITH base AS (
          SELECT pe.hospital_id, pe.physician_id,
                 bool_or(pe.category = 'visiting_consultant') AS is_vc,
                 max(COALESCE(NULLIF(trim(p.primary_specialty), ''), 'Unspecified')) AS specialty
          FROM physician_engagements pe JOIN physicians p ON p.id = pe.physician_id
          WHERE pe.status = 'active' AND p.current_status = 'active' AND pe.hospital_id = ${hid}::uuid
          GROUP BY pe.hospital_id, pe.physician_id)
        SELECT specialty,
          count(*) FILTER (WHERE is_vc)::int AS vc,
          count(*) FILTER (WHERE NOT is_vc)::int AS staff,
          count(*)::int AS total
        FROM base GROUP BY specialty ORDER BY total DESC, specialty`) as Array<Record<string, unknown>>
    : (await sql`
        WITH base AS (
          SELECT pe.hospital_id, pe.physician_id,
                 bool_or(pe.category = 'visiting_consultant') AS is_vc,
                 max(COALESCE(NULLIF(trim(p.primary_specialty), ''), 'Unspecified')) AS specialty
          FROM physician_engagements pe JOIN physicians p ON p.id = pe.physician_id
          WHERE pe.status = 'active' AND p.current_status = 'active'
          GROUP BY pe.hospital_id, pe.physician_id)
        SELECT specialty,
          count(*) FILTER (WHERE is_vc)::int AS vc,
          count(*) FILTER (WHERE NOT is_vc)::int AS staff,
          count(*)::int AS total
        FROM base GROUP BY specialty ORDER BY total DESC, specialty`) as Array<Record<string, unknown>>;

  return NextResponse.json({ ok: true, scope: hid ? "hospital" : "all", by_hospital: byHospital, by_specialty: bySpecialty }, { headers: NO_STORE });
}
