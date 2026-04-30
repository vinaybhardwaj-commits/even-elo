import Link from "next/link";
import { notFound } from "next/navigation";
import { unstable_noStore as noStore } from "next/cache";
import { sql } from "@/lib/db";
import { TopNav } from "@/components/TopNav";
import { TierChip, Tier, TIER_TEXT_COLOR } from "@/components/TierChip";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface VcDetail {
  id: string;
  full_name: string;
  specialty: string;
  registration_no: string | null;
  status: string;
  composite: number | null;
  caseload_score: number | null;
  outcomes_score: number | null;
  adherence_score: number | null;
  tier: Tier | null;
  low_confidence: boolean;
  computed_at: string | null;
  total_observations: number;
  case_count_window: number;
}

async function getVcDetail(id: string): Promise<VcDetail | null> {
  noStore();
  const rows = (await sql`
    WITH latest AS (
      SELECT DISTINCT ON (vc_id)
        vc_id, composite, caseload_score, outcomes_score, adherence_score,
        tier, low_confidence, computed_at
      FROM score_snapshots
      WHERE vc_id = ${id}
      ORDER BY vc_id, computed_at DESC
    ),
    obs_count AS (
      SELECT COUNT(*)::int AS n
      FROM case_observations co
      JOIN surgical_cases sc ON sc.id = co.case_id
      WHERE sc.vc_id = ${id}
        AND co.is_current = true
        AND sc.surgery_date >= (CURRENT_DATE - INTERVAL '180 days')
    ),
    case_count AS (
      SELECT COUNT(*)::int AS n
      FROM surgical_cases
      WHERE vc_id = ${id}
        AND case_status = 'completed'
        AND surgery_date >= (CURRENT_DATE - INTERVAL '180 days')
    )
    SELECT
      v.id, v.full_name, v.specialty, v.registration_no, v.status,
      ls.composite::float AS composite,
      ls.caseload_score::float AS caseload_score,
      ls.outcomes_score::float AS outcomes_score,
      ls.adherence_score::float AS adherence_score,
      ls.tier, ls.low_confidence, ls.computed_at,
      (SELECT n FROM obs_count) AS total_observations,
      (SELECT n FROM case_count) AS case_count_window
    FROM vcs v
    LEFT JOIN latest ls ON ls.vc_id = v.id
    WHERE v.id = ${id}
  `) as Array<VcDetail>;
  return rows[0] ?? null;
}

interface PageProps {
  params: { id: string };
}

export default async function VcDashboardPage({ params }: PageProps) {
  if (!UUID_RE.test(params.id)) notFound();
  const vc = await getVcDetail(params.id);
  if (!vc) notFound();

  return (
    <>
      <TopNav />
      <main className="max-w-[1400px] mx-auto px-8 py-8">
        <div className="flex items-center gap-2 text-sm text-stone-500 mb-4">
          <Link href="/" className="hover:text-stone-900">
            Leaderboard
          </Link>
          <span>/</span>
          <span className="text-stone-900">{vc.full_name}</span>
        </div>

        <div className="card p-6 mb-6 bg-white border border-stone-200 rounded-xl">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-2 flex-wrap">
                <h1 className="text-2xl font-semibold tracking-tight">{vc.full_name}</h1>
                {vc.tier && <TierChip tier={vc.tier} />}
                <span className="pill text-xs px-2.5 py-1 rounded-full bg-stone-100 text-stone-600 font-medium capitalize">
                  {vc.status}
                </span>
                {vc.low_confidence && (
                  <span className="pill text-xs px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 font-medium">
                    ⚠ Low confidence
                  </span>
                )}
              </div>
              <div className="text-sm text-stone-500 num">
                {vc.specialty}
                {vc.registration_no && ` · ${vc.registration_no}`}
                {" · "}
                {vc.case_count_window} cases in last 6mo · {vc.total_observations} observations
              </div>
            </div>
            <div className="text-right">
              <div
                className={`score-display text-6xl ${
                  vc.tier ? TIER_TEXT_COLOR[vc.tier] : "text-stone-400"
                }`}
              >
                {vc.composite !== null ? vc.composite.toFixed(1) : "—"}
              </div>
              {vc.computed_at && (
                <div className="text-xs text-stone-500 mt-1 num">
                  computed {new Date(vc.computed_at).toLocaleString()}
                </div>
              )}
            </div>
          </div>

          <div className="mt-6 pt-6 border-t border-stone-100 grid grid-cols-3 gap-6">
            <ComponentCard label="Caseload" value={vc.caseload_score} tier={vc.tier} />
            <ComponentCard label="Outcomes" value={vc.outcomes_score} tier={vc.tier} />
            <ComponentCard label="Adherence" value={vc.adherence_score} tier={vc.tier} />
          </div>
        </div>

        <div className="rounded-xl border border-stone-200 bg-stone-50 p-6 text-center">
          <div className="text-sm font-medium text-stone-700 mb-1">
            Per-VC dashboard ships in ELO.6b
          </div>
          <div className="text-xs text-stone-500">
            Component breakdown, sparklines, recent activity feed, cases list, and audit export
            land in the next sub-sprint. The hero card above is from the leaderboard&apos;s latest
            snapshot.
          </div>
        </div>
      </main>
    </>
  );
}

function ComponentCard({
  label,
  value,
  tier,
}: {
  label: string;
  value: number | null;
  tier: Tier | null;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-xs font-medium tracking-wider uppercase text-stone-500">{label}</div>
        <div className="num text-lg font-semibold">{value !== null ? value.toFixed(0) : "—"}</div>
      </div>
      <div className="bg-stone-100 h-1.5 rounded overflow-hidden">
        {value !== null && tier && (
          <div
            className={`h-full ${
              {
                distinguished: "bg-tier-dist-bar",
                standard: "bg-tier-std-bar",
                watch: "bg-tier-watch-bar",
                pip: "bg-tier-pip-bar",
                suspension_review: "bg-tier-susp-bar",
                no_recent_activity: "bg-tier-none-bar",
              }[tier]
            }`}
            style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
          />
        )}
      </div>
    </div>
  );
}
