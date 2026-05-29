import { NextResponse } from "next/server";
import { clearPhysicianCookie } from "@/lib/physician-auth";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST() { await clearPhysicianCookie(); return NextResponse.json({ ok: true }); }
