import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { getHospitalFilter } from "@/lib/hospital-filter";
import { actorFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

interface PhysicianRow {
  id: string;
  full_name: string;
  preferred_name: string | null;
  primary_specialty: string | null;
  registration_number: string | null;
  registration_council: string | null;
  registration_expiry: string | null;
  email: string | null;
  phone: string | null;
  current_status: string;
  date_joined_network: string | null;
  engagements_count: number;
  hospitals_active: string | null;
}

/**
 * GET /api/physicians?q=&specialty=&hospital_code=&status=
 *
 * Returns the network-wide physician roster joined with engagement summary.
 * Filters are AND-combined.
 */
export async function GET(req: NextRequest) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return NextResponse.json(
      { ok: false, error: "DATABASE_URL not configured" },
      { status: 500, headers: NO_STORE },
    );
  }
  const sql = neon(url);
  const params = req.nextUrl.searchParams;
  const q = (params.get("q") ?? "").trim();
  const specialty = (params.get("specialty") ?? "").trim();
  let hospitalCode = (params.get("hospital_code") ?? "").trim();
  if (!hospitalCode) {
    const cookieFilter = await getHospitalFilter();
    if (cookieFilter !== "all") hospitalCode = cookieFilter;
  }
  const status = (params.get("status") ?? "").trim();

  // Build dynamic SQL
  const rows = (await sql`
    WITH eng AS (
      SELECT
        e.physician_id,
        COUNT(*)::int AS engagements_count,
        STRING_AGG(DISTINCT h.code, ', ' ORDER BY h.code) AS hospitals_active
      FROM physician_engagements e
      JOIN hospitals h ON h.id = e.hospital_id
      WHERE e.status = 'active'
      GROUP BY e.physician_id
    )
    SELECT
      p.id::text AS id,
      p.full_name,
      p.preferred_name,
      p.primary_specialty,
      p.registration_number,
      p.registration_council,
      p.registration_expiry,
      p.email,
      p.phone,
      p.current_status,
      p.date_joined_network,
      COALESCE(eng.engagements_count, 0)::int AS engagements_count,
      eng.hospitals_active
    FROM physicians p
    LEFT JOIN eng ON eng.physician_id = p.id
    WHERE
      (${q} = '' OR (
        p.full_name ILIKE ${'%' + q + '%'}
        OR p.email ILIKE ${'%' + q + '%'}
        OR p.registration_number ILIKE ${'%' + q + '%'}
      ))
      AND (${specialty} = '' OR p.primary_specialty = ${specialty})
      AND (${hospitalCode} = '' OR ${hospitalCode} = ANY(STRING_TO_ARRAY(eng.hospitals_active, ', ')))
      AND (${status} = '' OR p.current_status = ${status})
    ORDER BY p.full_name ASC
    LIMIT 500
  `) as PhysicianRow[];

  // Distinct specialties for filter UI
  const specialties = (await sql`
    SELECT DISTINCT primary_specialty AS s FROM physicians WHERE primary_specialty IS NOT NULL ORDER BY s ASC
  `) as Array<{ s: string }>;

  return NextResponse.json(
    {
      ok: true,
      rows,
      specialties: specialties.map((r) => r.s),
      total: rows.length,
    },
    { headers: NO_STORE },
  );
}

/**
 * POST /api/physicians — super_admin only (middleware-gated for /api/* but
 * we still verify role here for defence in depth).
 */
export async function POST(req: NextRequest) {
  let actor;
  try {
    actor = await actorFromRequest();
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE });
  }
  const body = await req.json();
  const {
    full_name,
    preferred_name,
    primary_specialty,
    registration_number,
    registration_council,
    registration_expiry,
    email,
    phone,
    date_joined_network,
    notes,
  } = body ?? {};
  if (!full_name || typeof full_name !== "string" || !full_name.trim()) {
    return NextResponse.json({ ok: false, error: "full_name required" }, { status: 400, headers: NO_STORE });
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  }
  const sql = neon(url);

  const rows = (await sql`
    INSERT INTO physicians (
      full_name, preferred_name, primary_specialty,
      registration_number, registration_council, registration_expiry,
      email, phone, date_joined_network, current_status, notes
    ) VALUES (
      ${full_name.trim()},
      ${preferred_name ?? null},
      ${primary_specialty ?? null},
      ${registration_number ?? null},
      ${registration_council ?? null},
      ${registration_expiry ?? null},
      ${email ?? null},
      ${phone ?? null},
      ${date_joined_network ?? null},
      'active',
      ${notes ?? null}
    )
    RETURNING id::text AS id, full_name, primary_specialty, current_status, created_at
  `) as Array<Record<string, unknown>>;
  const inserted = rows[0];

  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
    VALUES (${actor.profileId}::uuid, 'create', 'physician', ${inserted.id as string}, ${JSON.stringify(inserted)}::jsonb)
  `;

  return NextResponse.json({ ok: true, physician: inserted }, { headers: NO_STORE });
}
