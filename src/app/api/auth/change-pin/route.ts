import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import {
  getCurrentUser,
  hashPin,
  verifyPin,
  isValidPin,
} from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Not authenticated" },
        { status: 401 },
      );
    }
    const body = await request.json();
    const { old_pin, new_pin } = body ?? {};
    if (!old_pin || !new_pin) {
      return NextResponse.json(
        { ok: false, error: "old_pin and new_pin are required" },
        { status: 400 },
      );
    }
    if (!isValidPin(new_pin)) {
      return NextResponse.json(
        { ok: false, error: "New PIN must be 4 digits" },
        { status: 400 },
      );
    }

    const url = process.env.DATABASE_URL;
    if (!url) {
      return NextResponse.json(
        { ok: false, error: "DATABASE_URL not configured" },
        { status: 500 },
      );
    }
    const sql = neon(url);

    const rows = (await sql`
      SELECT password_hash FROM profiles WHERE id = ${user.profileId}::uuid LIMIT 1
    `) as Array<{ password_hash: string }>;
    if (rows.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Profile not found" },
        { status: 404 },
      );
    }
    const ok = await verifyPin(String(old_pin), rows[0].password_hash);
    if (!ok) {
      return NextResponse.json(
        { ok: false, error: "Old PIN incorrect" },
        { status: 401 },
      );
    }

    const newHash = await hashPin(String(new_pin));
    await sql`UPDATE profiles SET password_hash = ${newHash}, updated_at = NOW() WHERE id = ${user.profileId}::uuid`;
    return NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
