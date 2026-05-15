import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/**
 * GET /api/admin/profiles?status=
 *
 * Returns the profile directory for super-admin views. Middleware enforces
 * super_admin on /api/admin/* paths.
 */
export async function GET(req: NextRequest) {
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const params = req.nextUrl.searchParams;
  const status = (params.get("status") ?? "").trim();

  const rows = (await sql`
    SELECT
      p.id::text          AS id,
      p.email,
      p.full_name,
      p.status,
      p.is_super_admin,
      p.is_sgc_member,
      p.is_hr,
      p.is_site_medical_head,
      pos.position_name   AS position_label,
      h.code              AS hospital_code,
      p.last_login_at,
      p.created_at
    FROM profiles p
    JOIN positions pos ON pos.id = p.position_id
    JOIN hospitals h   ON h.id   = p.hospital_id
    WHERE (${status} = '' OR p.status = ${status})
    ORDER BY
      CASE p.status WHEN 'pending_approval' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
      p.created_at DESC
  `) as Array<Record<string, unknown>>;

  // Aggregate counts for badge display
  const counts = (await sql`
    SELECT status, COUNT(*)::int AS n FROM profiles GROUP BY status
  `) as Array<{ status: string; n: number }>;
  const byStatus: Record<string, number> = {};
  for (const r of counts) byStatus[r.status] = r.n;

  return NextResponse.json(
    { ok: true, rows, counts: byStatus, total: rows.length },
    { headers: NO_STORE },
  );
}
