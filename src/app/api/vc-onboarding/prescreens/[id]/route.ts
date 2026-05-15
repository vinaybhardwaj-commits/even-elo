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
      v.id::text AS id,
      v.prospective_email,
      v.prospective_full_name,
      v.prospective_specialty,
      h.code AS hospital_code,
      h.name AS hospital_name,
      v.years_post_postgraduate,
      v.prior_corporate_hospitals,
      v.commitments_acknowledged,
      v.red_flags,
      v.decision,
      v.decision_rationale,
      v.cooldown_override,
      v.stage,
      pp.email AS prescreened_by_email,
      v.prescreened_at,
      v.decided_at,
      v.physician_id::text AS physician_id,
      v.created_at, v.updated_at
    FROM vc_prescreens v
    JOIN hospitals h  ON h.id = v.hospital_id
    JOIN profiles pp ON pp.id = v.prescreened_by
    WHERE v.id = ${id}::uuid
  `) as Array<Record<string, unknown>>;
  if (rows.length === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });
  return NextResponse.json({ ok: true, prescreen: rows[0] }, { headers: NO_STORE });
}
