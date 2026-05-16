import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const rows = (await sql`
    SELECT
      pf.id::text AS id,
      h.code AS hospital_code,
      pf.feedback_period,
      pf.csat_score::float AS csat_score,
      pf.complaint_count,
      pf.source,
      pf.uploaded_at,
      p.email AS uploaded_by_email
    FROM patient_feedback pf
    JOIN hospitals h ON h.id = pf.hospital_id
    LEFT JOIN profiles p ON p.id = pf.uploaded_by
    WHERE pf.physician_id = ${id}::uuid
    ORDER BY pf.feedback_period DESC, pf.uploaded_at DESC
    LIMIT 100
  `) as Array<Record<string, unknown>>;
  return NextResponse.json({ ok: true, rows }, { headers: NO_STORE });
}
