import { NextResponse } from "next/server";
import { getCurrentPhysician } from "@/lib/physician-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Pick-lists (departments/locations/types) from even-incident master data. */
export async function GET() {
  const p = await getCurrentPhysician();
  if (!p) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const BASE = process.env.INCIDENT_API_BASE;
  const TOK = process.env.INCIDENT_API_TOKEN;
  if (process.env.PORTAL_INCIDENTS !== "1" || !BASE || !TOK) {
    return NextResponse.json({ ok: false, error: "Not enabled" }, { status: 404 });
  }
  try {
    const res = await fetch(`${BASE}/api/incident/meta`, {
      headers: { Authorization: `Bearer ${TOK}` },
      next: { revalidate: 600 },
      signal: AbortSignal.timeout(8000),
    });
    const j = await res.json();
    return NextResponse.json(j, { status: res.status });
  } catch {
    return NextResponse.json({ ok: false, error: "Incident system unreachable" }, { status: 502 });
  }
}
