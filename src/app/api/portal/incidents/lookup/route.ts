import { NextRequest, NextResponse } from "next/server";
import { getCurrentPhysician } from "@/lib/physician-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Anonymous reference-code lookup (Ask C): status-only, no identity. */
export async function GET(req: NextRequest) {
  const p = await getCurrentPhysician();
  if (!p) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const BASE = process.env.INCIDENT_API_BASE;
  const TOK = process.env.INCIDENT_API_TOKEN;
  if (process.env.PORTAL_INCIDENTS !== "1" || !BASE || !TOK) {
    return NextResponse.json({ ok: false, error: "Not enabled" }, { status: 404 });
  }
  const ref = (req.nextUrl.searchParams.get("ref") || "").trim().toUpperCase();
  if (!/^EHRC-INC-\d{4}-\d{1,6}$/.test(ref)) {
    return NextResponse.json({ ok: false, error: "Reference looks like EHRC-INC-2026-0001" }, { status: 400 });
  }
  try {
    const res = await fetch(`${BASE}/api/intake/portal/reports/by-reference/${encodeURIComponent(ref)}`, {
      headers: { Authorization: `Bearer ${TOK}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const j = await res.json();
    return NextResponse.json(j, { status: res.status });
  } catch {
    return NextResponse.json({ ok: false, error: "Incident system unreachable" }, { status: 502 });
  }
}
