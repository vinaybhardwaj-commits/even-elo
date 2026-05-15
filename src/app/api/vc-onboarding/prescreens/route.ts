import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

const COOLDOWN_MONTHS = 12;

const REQUIRED_COMMITMENTS = [
  "ot_timings",
  "formulary",
  "vendor_mou",
  "rental_equipment",
  "weekend_protocol",
];

export async function GET(req: NextRequest) {
  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  // Visibility: super_admin / is_site_medical_head / is_hr see all; others see nothing.
  const me = (await sql`SELECT is_super_admin, is_site_medical_head, is_hr FROM profiles WHERE id = ${actor.profileId}::uuid`) as Array<{ is_super_admin: boolean; is_site_medical_head: boolean; is_hr: boolean }>;
  if (me.length === 0) return NextResponse.json({ ok: false, error: "no profile" }, { status: 401, headers: NO_STORE });
  const allowed = me[0].is_super_admin || me[0].is_site_medical_head || me[0].is_hr;
  if (!allowed) return NextResponse.json({ ok: true, rows: [], counts: {}, total: 0 }, { headers: NO_STORE });

  const params = req.nextUrl.searchParams;
  const stage = (params.get("stage") ?? "").trim();

  const rows = (await sql`
    SELECT
      v.id::text AS id,
      v.prospective_email,
      v.prospective_full_name,
      v.prospective_specialty,
      h.code AS hospital_code,
      v.years_post_postgraduate,
      v.prior_corporate_hospitals,
      v.red_flags,
      v.decision,
      v.decision_rationale,
      v.stage,
      v.cooldown_override,
      pp.email AS prescreened_by_email,
      v.prescreened_at,
      v.decided_at,
      v.physician_id::text AS physician_id,
      v.created_at
    FROM vc_prescreens v
    JOIN hospitals h  ON h.id = v.hospital_id
    JOIN profiles pp ON pp.id = v.prescreened_by
    WHERE (${stage} = '' OR v.stage = ${stage})
    ORDER BY v.created_at DESC
    LIMIT 500
  `) as Array<Record<string, unknown>>;

  const counts = (await sql`SELECT stage, COUNT(*)::int AS n FROM vc_prescreens GROUP BY stage`) as Array<{ stage: string; n: number }>;
  const byStage: Record<string, number> = {};
  for (const r of counts) byStage[r.stage] = r.n;

  return NextResponse.json({ ok: true, rows, counts: byStage, total: rows.length }, { headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  let actor;
  try { actor = await actorFromRequest(); }
  catch { return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE }); }

  const body = await req.json();
  const {
    prospective_email,
    prospective_full_name,
    prospective_specialty,
    hospital_code,
    years_post_postgraduate,
    prior_corporate_hospitals,
    commitments_acknowledged,
    red_flags,
    decision,           // 'invite' | 'reject' (required — the prescreen action)
    decision_rationale,
    cooldown_override,
  } = body ?? {};

  if (!prospective_email || !prospective_full_name) {
    return NextResponse.json({ ok: false, error: "prospective_email + prospective_full_name required" }, { status: 400, headers: NO_STORE });
  }
  if (!hospital_code) {
    return NextResponse.json({ ok: false, error: "hospital_code required" }, { status: 400, headers: NO_STORE });
  }
  if (decision !== "invite" && decision !== "reject") {
    return NextResponse.json({ ok: false, error: "decision must be 'invite' or 'reject'" }, { status: 400, headers: NO_STORE });
  }

  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  // Role gate: super_admin OR is_site_medical_head OR is_hr
  const me = (await sql`SELECT is_super_admin, is_site_medical_head, is_hr FROM profiles WHERE id = ${actor.profileId}::uuid`) as Array<{ is_super_admin: boolean; is_site_medical_head: boolean; is_hr: boolean }>;
  if (me.length === 0) return NextResponse.json({ ok: false, error: "no profile" }, { status: 401, headers: NO_STORE });
  if (!(me[0].is_super_admin || me[0].is_site_medical_head || me[0].is_hr)) {
    return NextResponse.json({ ok: false, error: "Forbidden — pre-screen requires super_admin, Site Medical Head, or HR" }, { status: 403, headers: NO_STORE });
  }

  // Cooldown: refuse new pre-screens for emails rejected within COOLDOWN_MONTHS
  // unless super_admin sets cooldown_override.
  const lowerEmail = String(prospective_email).toLowerCase().trim();
  // Use INTERVAL '1 month' * N — clean parameterised expression that Neon
  // tagged templates accept without text concatenation hijinks.
  const recentReject = (await sql`
    SELECT id::text AS id, prescreened_at FROM vc_prescreens
    WHERE lower(prospective_email) = ${lowerEmail}
      AND decision = 'reject'
      AND prescreened_at > NOW() - (INTERVAL '1 month' * ${COOLDOWN_MONTHS})
    ORDER BY prescreened_at DESC LIMIT 1
  `) as Array<{ id: string; prescreened_at: string }>;
  if (recentReject.length > 0) {
    if (!cooldown_override) {
      return NextResponse.json(
        { ok: false, error: `Email is within ${COOLDOWN_MONTHS}-month cooldown after prior reject on ${(recentReject[0].prescreened_at as string).slice(0, 10)}. Set cooldown_override=true (super_admin only) to bypass.`, prior_reject_id: recentReject[0].id },
        { status: 409, headers: NO_STORE },
      );
    }
    if (!me[0].is_super_admin) {
      return NextResponse.json({ ok: false, error: "Only super_admin can override the cooldown" }, { status: 403, headers: NO_STORE });
    }
  }

  // Hospital lookup
  const hosp = (await sql`SELECT id::text AS id FROM hospitals WHERE code = ${hospital_code} AND is_active = true LIMIT 1`) as Array<{ id: string }>;
  if (hosp.length === 0) return NextResponse.json({ ok: false, error: `Hospital ${hospital_code} not active` }, { status: 400, headers: NO_STORE });

  // Build commitments jsonb — accept only known keys + booleans
  const commitments: Record<string, boolean> = {};
  if (commitments_acknowledged && typeof commitments_acknowledged === "object") {
    for (const k of REQUIRED_COMMITMENTS) {
      commitments[k] = Boolean((commitments_acknowledged as Record<string, unknown>)[k]);
    }
  } else {
    for (const k of REQUIRED_COMMITMENTS) commitments[k] = false;
  }

  const priors = Array.isArray(prior_corporate_hospitals)
    ? prior_corporate_hospitals.filter((x: unknown) => typeof x === "string" && (x as string).trim().length > 0).slice(0, 20)
    : [];

  const stage = decision === "invite" ? "observation" : "rejected";

  const inserted = (await sql`
    INSERT INTO vc_prescreens (
      prospective_email, prospective_full_name, prospective_specialty, hospital_id,
      years_post_postgraduate, prior_corporate_hospitals, commitments_acknowledged, red_flags,
      decision, decision_rationale, cooldown_override, stage,
      prescreened_by, decided_at
    ) VALUES (
      ${lowerEmail},
      ${String(prospective_full_name).trim()},
      ${prospective_specialty ?? null},
      ${hosp[0].id}::uuid,
      ${years_post_postgraduate ?? null},
      ${priors.length > 0 ? priors : null},
      ${JSON.stringify(commitments)}::jsonb,
      ${red_flags ?? null},
      ${decision},
      ${decision_rationale ?? null},
      ${Boolean(cooldown_override)},
      ${stage},
      ${actor.profileId}::uuid,
      NOW()
    )
    RETURNING id::text AS id, prospective_email, prospective_full_name, decision, stage, created_at
  `) as Array<Record<string, unknown>>;

  await sql`
    INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
    VALUES (
      ${actor.profileId}::uuid,
      'prescreen',
      'vc_prescreen',
      ${inserted[0].id as string},
      ${JSON.stringify({
        prospective_email: lowerEmail,
        prospective_full_name,
        hospital_code,
        decision,
        stage,
        cooldown_override: Boolean(cooldown_override),
      })}::jsonb
    )
  `;
  return NextResponse.json({ ok: true, prescreen: inserted[0] }, { headers: NO_STORE });
}
