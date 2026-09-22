import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { recordIngestMeta, runDocumentAuditIngest } from "@/lib/document-audit-ingest-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Document-audit ingest (Stage 4 slices A–C).
 * vercel.json schedules this at 01:00 UTC = 06:30 IST, after gov-snapshot.
 *
 * Auth matches /api/cron/gov-snapshot: CRON_SECRET bearer, vercel-cron user
 * agent, or any active signed-in governance user (admin trigger).
 * Idempotent upserts. Does not mint OT gov signals.
 *
 * Ops can scope the CDMSS export with query params (forwarded as-is when valid):
 *   ?note_class=ot
 *   ?window=30
 *   ?from=2026-09-01&to=2026-09-21
 * Unset params keep the export's own defaults. Cron runs without query string.
 */
async function allowed(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  const authz = req.headers.get("authorization") || "";
  if (secret && authz === `Bearer ${secret}`) return true;
  const ua = req.headers.get("user-agent") || "";
  if (ua.startsWith("vercel-cron/")) return true;
  const u = await getCurrentUser();
  return !!u && u.status === "active";
}

async function run(req: NextRequest) {
  if (!(await allowed(req))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const ua = req.headers.get("user-agent") || "";
  const mode = ua.startsWith("vercel-cron/") ? "cron" : "manual";
  try {
    const q = req.nextUrl.searchParams;
    const result = await runDocumentAuditIngest({
      window: q.get("window"),
      note_class: q.get("note_class"),
      from: q.get("from"),
      to: q.get("to"),
    });
    return NextResponse.json({ ...result, mode });
  } catch (e) {
    const message = e instanceof Error ? e.message : "ingest failed";
    try {
      await recordIngestMeta(`failed: ${message}`.slice(0, 800), false);
    } catch {
      // Meta row may be missing before migration 030. The error response still reports the failure.
    }
    const status = /GOV_API_KEY|document-audits-export|export_/.test(message) ? 502 : 500;
    return NextResponse.json({ ok: false, error: message, mode }, { status });
  }
}

export async function GET(req: NextRequest) {
  return run(req);
}

export async function POST(req: NextRequest) {
  return run(req);
}
