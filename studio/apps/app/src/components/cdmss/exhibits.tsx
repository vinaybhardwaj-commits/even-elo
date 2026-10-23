"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { toCsv } from "@/lib/cdmss/csv";
import type { Contributors, Doctors, Envelope, Metric, Scorecard, Worklists } from "@/lib/cdmss/contract";
import { pct } from "@/lib/cdmss/stats";
import { describeCdmssError } from "@/lib/cdmss/use-cdmss-view";

// Exhibit kit for the CDMSS module. Charts are plain SVG; every fact renders as a text node (never HTML). Fixed site
// colours so a site keeps its colour on every view.

export const SITE_COLOURS: Record<string, string> = { EHRC: "#2a6fdb", EHBR: "#d9822b", EHVJ: "#2f9e6f", EHCV: "#8a5cc2" };
const siteColour = (s: string) => SITE_COLOURS[s] ?? "#666";
export const BAND_COLOURS: Record<string, string> = { A: "#2f9e6f", B: "#8cc152", C: "#f2c230", D: "#e8833a", E: "#d64545" };

export const fmt = (m: Pick<Metric, "unit" | "value">): string => {
  if (m.value === null || m.value === undefined) return "–";
  if (m.unit === "proportion") return pct(m.value, 1);
  if (m.unit === "score") return m.value.toFixed(0);
  return m.value.toFixed(2);
};

/** Rule 3: numerator / denominator / n / definition id beside the number. */
export function Figure({ m, withCi = true }: { m: Metric; withCi?: boolean }) {
  if (m.status === "unavailable") return <span className="cd-grey" title={m.reason ?? ""}>unavailable{m.reason ? `: ${m.reason}` : ""}</span>;
  const grey = m.status === "grey";
  return (
    <span className={grey ? "cd-grey" : undefined} data-grey={grey || undefined}>
      {grey ? `n = ${m.n}` : <strong>{fmt(m)}</strong>}
      {!grey && withCi && m.ci && <span className="cd-ci"> ({pct(m.ci.lo)}–{pct(m.ci.hi)})</span>}
      {!grey && m.coverage !== undefined && m.coverage !== null && <span className="cd-cov">, {pct(m.coverage)} of notes</span>}
      <span className="cd-def">
        {" "}
        {m.numerator ?? "–"}/{m.denominator ?? "–"} · n {m.n} · {m.id}
      </span>
      {grey && m.reason && <span className="cd-def"> · {m.reason}</span>}
    </span>
  );
}

/** Rules 1, 2, 9, 10: provenance, headline, caveats, action. */
export function EnvelopeBlock({ env }: { env: Envelope }) {
  const p = env.provenance;
  return (
    <>
      <section className="scr-card cd-headline" aria-label="Headline">
        <h2>{env.headline.claim}</h2>
        <p>{env.headline.plain}</p>
        <p className="cd-action"><strong>Look first:</strong> {env.action}</p>
      </section>
      <p className="scr-source" data-testid="provenance">
        Window {p.window.label} ({p.window.from} to {p.window.to}) · data cut-off {p.data_cutoff ?? "unknown"} · sources {p.sources.join(", ")} · engine {p.engine_family}
        {p.db13_as_of ? ` · DB13 as of ${p.db13_as_of}` : ""}
      </p>
      <ul className="cd-caveats" aria-label="Caveats">
        {env.caveats.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </>
  );
}

/** Loading / error / ok wrapper for one view. */
export function ViewState<T>({ state, retry, children }: { state: { status: "loading" } | { status: "error"; code: string } | { status: "ok"; data: T }; retry: () => void; children: (data: T) => ReactNode }) {
  if (state.status === "loading") return <p className="scr-muted" role="status">Loading…</p>;
  if (state.status === "error")
    return (
      <p className="scr-error" role="alert">
        {describeCdmssError(state.code)} <button type="button" onClick={retry}>Retry</button>
      </p>
    );
  return <>{children(state.data)}</>;
}

export function ViewTabs({ current }: { current: string }) {
  const tabs: Array<[string, string, string]> = [
    ["this_week", "/cdmss", "This week"],
    ["scorecard", "/cdmss/scorecard", "Scorecard"],
    ["doctors", "/cdmss/doctors", "Doctor variation"],
    ["contributors", "/cdmss/contributors", "Contributors"],
    ["red_flags", "/cdmss/red-flags", "Red flags"],
    ["worklists", "/cdmss/worklists", "Worklists"],
  ];
  return (
    <nav className="cd-tabs" aria-label="CDMSS views">
      {tabs.map(([id, href, label]) => (
        <Link key={id} href={href} aria-current={id === current ? "page" : undefined}>{label}</Link>
      ))}
    </nav>
  );
}

/** Site x metric matrix. */
export function ScorecardMatrix({ data }: { data: Scorecard }) {
  const sites = Array.from(new Set(data.cells.map((c) => c.site)));
  return (
    <table className="scr-table" aria-label="Site scorecard">
      <thead>
        <tr>
          <th>Metric</th>
          {sites.map((s) => (
            <th key={s} style={{ color: siteColour(s) }}>{s}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.metrics.map((mt) => (
          <tr key={mt.id}>
            <th scope="row">{mt.label} <span className="cd-def">({mt.higher_is} is {mt.higher_is === "better" ? "higher" : "lower"})</span></th>
            {sites.map((s) => {
              const c = data.cells.find((x) => x.site === s && x.metric_id === mt.id);
              return <td key={s}>{c ? <Figure m={c} /> : "–"}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Trend lines, one per site, fixed colours. */
export function TrendLines({ data, metricId }: { data: Scorecard; metricId: string }) {
  const series = data.trend.filter((t) => t.metric_id === metricId);
  const weeks = Array.from(new Set(series.flatMap((s) => s.points.map((p) => p.week))));
  const vals = series.flatMap((s) => s.points.map((p) => p.value).filter((v): v is number => v !== null));
  if (!weeks.length || !vals.length) return <p className="scr-muted">No trend data.</p>;
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const W = 480, H = 160, P = 24;
  const x = (i: number) => P + (weeks.length === 1 ? 0 : (i * (W - 2 * P)) / (weeks.length - 1));
  const y = (v: number) => H - P - ((v - lo) / span) * (H - 2 * P);
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Weekly trend of ${metricId} by site`} className="cd-chart">
        {weeks.map((w, i) => (
          <text key={w} x={x(i)} y={H - 6} fontSize="10" textAnchor="middle">{w}</text>
        ))}
        {series.map((s) => (
          <polyline key={s.site} fill="none" stroke={siteColour(s.site)} strokeWidth="2" data-site={s.site}
            points={s.points.map((p, i) => (p.value === null ? null : `${x(weeks.indexOf(p.week))},${y(p.value)}`)).filter(Boolean).join(" ")} />
        ))}
      </svg>
      <figcaption>{series.map((s) => <span key={s.site} style={{ color: siteColour(s.site) }}>■ {s.site} </span>)}</figcaption>
    </figure>
  );
}

/** Stacked A-E band mix per site (raw band, RULING Band). */
export function StackedMixBar({ data }: { data: Scorecard }) {
  return (
    <div aria-label="Band mix by site (raw band)">
      {data.band_mix.map((b) => (
        <div key={b.site} className="cd-mixrow">
          <span className="cd-mixlabel" style={{ color: siteColour(b.site) }}>{b.site} <span className="cd-def">n {b.n}</span></span>
          <svg viewBox="0 0 100 8" preserveAspectRatio="none" className="cd-mix" role="img" aria-label={`${b.site} band mix: ${Object.entries(b.shares).map(([k, v]) => `${k} ${pct(v)}`).join(", ")}`}>
            {(() => {
              let acc = 0;
              return Object.entries(b.shares).map(([band, share]) => {
                const r = <rect key={band} x={acc * 100} width={share * 100} height="8" fill={BAND_COLOURS[band] ?? "#999"}><title>{band} {pct(share)}</title></rect>;
                acc += share;
                return r;
              });
            })()}
          </svg>
        </div>
      ))}
    </div>
  );
}

/** Funnel plot: rate against n with 95% and 99.8% limits. Rows below min-n are not plotted (listed greyed elsewhere). */
export function FunnelPlot({ data }: { data: Doctors }) {
  const pts = data.rows.filter((r) => r.flag !== "not_ranked" && r.metric.value !== null);
  if (data.reference === null || !pts.length) return <p className="scr-muted">Not enough doctors with volume to draw a funnel.</p>;
  const maxN = Math.max(...pts.map((r) => r.metric.n), 20) * 1.1;
  const ref = data.reference;
  const W = 480, H = 240, P = 32;
  const x = (n: number) => P + (n / maxN) * (W - 2 * P);
  const maxY = Math.min(1, Math.max(ref * 2.5, ...pts.map((r) => r.metric.value ?? 0)) * 1.1);
  const y = (v: number) => H - P - (v / maxY) * (H - 2 * P);
  const limit = (z: number, side: 1 | -1) => {
    const out: string[] = [];
    for (let n = Math.max(10, maxN / 40); n <= maxN; n += maxN / 40) out.push(`${x(n)},${y(Math.min(maxY, Math.max(0, ref + side * z * Math.sqrt((ref * (1 - ref)) / n))))}`);
    return out.join(" ");
  };
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Funnel plot of doctor rates against volume" className="cd-chart">
        <line x1={P} x2={W - P} y1={y(ref)} y2={y(ref)} stroke="#888" strokeDasharray="4 3" />
        {[1.959964, 3.090232].map((z, i) => [1, -1].map((s) => <polyline key={`${z}${s}`} fill="none" stroke={i ? "#b33" : "#888"} strokeWidth={i ? 1.5 : 1} points={limit(z, s as 1 | -1)} />))}
        {pts.map((r) => (
          <circle key={r.doctor_uid} cx={x(r.metric.n)} cy={y(r.metric.value as number)} r="4" fill={siteColour(r.site)} data-flag={r.flag}>
            <title>{r.name}: {fmt(r.metric)} over {r.metric.n} notes</title>
          </circle>
        ))}
        <text x={P} y={H - 6} fontSize="10">notes audited (n) →</text>
      </svg>
      <figcaption>Dashed: reference {pct(ref, 1)}. Grey lines 95%, red lines 99.8% limits. {data.overdispersion_caveat ?? ""}</figcaption>
    </figure>
  );
}

const FLAG_TEXT: Record<string, string> = {
  above_998: "above 99.8% limit",
  above_95: "above 95% limit",
  within: "within limits",
  below_95: "below 95% limit",
  below_998: "below 99.8% limit",
  not_ranked: "not ranked (too few notes)",
};

/** Ranked dot-and-whisker. A doctor name appears only beside volume and interval. Below-min-n rows: count only, greyed, no rank. */
export function DotWhisker({ data }: { data: Doctors }) {
  const ranked = data.rows.filter((r) => r.flag !== "not_ranked" && r.metric.value !== null).sort((a, b) => (b.metric.value as number) - (a.metric.value as number));
  const unranked = data.rows.filter((r) => r.flag === "not_ranked" || r.metric.value === null);
  const W = 260;
  return (
    <>
      <table className="scr-table" aria-label="Doctors ranked by rate">
        <thead>
          <tr><th>#</th><th>Doctor</th><th>Site</th><th>Notes (n)</th><th>Rate and interval</th><th aria-hidden="true"></th><th>Against funnel</th><th>Cases</th></tr>
        </thead>
        <tbody>
          {ranked.map((r, i) => (
            <tr key={r.doctor_uid}>
              <td>{i + 1}</td>
              <td>{r.name}</td>
              <td style={{ color: siteColour(r.site) }}>{r.site}</td>
              <td>{r.metric.n}</td>
              <td><Figure m={r.metric} /></td>
              <td>
                {r.metric.ci && (
                  <svg viewBox={`0 0 ${W} 12`} width={W} height="12" role="img" aria-label={`${r.name} interval ${pct(r.metric.ci.lo)} to ${pct(r.metric.ci.hi)}`}>
                    <line x1={r.metric.ci.lo * W} x2={r.metric.ci.hi * W} y1="6" y2="6" stroke={siteColour(r.site)} />
                    <circle cx={(r.metric.value as number) * W} cy="6" r="3.5" fill={siteColour(r.site)} />
                  </svg>
                )}
              </td>
              <td>{FLAG_TEXT[r.flag]}</td>
              <td>{r.cases_url ? <a href={r.cases_url} target="_blank" rel="noreferrer noopener">cases</a> : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {unranked.length > 0 && (
        <p className="cd-grey" data-testid="unranked">
          Not ranked (fewer than 10 notes): {unranked.map((r) => `${r.name} (n ${r.metric.n})`).join("; ")}
        </p>
      )}
    </>
  );
}

export function ContributorTable({ data }: { data: Contributors }) {
  return (
    <>
      <p>
        {data.site}: <Figure m={data.site_metric} /> · gap to reference {data.gap_to_reference === null ? "–" : pct(data.gap_to_reference, 1)} · site without its top contributor {data.site_without_top === null ? "–" : pct(data.site_without_top, 1)}
      </p>
      <table className="scr-table" aria-label="Contributors to the site gap">
        <thead><tr><th>Doctor</th><th>Rate</th><th>Share of gap</th><th>Cases</th></tr></thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.doctor_uid}>
              <td>{r.name}</td>
              <td><Figure m={r.metric} /></td>
              <td>{r.metric.status === "grey" || r.share_of_gap === null ? <span className="cd-grey">–</span> : pct(r.share_of_gap)}</td>
              <td>{r.cases_url ? <a href={r.cases_url} target="_blank" rel="noreferrer noopener">cases</a> : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export const WORKLIST_COLUMNS = ["doctor", "uhid", "site", "note_date", "finding", "quote", "case_url"] as const;

/** Named worklist with client-side CSV export (no request: the rows are already on the page). */
export function WorklistTable({ data }: { data: Worklists }) {
  const download = () => {
    const blob = new Blob([toCsv(WORKLIST_COLUMNS, data.rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cdmss-${data.metric_id}-worklist.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <>
      <p>
        {data.rows.length} of {data.total} rows{data.truncated ? " (list capped at 500; narrow the filter)" : ""}.{" "}
        <button type="button" onClick={download} disabled={!data.rows.length}>Export CSV</button>
      </p>
      <table className="scr-table" aria-label="Worklist">
        <thead><tr><th>Doctor</th><th>UHID</th><th>Site</th><th>Note date</th><th>Finding</th><th>Evidence</th><th>Case</th></tr></thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.row_id}>
              <td>{r.doctor}</td><td>{r.uhid ?? "–"}</td><td>{r.site}</td><td>{r.note_date}</td><td>{r.finding}</td>
              <td>{r.quote ? <q>{r.quote}</q> : "–"}</td>
              <td>{r.case_url ? <a href={r.case_url} target="_blank" rel="noreferrer noopener">open case</a> : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
