import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string; prid: string }> }) {
  const { id, prid } = await ctx.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(prid)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const body = await req.json();
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const before = (await sql`
    SELECT id::text AS id, physician_id::text AS physician_id, procedure_or_specialty, granted_date, withdrawn_date, withdrawn_reason
    FROM privileges WHERE id = ${prid}::uuid AND physician_id = ${id}::uuid
  `) as Array<Record<string, unknown>>;
  if (before.length === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });
  const b = before[0];

  const merged = {
    withdrawn_date: body.withdrawn_date !== undefined ? body.withdrawn_date : b.withdrawn_date,
    withdrawn_reason: body.withdrawn_reason !== undefined ? body.withdrawn_reason : b.withdrawn_reason,
  };

  await sql`
    UPDATE privileges SET
      withdrawn_date   = ${(merged.withdrawn_date as string | null) ?? null},
      withdrawn_reason = ${(merged.withdrawn_reason as string | null) ?? null}
    WHERE id = ${prid}::uuid
  `;
  const after = (await sql`SELECT id::text AS id, physician_id::text AS physician_id, withdrawn_date, withdrawn_reason FROM privileges WHERE id = ${prid}::uuid`) as Array<Record<string, unknown>>;
  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, before_json, after_json)
    VALUES (
      ${actor.profileId}::uuid,
      ${body.withdrawn_date ? "withdraw" : "update"},
      'privilege',
      ${prid},
      ${JSON.stringify(b)}::jsonb,
      ${JSON.stringify({ ...after[0], physician_id: id })}::jsonb
    )
  `;
  return NextResponse.json({ ok: true, privilege: after[0] }, { headers: NO_STORE });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string; prid: string }> }) {
  const { id, prid } = await ctx.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(prid)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const before = (await sql`SELECT id::text AS id, procedure_or_specialty FROM privileges WHERE id = ${prid}::uuid AND physician_id = ${id}::uuid`) as Array<Record<string, unknown>>;
  if (before.length === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });

  await sql`DELETE FROM privileges WHERE id = ${prid}::uuid`;
  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, before_json)
    VALUES (${actor.profileId}::uuid, 'delete', 'privilege', ${prid}, ${JSON.stringify({ ...before[0], physician_id: id })}::jsonb)
  `;
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
