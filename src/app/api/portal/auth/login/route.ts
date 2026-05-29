import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { createPhysicianToken, setPhysicianCookie, verifyPortalPin } from "@/lib/physician-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

export async function POST(request: NextRequest) {
  const { email, pin } = (await request.json().catch(() => ({}))) as { email?: string; pin?: string };
  if (!email || !pin) return NextResponse.json({ ok: false, error: "Email and PIN are required" }, { status: 400, headers: NO_STORE });

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const rows = (await sql`
    SELECT id::text AS id, full_name, email, portal_pin_hash, portal_access, portal_must_change_pin, current_status
    FROM physicians WHERE lower(email) = ${String(email).toLowerCase().trim()} LIMIT 1
  `) as Array<Record<string, unknown>>;
  if (rows.length === 0) return NextResponse.json({ ok: false, error: "No portal account found with this email." }, { status: 401, headers: NO_STORE });
  const p = rows[0];

  if (!p.portal_access) return NextResponse.json({ ok: false, error: "Portal access isn't enabled for this account. Ask an administrator to enable it." }, { status: 403, headers: NO_STORE });
  if (p.current_status !== "active") return NextResponse.json({ ok: false, error: "This account is not active." }, { status: 403, headers: NO_STORE });
  if (!p.portal_pin_hash) return NextResponse.json({ ok: false, error: "No PIN set. Ask an administrator to set a temporary PIN." }, { status: 403, headers: NO_STORE });

  const ok = await verifyPortalPin(String(pin), p.portal_pin_hash as string);
  if (!ok) return NextResponse.json({ ok: false, error: "Incorrect PIN." }, { status: 401, headers: NO_STORE });

  const token = await createPhysicianToken({
    kind: "physician", physicianId: p.id as string, email: p.email as string,
    full_name: p.full_name as string, portal_must_change_pin: Boolean(p.portal_must_change_pin),
  });
  await setPhysicianCookie(token);
  return NextResponse.json({ ok: true, must_change_pin: Boolean(p.portal_must_change_pin) }, { headers: NO_STORE });
}
