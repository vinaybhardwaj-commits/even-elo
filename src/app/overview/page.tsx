import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { getCurrentUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import {
  getSeries,
  latestSnapshot,
  computeAges,
  computeResolved,
  computeMovers,
  qualitySeries,
  type SnapshotRow,
} from "@/lib/gov-signals";

export const dynamic = "force-dynamic";

/**
 * Overview — the continuous governance signal board (PRD v1.4-LOCKED §4.2, R2).
 * NOT a daily digest: rolling-window trends, signal persistence/aging, movers,
 * and the unified open-work queue. /home redirects here while UI_V2 is on.
 */

interface PendingQual {
  id: string;
  degree: string | null;
  year_completed: number | null;
  physician_id: string;
  full_name: string;
  created_at: string;
}
interface Expiry {
  id: string;
  full_name: string;
  kind: string;
  expires_on: string;
  days_left: number;
}
interface NegIncident {
  id: string;
  full_name: string;
  category: string | null;
  severity: string | null;
  submitted_at: string;
}

function Spark({ points, stroke }: { points: Array<{ value: number }>; stroke: string }) {
  if (points.length < 2) return <span className="text-[10px] text-stone-300">no trend yet</span>;
  const w = 62;
  const h = 20;
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const step = w / (points.length - 1);
  const pts = points
    .map((p, i) => `${Math.round(i * step)},${Math.round(h - 2 - ((p.value - min) / span) * (h - 4))}`)
    .join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth="2" />
    </svg>
  );
}

function ageBadge(days: number, regressed: boolean) {
  const label =
    days < 1 ? "new" : days < 14 ? `active ${days}d` : `active ${Math.round(days / 7)} wks`;
  return (
    <span
      className={
        "shrink-0 rounded-full border px-2 py-0.5 text-[10.5px] font-bold " +
        (regressed
          ? "border-rose-200 bg-rose-50 text-rose-700"
          : "border-violet-200 bg-violet-50 text-violet-700")
      }
    >
      {regressed ? `back · ${label}` : label}
    </span>
  );
}

async function incidentStats(): Promise<{ open: number | null; total: number | null }> {
  const base = process.env.INCIDENT_API_BASE;
  const tok = process.env.INCIDENT_API_TOKEN;
  if (!base || !tok) return { open: null, total: null };
  try {
    const res = await fetch(`${base}/api/office/stats`, {
      headers: { Authorization: `Bearer ${tok}` },
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return { open: null, total: null };
    const j = (await res.json()) as Record<string, unknown>;
    const pick = (...keys: string[]): number | null => {
      for (const k of keys) {
        const v = (j as Record<string, unknown>)[k] ?? (j.stats as Record<string, unknown> | undefined)?.[k];
        if (typeof v === "number") return v;
      }
      return null;
    };
    return { open: pick("open", "open_count", "openIncidents"), total: pick("total", "count", "incidents_total") };
  } catch {
    return { open: null, total: null };
  }
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: { window?: string };
}) {
  const user = await getCurrentUser();
  if (!user || user.status !== "active") redirect("/auth/login");

  const windowDays = [7, 30, 90].includes(Number(searchParams.window))
    ? Number(searchParams.window)
    : 30;

  let series: SnapshotRow[] = [];
  try {
    series = await getSeries(90);
  } catch {
    series = [];
  }
  const latest = latestSnapshot(series);
  const signals = latest?.payload.report?.signals ?? [];
  const healthy = latest?.payload.report?.healthy ?? [];
  const ages = computeAges(series);
  const resolved = computeResolved(series);
  const movers = computeMovers(series, windowDays);
  const qseries = qualitySeries(series).slice(-Math.min(windowDays, series.length));

  const counts = (
    (await sql`
      SELECT
        (SELECT count(*)::int FROM incidents WHERE status='open' AND polarity='negative') AS open_negative,
        (SELECT count(*)::int FROM incidents WHERE polarity='negative' AND submitted_at > now() - make_interval(days => ${windowDays})) AS neg_window,
        (SELECT count(*)::int FROM incidents WHERE polarity='negative' AND submitted_at <= now() - make_interval(days => ${windowDays}) AND submitted_at > now() - make_interval(days => ${windowDays * 2})) AS neg_prior,
        (SELECT count(*)::int FROM qualifications WHERE verified=false) AS pending_quals`) as unknown as Array<{
      open_negative: number;
      neg_window: number;
      neg_prior: number;
      pending_quals: number;
    }>
  )[0];

  const pendingQuals = (await sql`
    SELECT q.id, q.degree, q.year_completed, q.created_at, p.id AS physician_id, p.full_name
    FROM qualifications q JOIN physicians p ON p.id = q.physician_id
    WHERE q.verified = false ORDER BY q.created_at ASC LIMIT 5`) as unknown as PendingQual[];

  const expiries = (await sql`
    SELECT * FROM (
      SELECT id, full_name, 'Registration' AS kind, registration_expiry AS expires_on,
             (registration_expiry - current_date)::int AS days_left
      FROM physicians WHERE current_status='active' AND registration_expiry IS NOT NULL
        AND registration_expiry BETWEEN current_date AND current_date + 30
      UNION ALL
      SELECT id, full_name, 'Indemnity' AS kind, indemnity_expiry AS expires_on,
             (indemnity_expiry - current_date)::int AS days_left
      FROM physicians WHERE current_status='active' AND indemnity_expiry IS NOT NULL
        AND indemnity_expiry BETWEEN current_date AND current_date + 30
    ) e ORDER BY days_left ASC LIMIT 6`) as unknown as Expiry[];

  const negIncidents = (await sql`
    SELECT i.id, p.full_name, i.category, i.severity, i.submitted_at
    FROM incidents i JOIN physicians p ON p.id = i.target_physician_id
    WHERE i.status='open' AND i.polarity='negative'
    ORDER BY i.submitted_at DESC LIMIT 3`) as unknown as NegIncident[];

  const inc = await incidentStats();

  const canVerify = user.is_super_admin || user.is_hr || user.is_site_medical_head;
  const actNow = signals.filter((s) => s.severity === "act_now").length;
  const feedbackTrend =
    counts.neg_prior === 0 ? "stable" : counts.neg_window > counts.neg_prior * 1.3 ? "rising" : counts.neg_window < counts.neg_prior * 0.7 ? "falling" : "stable";
  const docsStroke = actNow > 0 ? "#e11d48" : signals.length > 0 ? "#d97706" : "#059669";

  return (
    <AppShell>
      <main className="mx-auto max-w-[1400px] px-4 py-8 sm:px-8">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Governance overview</h1>
            <p className="mt-1 text-sm text-stone-500">
              Ongoing signals across all domains
              {latest ? ` · OPD audit data through ${latest.day}` : " · awaiting first OPD snapshot"}
              {latest?.payload.engine ? ` · ${latest.payload.engine}` : ""}
            </p>
          </div>
          <div className="flex overflow-hidden rounded-lg border border-stone-200 bg-white text-[12.5px] font-semibold">
            {[7, 30, 90].map((w) => (
              <Link
                key={w}
                href={`/overview?window=${w}`}
                className={
                  "px-3.5 py-1.5 " +
                  (w === windowDays ? "bg-brand-softer text-brand" : "text-stone-500 hover:bg-stone-50")
                }
              >
                {w}d
              </Link>
            ))}
          </div>
        </div>

        {/* Category tiles */}
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <div className="rounded-xl border border-stone-200 bg-white px-4 py-3">
            <div className="text-[12.5px] font-semibold">Documentation quality</div>
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <span
                className={
                  "rounded-full px-2 py-0.5 text-[10.5px] font-bold " +
                  (actNow > 0 ? "bg-rose-50 text-rose-700" : signals.length ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700")
                }
              >
                {actNow > 0 ? `${actNow} act now` : signals.length ? `${signals.length} watch` : "OK"}
              </span>
              <Spark points={qseries} stroke={docsStroke} />
            </div>
            <div className="mt-1.5 text-[11.5px] text-stone-500">
              {signals.length} active signal{signals.length === 1 ? "" : "s"}
              {resolved.length ? ` · ${resolved.length} resolved` : ""}
            </div>
          </div>
          <Link href="/incidents" className="rounded-xl border border-stone-200 bg-white px-4 py-3 hover:border-brand">
            <div className="text-[12.5px] font-semibold">Patient feedback</div>
            <div className="mt-1.5">
              <span className={"rounded-full px-2 py-0.5 text-[10.5px] font-bold " + (counts.open_negative > 0 ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700")}>
                {counts.open_negative} open negative
              </span>
            </div>
            <div className="mt-1.5 text-[11.5px] text-stone-500">
              {counts.neg_window} in {windowDays}d vs {counts.neg_prior} prior · {feedbackTrend}
            </div>
          </Link>
          <Link href="/safety" className="rounded-xl border border-stone-200 bg-white px-4 py-3 hover:border-brand">
            <div className="text-[12.5px] font-semibold">Incidents</div>
            <div className="mt-1.5">
              <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[10.5px] font-bold text-sky-700">
                {inc.open !== null ? `${inc.open} open` : "open module"}
              </span>
            </div>
            <div className="mt-1.5 text-[11.5px] text-stone-500">
              {inc.total !== null ? `${inc.total} total · all departments` : "reporting · RCA · CAPA"}
            </div>
          </Link>
          <Link href="/onboarding" className="rounded-xl border border-stone-200 bg-white px-4 py-3 hover:border-brand">
            <div className="text-[12.5px] font-semibold">Credentialing hygiene</div>
            <div className="mt-1.5">
              <span className={"rounded-full px-2 py-0.5 text-[10.5px] font-bold " + (counts.pending_quals + expiries.length > 0 ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700")}>
                {counts.pending_quals + expiries.length > 0 ? `${counts.pending_quals + expiries.length} open items` : "OK"}
              </span>
            </div>
            <div className="mt-1.5 text-[11.5px] text-stone-500">
              {counts.pending_quals} pending · {expiries.length} expiries ≤30d
            </div>
          </Link>
          <Link href="/surgical-governance" className="rounded-xl border border-stone-200 bg-white px-4 py-3 hover:border-brand">
            <div className="text-[12.5px] font-semibold">Surgical governance</div>
            <div className="mt-1.5">
              <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10.5px] font-bold text-stone-500">module</span>
            </div>
            <div className="mt-1.5 text-[11.5px] text-stone-500">streams · cases · scores</div>
          </Link>
        </div>

        <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
          {/* Active signals */}
          <section className="rounded-xl border border-stone-200 bg-white p-5">
            <h2 className="mb-1 text-[11px] font-bold uppercase tracking-[0.08em] text-stone-400">
              Active signals — ranked by severity × persistence
            </h2>
            {signals.length > 0 && latest?.payload.advisory && (
              <p className="mb-3 rounded-lg border border-sky-100 bg-sky-50 px-3 py-2 text-[11.5px] leading-snug text-sky-900">
                {latest.payload.advisory}
              </p>
            )}
            {latest ? (
              <div className="divide-y divide-stone-100">
                {signals.map((s) => (
                  <div key={s.attr} className="flex items-start gap-3 py-3">
                    <span className={"mt-1.5 h-2 w-2 shrink-0 rounded-full " + (s.severity === "act_now" ? "bg-rose-600" : "bg-amber-500")} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-[13.5px] font-semibold">
                        Documentation · {s.label} <span className="num">{s.mean.toFixed(1)}</span>
                        <span className={"text-[12px] font-bold " + (s.trend === "worsening" ? "text-rose-600" : s.trend === "improving" ? "text-emerald-600" : "text-stone-400")}>
                          {s.trend === "worsening" ? `▼${Math.abs(s.delta ?? 0).toFixed(1)}` : s.trend === "improving" ? `▲${Math.abs(s.delta ?? 0).toFixed(1)}` : "—"}
                        </span>
                        <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-700">{s.scope}</span>
                      </div>
                      {s.action && <div className="mt-0.5 truncate text-[12.5px] text-stone-500">{s.action}</div>}
                      {typeof s.affected_share === "number" && s.eligible_doctors ? (
                        <div className="mt-0.5 text-[11.5px] text-stone-400">
                          {Math.round(s.affected_share * 100)}% of {s.eligible_doctors} eligible doctors
                        </div>
                      ) : null}
                    </div>
                    {ages[s.attr] && ageBadge(ages[s.attr].ageDays, ages[s.attr].regressed)}
                  </div>
                ))}
                {expiries.slice(0, 2).map((e) => (
                  <div key={`${e.id}-${e.kind}`} className="flex items-start gap-3 py-3">
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-amber-500" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] font-semibold">
                        Credentialing · {e.kind} expiring — <Link href={`/physicians/${e.id}`} className="text-brand hover:underline">{e.full_name}</Link>
                      </div>
                      <div className="mt-0.5 text-[12.5px] text-stone-500">{e.days_left} days remaining</div>
                    </div>
                  </div>
                ))}
                {signals.length === 0 && expiries.length === 0 && (
                  <p className="py-6 text-center text-sm text-stone-400">No active signals — a good stretch. ✓</p>
                )}
              </div>
            ) : (
              <p className="py-6 text-center text-sm text-stone-400">
                No OPD snapshots yet — the 06:00 IST cron (or a backfill run) populates this board.
              </p>
            )}
            {(movers.improving.length > 0 || movers.worsening.length > 0) && (
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 rounded-lg border border-stone-100 bg-stone-50 px-3 py-2 text-[12px]">
                {movers.improving.length > 0 && (
                  <span className="text-emerald-700">
                    ▲ Improving: {movers.improving.map((m) => `${m.label} +${m.delta.toFixed(1)}`).join(" · ")}
                  </span>
                )}
                {movers.worsening.length > 0 && (
                  <span className="text-rose-700">
                    ▼ Worsening: {movers.worsening.map((m) => `${m.label} ${m.delta.toFixed(1)}`).join(" · ")}
                  </span>
                )}
              </div>
            )}
          </section>

          {/* Open work */}
          <section className="rounded-xl border border-stone-200 bg-white p-5">
            <h2 className="mb-3 text-[11px] font-bold uppercase tracking-[0.08em] text-stone-400">
              My open work — {user.position_label || "Governance"}
            </h2>
            <div className="divide-y divide-stone-100">
              {canVerify &&
                pendingQuals.map((q) => (
                  <Link key={q.id} href={`/physicians/${q.physician_id}`} className="flex items-center gap-3 py-2.5 hover:bg-brand-softer">
                    <span className="h-2 w-2 shrink-0 rounded-full bg-sky-500" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold">
                        Verify {q.degree || "qualification"} — {q.full_name}
                      </div>
                      <div className="text-[11.5px] text-stone-400">uploaded via portal</div>
                    </div>
                  </Link>
                ))}
              {expiries.map((e) => (
                <Link key={`w-${e.id}-${e.kind}`} href={`/physicians/${e.id}`} className="flex items-center gap-3 py-2.5 hover:bg-brand-softer">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold">
                      {e.kind} nudge — {e.full_name}
                    </div>
                    <div className="text-[11.5px] text-stone-400">{e.days_left}d left</div>
                  </div>
                </Link>
              ))}
              {negIncidents.map((i) => (
                <Link key={i.id} href={`/incidents/${i.id}`} className="flex items-center gap-3 py-2.5 hover:bg-brand-softer">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-rose-500" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold">Open feedback — {i.full_name}</div>
                    <div className="text-[11.5px] text-stone-400">
                      {i.category || "uncategorised"} · {i.severity || "unrated"}
                    </div>
                  </div>
                </Link>
              ))}
              {!canVerify && pendingQuals.length === 0 && expiries.length === 0 && negIncidents.length === 0 && (
                <p className="py-6 text-center text-sm text-stone-400">Nothing waiting on you. ✓</p>
              )}
            </div>
          </section>
        </div>

        {/* Healthy strip */}
        <div className="mt-4 rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-2.5 text-[12.5px] text-emerald-900">
          ✓ Currently healthy —{" "}
          {healthy.length > 0
            ? healthy.map((h) => `${h.label} ${h.mean.toFixed(1)}`).join(" · ")
            : "no healthy-attribute data yet"}
          {expiries.length === 0 ? " · no credential expiries in 30d" : ""}
          {resolved.length > 0 ? ` · resolved recently: ${resolved.map((r) => r.label).join(", ")}` : ""}
        </div>

        {/* Watchlist strip (sidebar anchor) */}
        <section id="watchlist" className="mt-4 flex scroll-mt-20 items-center justify-between rounded-xl border border-stone-200 bg-white px-5 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="text-sm font-semibold">Watchlist</h2>
            <span className="truncate text-[12px] text-stone-400">
              Physicians under active governance attention — tier moves land here from Surgical Governance.
            </span>
          </div>
          <Link href="/physicians" className="ml-3 shrink-0 text-[12px] font-medium text-brand">
            Open roster →
          </Link>
        </section>
      </main>
    </AppShell>
  );
}
