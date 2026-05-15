import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const limitParam = parseInt(req.nextUrl.searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(200, limitParam)) : 50;

  // Audit rows where entity_id matches this physician OR matches an engagement that belongs to this physician.
  const engIds = (await sql`SELECT id::text AS id FROM physician_engagements WHERE physician_id = ${id}::uuid`) as Array<{ id: string }>;
  const engIdList = engIds.map((r) => r.id);

  const rows = (await sql`
    SELECT
      a.id,
      a.action,
      a.entity_type,
      a.entity_id,
      a.before_json,
      a.after_json,
      a.created_at,
      p.email AS actor_email,
      pos.position_name AS actor_position
    FROM audit_log_v2 a
    LEFT JOIN profiles p ON p.id = a.actor_user_id
    LEFT JOIN positions pos ON pos.id = p.position_id
    WHERE
      (a.entity_type = 'physician' AND a.entity_id = ${id})
      OR (a.entity_type = 'engagement' AND a.entity_id = ANY(${engIdList}::text[]))
    ORDER BY a.created_at DESC
    LIMIT ${limit}
  `) as Array<Record<string, unknown>>;

  return NextResponse.json({ ok: true, rows }, { headers: NO_STORE });
}
