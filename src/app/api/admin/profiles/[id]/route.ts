import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_STATUS = new Set(["pending_approval", "active", "suspended", "rejected"]);

/**
 * PATCH /api/admin/profiles/[id]
 *
 * Body: { status?, is_super_admin?, is_sgc_member?, is_hr?, is_site_medical_head? }
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  let actor;
  try {
    actor = await actorFromRequest();
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE });
  }

  const body = await req.json();
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const before = (await sql`SELECT * FROM profiles WHERE id = ${id}::uuid`) as Array<Record<string, unknown>>;
  if (before.length === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });
  const b = before[0];

  // Don't let an admin demote the only remaining super_admin
  if (body.is_super_admin === false && b.is_super_admin === true) {
    const others = (await sql`
      SELECT COUNT(*)::int AS n FROM profiles WHERE is_super_admin = true AND id <> ${id}::uuid AND status = 'active'
    `) as Array<{ n: number }>;
    if (others[0].n === 0) {
      return NextResponse.json(
        { ok: false, error: "Cannot demote the last super_admin" },
        { status: 409, headers: NO_STORE },
      );
    }
  }

  if (body.status !== undefined && !ALLOWED_STATUS.has(body.status)) {
    return NextResponse.json({ ok: false, error: "invalid status" }, { status: 400, headers: NO_STORE });
  }

  const merged = {
    status: body.status ?? b.status,
    is_super_admin: body.is_super_admin ?? b.is_super_admin,
    is_sgc_member: body.is_sgc_member ?? b.is_sgc_member,
    is_hr: body.is_hr ?? b.is_hr,
    is_site_medical_head: body.is_site_medical_head ?? b.is_site_medical_head,
  };

  await sql`
    UPDATE profiles SET
      status              = ${merged.status as string},
      is_super_admin      = ${Boolean(merged.is_super_admin)},
      is_sgc_member       = ${Boolean(merged.is_sgc_member)},
      is_hr               = ${Boolean(merged.is_hr)},
      is_site_medical_head= ${Boolean(merged.is_site_medical_head)},
      updated_at          = NOW()
    WHERE id = ${id}::uuid
  `;

  const after = (await sql`SELECT * FROM profiles WHERE id = ${id}::uuid`) as Array<Record<string, unknown>>;
  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, before_json, after_json)
    VALUES (${actor.profileId}::uuid, 'update', 'profile', ${id}, ${JSON.stringify({ status: b.status, is_super_admin: b.is_super_admin, is_sgc_member: b.is_sgc_member, is_hr: b.is_hr, is_site_medical_head: b.is_site_medical_head })}::jsonb, ${JSON.stringify({ status: merged.status, is_super_admin: merged.is_super_admin, is_sgc_member: merged.is_sgc_member, is_hr: merged.is_hr, is_site_medical_head: merged.is_site_medical_head })}::jsonb)
  `;
  return NextResponse.json({ ok: true, profile: after[0] }, { headers: NO_STORE });
}
