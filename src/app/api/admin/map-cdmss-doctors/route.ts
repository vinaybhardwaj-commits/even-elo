import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { getSeries, signalKey } from "@/lib/gov-signals";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Populate physicians.cdmss_doctor_uid (PRD §6.5) by exact normalized-name
 * match against every affected[] doctor seen in the snapshot store — the
 * metabase_doctor_email pattern. uid is the stable key (v1.1 contract §3);
 * names can drift cosmetically, hence match-once-then-persist.
 * GET = preview, POST = apply unambiguous matches. super_admin only.
 */
function norm(name: string): string {
  return name
    .toLowerCase()
    .replace(/^dr\.?\s+/i, "")
    .replace(/[^a-z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function compute() {
  const series = await getSeries(120);
  const seen = new Map<string, string>(); // uid -> latest name
  for (const row of series) {
    for (const s of row.payload.report?.signals ?? []) {
      void signalKey(s);
      for (const a of s.affected ?? []) if (a.uid) seen.set(a.uid, a.name);
    }
  }
  const phys = (await sql`
    SELECT id, full_name, cdmss_doctor_uid FROM physicians WHERE current_status='active'`) as unknown as Array<{
    id: string;
    full_name: string;
    cdmss_doctor_uid: string | null;
  }>;
  const byNorm = new Map<string, Array<{ id: string; full_name: string }>>();
  for (const p of phys) {
    const k = norm(p.full_name);
    if (!byNorm.has(k)) byNorm.set(k, []);
    byNorm.get(k)!.push({ id: p.id, full_name: p.full_name });
  }
  const alreadyMapped = new Set(phys.filter((p) => p.cdmss_doctor_uid).map((p) => p.cdmss_doctor_uid as string));
  const matches: Array<{ uid: string; name: string; physician_id: string; physician_name: string }> = [];
  const ambiguous: Array<{ uid: string; name: string; candidates: number }> = [];
  const unmatched: Array<{ uid: string; name: string }> = [];
  for (const [uid, name] of Array.from(seen.entries())) {
    if (alreadyMapped.has(uid)) continue;
    const cands = byNorm.get(norm(name)) ?? [];
    if (cands.length === 1) matches.push({ uid, name, physician_id: cands[0].id, physician_name: cands[0].full_name });
    else if (cands.length > 1) ambiguous.push({ uid, name, candidates: cands.length });
    else unmatched.push({ uid, name });
  }
  return { seen: seen.size, alreadyMapped: alreadyMapped.size, matches, ambiguous, unmatched };
}

export async function GET() {
  const u = await getCurrentUser();
  if (!u || !u.is_super_admin) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  return NextResponse.json({ ok: true, mode: "preview", ...(await compute()) });
}

export async function POST() {
  const u = await getCurrentUser();
  if (!u || !u.is_super_admin) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  const r = await compute();
  let applied = 0;
  for (const m of r.matches) {
    await sql`UPDATE physicians SET cdmss_doctor_uid=${m.uid} WHERE id=${m.physician_id}::uuid AND cdmss_doctor_uid IS NULL`;
    applied++;
  }
  return NextResponse.json({ ok: true, mode: "apply", applied, ambiguous: r.ambiguous, unmatched: r.unmatched });
}
