import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCORE_DIMENSIONS = [
  "teamwork", "emr_documentation", "ot_etiquette",
  "protocol_adherence", "outcome", "demeanor",
] as const;
const FLAG_SEVERITIES = new Set(["none", "concern", "immediate_termination_recommended"]);
const OBSERVER_ROLES = [
  "OT Coordinator", "Anesthesia Coordinator", "ICN Lead",
  "Nurse-in-Charge", "Medical Superintendent", "Site Medical Head",
];

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);
  const rows = (await sql`
    SELECT
      c.id::text AS id,
      c.case_number,
      c.case_date,
      c.procedure,
      c.observer_role,
      c.observer_name,
      c.scores,
      c.narrative_notes,
      c.flag_severity,
      p.email AS observer_email,
      c.created_at
    FROM vc_observation_cases c
    JOIN profiles p ON p.id = c.observer_user_id
    WHERE c.prescreen_id = ${id}::uuid
    ORDER BY c.case_number ASC
  `) as Array<Record<string, unknown>>;
  return NextResponse.json({ ok: true, rows, allowed_roles: OBSERVER_ROLES }, { headers: NO_STORE });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400, headers: NO_STORE });

  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const body = await req.json();
  const { case_date, procedure, observer_role, scores, narrative_notes, flag_severity, hospital_id } = body ?? {};

  if (!case_date || !procedure || !observer_role) {
    return NextResponse.json({ ok: false, error: "case_date, procedure, observer_role required" }, { status: 400, headers: NO_STORE });
  }
  if (!hospital_id || typeof hospital_id !== "string") {
    return NextResponse.json({ ok: false, error: "hospital_id required (pick the hospital this case happened at)" }, { status: 400, headers: NO_STORE });
  }
  if (!scores || typeof scores !== "object") {
    return NextResponse.json({ ok: false, error: "scores object required" }, { status: 400, headers: NO_STORE });
  }
  const cleanScores: Record<string, number> = {};
  for (const dim of SCORE_DIMENSIONS) {
    const v = Number((scores as Record<string, unknown>)[dim]);
    if (!Number.isFinite(v) || v < 1 || v > 5) {
      return NextResponse.json({ ok: false, error: `scores.${dim} must be 1-5` }, { status: 400, headers: NO_STORE });
    }
    cleanScores[dim] = Math.round(v);
  }
  const finalFlag = flag_severity && FLAG_SEVERITIES.has(flag_severity) ? flag_severity : "none";

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  // Verify prescreen exists + is in observation stage
  const psRows = (await sql`
    SELECT id::text AS id, stage, prospective_full_name, prospective_email FROM vc_prescreens WHERE id = ${id}::uuid
  `) as Array<{ id: string; stage: string; prospective_full_name: string; prospective_email: string }>;
  if (psRows.length === 0) return NextResponse.json({ ok: false, error: "prescreen not found" }, { status: 404, headers: NO_STORE });
  const ps = psRows[0];
  if (!["observation", "decision"].includes(ps.stage)) {
    return NextResponse.json({ ok: false, error: `Cannot add observation in stage '${ps.stage}'` }, { status: 409, headers: NO_STORE });
  }
  const hospOk = (await sql`
    SELECT 1 FROM vc_prescreen_hospitals WHERE prescreen_id = ${id}::uuid AND hospital_id = ${hospital_id}::uuid LIMIT 1
  `) as Array<unknown>;
  if (hospOk.length === 0) {
    return NextResponse.json({ ok: false, error: "hospital_id is not one of the prescreen's hospitals" }, { status: 400, headers: NO_STORE });
  }

  // Auto-assign case_number = max + 1 (cap 5)
  const cnt = (await sql`SELECT COALESCE(MAX(case_number), 0) + 1 AS next FROM vc_observation_cases WHERE prescreen_id = ${id}::uuid`) as Array<{ next: number }>;
  const caseNumber = cnt[0].next;
  if (caseNumber > 5) {
    return NextResponse.json({ ok: false, error: "Maximum 5 observation cases reached" }, { status: 409, headers: NO_STORE });
  }

  // Fetch observer profile name (snapshot)
  const me = (await sql`SELECT full_name FROM profiles WHERE id = ${actor.profileId}::uuid`) as Array<{ full_name: string }>;
  const observerName = me[0]?.full_name ?? actor.email;

  const inserted = (await sql`
    INSERT INTO vc_observation_cases (
      prescreen_id, case_number, case_date, procedure,
      observer_role, observer_user_id, observer_name,
      scores, narrative_notes, flag_severity, hospital_id
    ) VALUES (
      ${id}::uuid, ${caseNumber}, ${case_date}, ${String(procedure).trim()},
      ${String(observer_role).trim()}, ${actor.profileId}::uuid, ${observerName},
      ${JSON.stringify(cleanScores)}::jsonb, ${narrative_notes ?? null}, ${finalFlag}, ${hospital_id}::uuid
    )
    RETURNING id::text AS id, case_number, case_date, procedure, observer_role, observer_name, scores, flag_severity, hospital_id::text AS hospital_id, created_at
  `) as Array<Record<string, unknown>>;

  // Auto-advance to 'decision' stage:
  //   - after 3rd case (PRD: minimum 3 cases trigger decision)
  //   - OR immediately if flag_severity='immediate_termination_recommended'
  let advancedTo: string | null = null;
  if (caseNumber >= 3 || finalFlag === "immediate_termination_recommended") {
    if (ps.stage !== "decision") {
      await sql`UPDATE vc_prescreens SET stage = 'decision', updated_at = NOW() WHERE id = ${id}::uuid`;
      advancedTo = "decision";
    }
  }

  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
    VALUES (
      ${actor.profileId}::uuid,
      ${finalFlag === "immediate_termination_recommended" ? "flag" : "create"},
      'vc_observation',
      ${inserted[0].id as string},
      ${JSON.stringify({
        prescreen_id: id,
        case_number: caseNumber,
        observer_role,
        flag_severity: finalFlag,
        avg_score: Object.values(cleanScores).reduce((a, b) => a + b, 0) / SCORE_DIMENSIONS.length,
        advanced_to: advancedTo,
      })}::jsonb
    )
  `;

  // Email stub for immediate-termination flag (Resend deferred)
  if (finalFlag === "immediate_termination_recommended") {
    console.log(JSON.stringify({
      epi_email_stub: "vc_immediate_termination_flag",
      prescreen_id: id,
      prospective_email: ps.prospective_email,
      prospective_full_name: ps.prospective_full_name,
      case_number: caseNumber,
      observer_user_id: actor.profileId,
      observer_role,
      escalated_at: new Date().toISOString(),
    }));
  }

  return NextResponse.json(
    { ok: true, observation: inserted[0], advanced_to: advancedTo },
    { headers: NO_STORE },
  );
}
