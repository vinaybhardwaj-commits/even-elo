import { NextResponse } from "next/server";
import { getCurrentPhysician } from "@/lib/physician-auth";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Portal home: What's new / Coming soon (R5 PRD §4) + feature flags.
 * Content managed via governance MCP tools — see /api/mcp portal-announcement tools.
 */
export async function GET() {
  const p = await getCurrentPhysician();
  if (!p) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const rows = (await sql`
    SELECT id, kind, title, body FROM portal_announcements
    WHERE active = true
      AND (starts_on IS NULL OR starts_on <= current_date)
      AND (ends_on IS NULL OR ends_on >= current_date)
    ORDER BY kind, sort ASC, created_at DESC
    LIMIT 20`) as unknown as Array<{ id: string; kind: string; title: string; body: string | null }>;
  return NextResponse.json({
    ok: true,
    whats_new: rows.filter((r) => r.kind === "whats_new"),
    coming_soon: rows.filter((r) => r.kind === "coming_soon"),
    // WM2: the Findings flag is evaluated HERE and nowhere else — server-side, so the portal
    // bundle never carries the env name, and one fetch decides both panels' visibility.
    features: {
      incidents: process.env.PORTAL_INCIDENTS === "1",
      findings: process.env.PORTAL_FINDINGS === "1",
      // WM2 v1: private research reactions remain independently gated.
      reactions: process.env.PORTAL_REACTIONS === "1",
      // P2: workflow writes are independent of private research reactions and default dark.
      findingsRespond: process.env.PORTAL_FINDINGS_RESPOND === "1",
    },
  });
}
