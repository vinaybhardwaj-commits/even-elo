import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

export async function GET() {
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false }, { status: 500 });
  const sql = neon(url);
  const r = await sql`
    SELECT
      (SELECT count(*) FROM vcs)::int AS vcs,
      (SELECT count(*) FROM physicians)::int AS physicians,
      (SELECT count(*) FROM profiles)::int AS profiles,
      (SELECT count(*) FROM positions)::int AS positions,
      (SELECT count(*) FROM hospitals)::int AS hospitals,
      now() AS db_now,
      (SELECT email FROM profiles LIMIT 1) AS sample_email
  `;
  return NextResponse.json(
    { ok: true, data: r[0] },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
