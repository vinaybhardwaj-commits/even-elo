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
const FLAG_TO_ROLE: Record<string, string> = {
  is_sgc_member: "sgc_member",
  is_hr: "hr",
  is_site_medical_head: "site_medical_head",
};

/**
 * PATCH /api/admin/profiles/[id]
 *
 * Body: { status?, is_super_admin?, is_sgc_member?, is_hr?, is_site_medical_head? }
 *
 * v3.0a — boolean flags are NOT stored on profiles anymore. The legacy is_X toggles
 * here grant/revoke the role at the user's HOME hospital (profile.hospital_id).
 * Per-hospital granular grants come in v3.0c via the inline-expand 4x3 grid.
 * is_super_admin stays as a column (network-scoped).
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

  const before = (await sql`SELECT * FROM profiles_with_roles WHERE id = ${id}::uuid`) as Array<Record<string, unknown>>;
  if (before.length === 0) return NextResponse.json({ ok: false, error: "not found" }, { status: 404, headers: NO_STORE });
  const b = before[0];

  // Don't let an admin demote the only remaining active super_admin
  if (body.is_super_admin === false && b.is_super_admin === true) {
    const others = (await sql`
      SELECT COUNT(*)::int AS n FROM profiles WHERE is_super_admin = true AND id <> ${id}::uuid AND status = 'active'
    `) as Array<{ n: number }>;
    if (others[0].n === 0) {
      return NextResponse.json({ ok: false, error: "Cannot demote the last super_admin" }, { status: 409, headers: NO_STORE });
    }
  }

  if (body.status !== undefined && !ALLOWED_STATUS.has(body.status)) {
    return NextResponse.json({ ok: false, error: "invalid status" }, { status: 400, headers: NO_STORE });
  }

  // 1. Direct profiles column updates (status + is_super_admin)
  const nextStatus = body.status ?? b.status;
  const nextSuper  = body.is_super_admin ?? b.is_super_admin;
  await sql`
    UPDATE profiles SET
      status         = ${nextStatus as string},
      is_super_admin = ${Boolean(nextSuper)},
      updated_at     = NOW()
    WHERE id = ${id}::uuid
  `;

  // 2. Per-role flag toggles → profile_hospital_roles at home hospital
  const homeHospitalId = b.hospital_id as string | null;
  for (const [flag, role] of Object.entries(FLAG_TO_ROLE)) {
    if (body[flag] === undefined) continue;
    if (!homeHospitalId) continue; // can't grant at "no home" hospital
    if (body[flag] === true) {
      await sql`
        INSERT INTO profile_hospital_roles (profile_id, hospital_id, role, granted_by)
        VALUES (${id}::uuid, ${homeHospitalId}::uuid, ${role}, ${actor.profileId}::uuid)
        ON CONFLICT DO NOTHING
      `;
    } else {
      await sql`
        DELETE FROM profile_hospital_roles
         WHERE profile_id = ${id}::uuid
           AND hospital_id = ${homeHospitalId}::uuid
           AND role = ${role}
      `;
    }
  }

  // 3. Audit
  const after = (await sql`SELECT * FROM profiles_with_roles WHERE id = ${id}::uuid`) as Array<Record<string, unknown>>;
  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, before_json, after_json)
    VALUES (
      ${actor.profileId}::uuid, 'update', 'profile', ${id},
      ${JSON.stringify({ status: b.status, is_super_admin: b.is_super_admin, is_sgc_member: b.is_sgc_member, is_hr: b.is_hr, is_site_medical_head: b.is_site_medical_head })}::jsonb,
      ${JSON.stringify({ status: after[0].status, is_super_admin: after[0].is_super_admin, is_sgc_member: after[0].is_sgc_member, is_hr: after[0].is_hr, is_site_medical_head: after[0].is_site_medical_head })}::jsonb
    )
  `;
  return NextResponse.json({ ok: true, profile: after[0] }, { headers: NO_STORE });
}
