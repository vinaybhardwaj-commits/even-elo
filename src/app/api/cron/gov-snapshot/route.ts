import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { storeSnapshot } from "@/lib/gov-signals";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Daily governance-signal snapshot cron (PRD v1.4 §6.1) — vercel.json schedules
 * this at 00:30 UTC = 06:00 IST, after the CDMSS audit cron (~05:30 IST).
 *
 * Also the one-time backfill: GET ?from=2026-06-27&to=2026-07-01 loops days
 * (admin cookie required for backfill; plain cron invocations store just the
 * latest audited day).
 *
 * Auth: Vercel cron (CRON_SECRET bearer if set, else vercel-cron user agent)
 * OR any active signed-in governance user. Idempotent upserts — harmless to re-run.
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

function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  const end = new Date(to + "T00:00:00Z").getTime();
  for (let t = new Date(from + "T00:00:00Z").getTime(); t <= end && out.length <= 120; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export async function GET(req: NextRequest) {
  if (!(await allowed(req))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from");
  const to = sp.get("to");
  try {
    if (from && to) {
      const results: Array<{ day: string; ok: boolean; error?: string }> = [];
      for (const day of dayRange(from, to)) {
        try {
          const r = await storeSnapshot(day);
          results.push({ day: r.day, ok: true });
        } catch (e) {
          results.push({ day, ok: false, error: e instanceof Error ? e.message : "failed" });
        }
      }
      return NextResponse.json({ ok: true, mode: "backfill", results });
    }
    const r = await storeSnapshot();
    return NextResponse.json({ ok: true, mode: "daily", stored: r });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "snapshot failed" },
      { status: 502 },
    );
  }
}
