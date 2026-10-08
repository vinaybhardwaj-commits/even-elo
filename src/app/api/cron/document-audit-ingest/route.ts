import { NextRequest, NextResponse } from "next/server";
import { cronGuard } from "@/lib/cron-auth";
import { recordIngestMeta, runDocumentAuditIngest } from "@/lib/document-audit-ingest-db";
import { retryResponseSyncs, type RetrySummary } from "@/lib/response-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Document-audit ingest (Stage 4 slices A–C).
 * vercel.json schedules this at 01:00 UTC = 06:30 IST, after gov-snapshot.
 *
 * Auth matches /api/cron/gov-snapshot: `Authorization: Bearer ${CRON_SECRET}` only
 * (src/lib/cron-auth.ts); a missing CRON_SECRET answers 503. Manual runs use the same bearer.
 * Idempotent upserts. Does not mint OT gov signals.
 *
 * After the ingest (success OR failure) the same run retries doctor responses that have not reached
 * CDMSS yet (src/lib/response-sync.ts). Its result is reported as `response_sync`; it can never fail
 * the ingest, and a failed ingest never skips it.
 *
 * Ops can scope the CDMSS export with query params (forwarded as-is when valid):
 *   ?note_class=ot
 *   ?window=30
 *   ?from=2026-09-01&to=2026-09-21
 * Unset params keep the export's own defaults. Cron runs without query string.
 */
async function run(req: NextRequest) {
  const denied = cronGuard(req, "/api/cron/document-audit-ingest");
  if (denied) return denied;
  const hasScope = ["window", "note_class", "from", "to"].some((k) => req.nextUrl.searchParams.has(k));
  const mode = hasScope ? "manual" : "cron";
  const responseSync = async (): Promise<RetrySummary | { error: string }> => {
    try {
      return await retryResponseSyncs();
    } catch (e) {
      return { error: e instanceof Error ? e.message.slice(0, 160) : "retry failed" };
    }
  };
  try {
    const q = req.nextUrl.searchParams;
    const result = await runDocumentAuditIngest({
      window: q.get("window"),
      note_class: q.get("note_class"),
      from: q.get("from"),
      to: q.get("to"),
    });
    return NextResponse.json({ ...result, mode, response_sync: await responseSync() });
  } catch (e) {
    const message = e instanceof Error ? e.message : "ingest failed";
    try {
      await recordIngestMeta(`failed: ${message}`.slice(0, 800), false);
    } catch {
      // Meta row may be missing before migration 030. The error response still reports the failure.
    }
    const status = /GOV_API_KEY|document-audits-export|export_/.test(message) ? 502 : 500;
    return NextResponse.json({ ok: false, error: message, mode, response_sync: await responseSync() }, { status });
  }
}

export async function GET(req: NextRequest) {
  return run(req);
}

export async function POST(req: NextRequest) {
  return run(req);
}
