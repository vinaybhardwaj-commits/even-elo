import Link from "next/link";
import { neon } from "@neondatabase/serverless";
import { getCurrentUser } from "@/lib/auth";
import { getHospitalFilter, getHospitalFilterId } from "@/lib/hospital-filter";
import { TopNav } from "@/components/TopNav";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

type Counts = {
  active_physicians: number;
  open_incidents: number;
  vcs_in_pipeline: number;
  tier_moves_30d: number;
};

type AuditRow = {
  id: number;
  action: string;
  entity_type: string;
  entity_id: string | null;
  created_at: string;
  actor_email: string | null;
  actor_position: string | null;
};

async function fetchData(hospitalId: string | null): Promise<{
  counts: Counts;
  audit: AuditRow[];
} | null> {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const sql = neon(url);
  // KPIs respect the global filter. When hospitalId is null ("All Hospitals"),
  // counts span the network; otherwise scope to the selected hospital.
  const cRows = hospitalId
    ? (await sql`
        SELECT
          (SELECT count(DISTINCT pe.physician_id)::int
             FROM physician_engagements pe
             JOIN physicians p ON p.id = pe.physician_id
             WHERE pe.hospital_id = ${hospitalId}::uuid
               AND pe.status = 'active'
               AND p.current_status = 'active')                                                                       AS active_physicians,
          (SELECT count(*)::int FROM incidents WHERE status = 'open' AND hospital_id = ${hospitalId}::uuid)            AS open_incidents,
          (SELECT count(*)::int FROM vc_prescreens vp
             WHERE vp.stage IN ('prescreen','observation','decision')
               AND EXISTS (SELECT 1 FROM vc_prescreen_hospitals vph WHERE vph.prescreen_id = vp.id AND vph.hospital_id = ${hospitalId}::uuid)) AS vcs_in_pipeline,
          0::int                                                                                                       AS tier_moves_30d
      `) as Array<Counts>
    : (await sql`
        SELECT
          (SELECT count(*)::int FROM physicians WHERE current_status = 'active')                                       AS active_physicians,
          (SELECT count(*)::int FROM incidents WHERE status = 'open')                                                  AS open_incidents,
          (SELECT count(*)::int FROM vc_prescreens WHERE stage IN ('prescreen','observation','decision'))              AS vcs_in_pipeline,
          0::int                                                                                                       AS tier_moves_30d
      `) as Array<Counts>;
  const aRows = (await sql`
    SELECT
      a.id,
      a.action,
      a.entity_type,
      a.entity_id,
      a.created_at,
      p.email AS actor_email,
      pos.position_name AS actor_position
    FROM audit_log_v2 a
    LEFT JOIN profiles p ON p.id = a.actor_user_id
    LEFT JOIN positions pos ON pos.id = p.position_id
    ORDER BY a.created_at DESC
    LIMIT 20
  `) as Array<AuditRow>;
  return { counts: cRows[0], audit: aRows };
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function actionColor(a: string) {
  if (a === "delete" || a === "retract") return "text-red-700";
  if (a === "update") return "text-blue-700";
  return "text-emerald-700";
}

export default async function HomePage() {
  const user = await getCurrentUser();
  if (!user) {
    return null; // middleware redirects; this is defensive
  }
  const filterCode = await getHospitalFilter();
  const filterId   = await getHospitalFilterId();
  const data = await fetchData(filterId);

  const counts = data?.counts ?? {
    active_physicians: 0,
    open_incidents: 0,
    vcs_in_pipeline: 0,
    tier_moves_30d: 0,
  };
  const audit = data?.audit ?? [];

  const today = new Date().toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  // Honorific-aware first-name extraction. "Dr. Chandrika Kambam" → "Chandrika".
  const HONORIFICS = new Set(["dr.", "dr", "prof.", "prof", "mr.", "mr", "ms.", "ms", "mrs.", "mrs"]);
  function firstNameFrom(fn: string): string {
    const toks = fn.trim().split(/\s+/);
    let i = 0;
    while (i < toks.length - 1 && HONORIFICS.has(toks[i].toLowerCase())) i++;
    return toks[i] ?? fn;
  }
  const firstName = firstNameFrom(user.full_name);

  return (
    <>
      <TopNav />
      <main className="max-w-[1400px] mx-auto px-8 py-8">
        {/* Greeting */}
        <div className="flex items-end justify-between mb-6">
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight">
              Good morning, {firstName}
            </h1>
            <div className="text-sm text-stone-500 mt-1">
              {today}
              {user.is_super_admin ? " · Super Admin" : ""}
              {user.position_label && user.position_label !== "Hospital PM" ? ` · ${user.position_label}` : (!user.is_super_admin ? ` · ${user.position_label}` : "")}
              {" · viewing "}{filterCode === "all" ? "all hospitals" : filterCode}
            </div>
          </div>
        </div>

        {/* KPI strip */}
        <div className="grid grid-cols-4 gap-3 mb-6">
          <div className="bg-white border border-stone-200 rounded-xl p-4">
            <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">
              Active physicians
            </div>
            <div className="text-3xl font-semibold num mt-1.5">
              {counts.active_physicians}
            </div>
            <div className="text-[11px] text-stone-500 mt-0.5">in network</div>
          </div>
          <div className="bg-white border border-stone-200 rounded-xl p-4">
            <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">
              Open incidents
            </div>
            <div className="text-3xl font-semibold num mt-1.5">
              {counts.open_incidents}
            </div>
            <div className="text-[11px] text-stone-500 mt-0.5">
              <Link href="/incidents" className="text-brand hover:underline">
                Open inbox →
              </Link>
            </div>
          </div>
          <div className="bg-white border border-stone-200 rounded-xl p-4">
            <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">
              Credentialing in pipeline
            </div>
            <div className="text-3xl font-semibold num mt-1.5">
              {counts.vcs_in_pipeline}
            </div>
            <div className="text-[11px] text-stone-500 mt-0.5">
              <Link href="/onboarding" className="text-brand hover:underline">
                Open pipeline →
              </Link>
            </div>
          </div>
          <div className="bg-white border border-stone-200 rounded-xl p-4">
            <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">
              ELO tier moves (30d)
            </div>
            <div className="text-3xl font-semibold num mt-1.5">
              {counts.tier_moves_30d}
            </div>
            <div className="text-[11px] text-stone-500 mt-0.5">
              <Link href="/surgical-elo" className="text-brand hover:underline">
                Open Even ELO →
              </Link>
            </div>
          </div>
        </div>

        {/* 2-col layout */}
        <div className="grid grid-cols-3 gap-4">
          {/* LEFT — Inbox + Watchlist */}
          <div className="col-span-2 space-y-4">
            <section className="bg-white border border-stone-200 rounded-xl">
              <div className="flex items-center justify-between px-5 py-3.5 border-b border-stone-100">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold">Inbox</h2>
                  <span className="text-[11px] bg-stone-100 text-stone-600 rounded-full px-2 py-0.5 font-medium">0</span>
                </div>
                <Link href="/incidents" className="text-[12px] text-brand font-medium">Open inbox →</Link>
              </div>
              <div className="px-5 py-10 text-center text-sm text-stone-500">
                No open incidents.
              </div>
            </section>

            <section className="bg-white border border-stone-200 rounded-xl">
              <div className="flex items-center justify-between px-5 py-3.5 border-b border-stone-100">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold">Watchlist</h2>
                  <span className="text-[11px] bg-stone-100 text-stone-600 rounded-full px-2 py-0.5 font-medium">0</span>
                </div>
                <Link href="/surgical-elo" className="text-[12px] text-brand font-medium">
                  Open Even ELO →
                </Link>
              </div>
              <div className="px-5 py-10 text-center text-sm text-stone-500">
                No tier moves yet — surgeons will appear here when ELO data lands.
              </div>
            </section>
          </div>

          {/* RIGHT — VC pipeline + Audit feed */}
          <div className="space-y-4">
            <section className="bg-white border border-stone-200 rounded-xl">
              <div className="flex items-center justify-between px-5 py-3.5 border-b border-stone-100">
                <h2 className="text-sm font-semibold">VC pipeline</h2>
                <Link href="/onboarding" className="text-[12px] text-brand font-medium">Open pipeline →</Link>
              </div>
              <div className="px-5 py-8 text-center text-sm text-stone-500">
                No active Credentialing in pipeline.
              </div>
            </section>

            <section className="bg-white border border-stone-200 rounded-xl">
              <div className="flex items-center justify-between px-5 py-3.5 border-b border-stone-100">
                <h2 className="text-sm font-semibold">Audit feed</h2>
                <span className="text-[11px] bg-stone-100 text-stone-600 rounded-full px-2 py-0.5 font-medium">{audit.length}</span>
              </div>
              {audit.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-stone-500">
                  No audit entries yet.
                </div>
              ) : (
                <div className="px-4 py-2 mono text-[11px] text-stone-700">
                  {audit.map((r) => (
                    <div key={r.id} className="py-1.5 border-b border-dashed border-stone-100 last:border-b-0 leading-relaxed">
                      <div className="text-stone-400 text-[10px]">{timeAgo(r.created_at)}</div>
                      <div>{r.actor_email ?? "—"}{r.actor_position ? ` · ${r.actor_position}` : ""}</div>
                      <div className={actionColor(r.action)}>
                        {r.action} {r.entity_type}{r.entity_id ? ` (${r.entity_id})` : ""}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      </main>
    </>
  );
}
