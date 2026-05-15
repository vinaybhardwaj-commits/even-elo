import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENGAGEMENT_TYPES = new Set(["employed", "part_time", "visiting_consultant"]);
const ENGAGEMENT_STATUSES = new Set(["active", "probation", "terminated"]);

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const body = await req.json();
  const { hospital_code, engagement_type, start_date, end_date, specialty, status, terminated_reason } = body ?? {};

  if (!hospital_code) return NextResponse.json({ ok: false, error: "hospital_code required" }, { status: 400, headers: NO_STORE });
  if (!engagement_type || !ENGAGEMENT_TYPES.has(engagement_type)) {
    return NextResponse.json({ ok: false, error: "engagement_type must be employed|part_time|visiting_consultant" }, { status: 400, headers: NO_STORE });
  }
  if (!start_date) return NextResponse.json({ ok: false, error: "start_date required" }, { status: 400, headers: NO_STORE });
  const finalStatus = status && ENGAGEMENT_STATUSES.has(status) ? status : "active";

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const hosp = (await sql`
    SELECT id::text AS id FROM hospitals WHERE code = ${hospital_code} AND is_active = true LIMIT 1
  `) as Array<{ id: string }>;
  if (hosp.length === 0) return NextResponse.json({ ok: false, error: `hospital ${hospital_code} not active` }, { status: 400, headers: NO_STORE });

  const inserted = (await sql`
    INSERT INTO physician_engagements (
      physician_id, hospital_id, engagement_type, start_date, end_date, specialty, status, terminated_reason
    ) VALUES (
      ${id}::uuid, ${hosp[0].id}::uuid, ${engagement_type}, ${start_date},
      ${end_date ?? null}, ${specialty ?? null}, ${finalStatus}, ${terminated_reason ?? null}
    )
    RETURNING id::text AS id, physician_id::text AS physician_id, engagement_type, start_date, end_date, specialty, status, created_at
  `) as Array<Record<string, unknown>>;

  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
    VALUES (${actor.profileId}::uuid, 'create', 'engagement', ${inserted[0].id as string}, ${JSON.stringify(inserted[0])}::jsonb)
  `;
  return NextResponse.json({ ok: true, engagement: inserted[0] }, { headers: NO_STORE });
}
