"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { toCsv } from "@/lib/cdmss/csv";
import type { DoctorRow, Envelope, Evidence, Stat, ViewPayload } from "@/lib/cdmss/contract";
import { describeCdmssError } from "@/lib/cdmss/use-cdmss-view";

// Exhibit kit for the CDMSS module. Charts are plain SVG; every fact renders as a text node (never HTML). The agent
// enforces min-n, coverage greying and the change rule; these components only render what the Stat says.

const PALETTE = ["#2a6fdb", "#d9822b", "#2f9e6f", "#8a5cc2", "#c2487a", "#4a8f9e"];
/** Fixed colour per site code: the two known sites keep theirs, any other code gets a stable one from its letters. */
export const SITE_COLOURS: Record<string, string> = { EHRC: PALETTE[0], EHBR: PALETTE[1], ALL: "#555", UNMAPPED: "#999", MULTI: "#999" };
export const siteColour = (s: string | null | undefined): string => {
  if (!s) return "#999";
  if (SITE_COLOURS[s]) return SITE_COLOURS[s];
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % PALETTE.length;
  return PALETTE[h];
};
export const BAND_COLOURS: Record<string, string> = { A: "#2f9e6f", B: "#8cc152", C: "#f2c230", D: "#e8833a", E: "#d64545" };

export const pct1 = (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${(v * 100).toFixed(1)}%`);
const ci = (c: [number, number] | null, u: Stat["unit"]) => (c ? (u === "percent" ? ` (${c[0].toFixed(1)}–${c[1].toFixed(1)}%)` : ` (${c[0].toFixed(2)}–${c[1].toFixed(2)})`) : "");

/** Value text by unit. Rates the agent sends as fractions (v3/v4 rows) are formatted with pct1 at the call site. */
export function statValue(s: Stat): string {
  if (s.value === null) return "–";
  if (s.unit === "score") return s.value.toFixed(0);
  if (s.unit === "percent") return `${s.value.toFixed(1)}%`;
  if (s.unit === "count") return String(s.value);
  return s.value.toFixed(2);
}

/** Rule 3: numerator / denominator / n / window / definition id beside the number. count_only and greyed are greyed. */
export function Figure({ s, withWindow = false }: { s: Stat; withWindow?: boolean }) {
  if (s.status === "unavailable") return <span className="cd-grey" data-status="unavailable">unavailable{s.note ? `: ${s.note}` : ""} <span className="cd-def">{s.metric_id}</span></span>;
  // Below the minimum n the number of events behind a rate is one division from the hidden rate: show n only.
  if (s.status === "count_only") return <span className="cd-grey" data-status="count_only">n = {s.n}, below the minimum for a rate</span>;
  const grey = s.status !== "ok";
  return (
    <span className={grey ? "cd-grey" : undefined} data-status={s.status}>
      <strong>{statValue(s)}</strong>
      <span className="cd-ci">{ci(s.ci95, s.unit)}</span>
      {s.coverage && <span className="cd-cov">, {s.coverage.pct.toFixed(0)}% of notes assessed</span>}
      {s.band && <span className="cd-cov"> · band {s.band}</span>}
      <span className="cd-def"> {s.numerator !== null && s.denominator !== null ? `${s.numerator}/${s.denominator} · ` : ""}n {s.n} · {s.metric_id}{withWindow ? ` · ${s.window.from} to ${s.window.to}` : ""}</span>
      {grey && s.grey_reason && <span className="cd-def"> · {s.grey_reason.replace(/_/g, " ")}</span>}
      {s.plain && <span className="cd-def"> · {s.plain}</span>}
    </span>
  );
}

/** Rule 6: change line with early and late windows named. */
export function ChangeLine({ s }: { s: Stat }) {
  const c = s.change;
  if (!c) return null;
  return (
    <span className="cd-change">
      {c.direction} <span className="cd-def">({c.early.from} to {c.early.to}: {c.early.value ?? "–"}, n {c.early.n}; {c.late.from} to {c.late.to}: {c.late.value ?? "–"}, n {c.late.n}{c.p_value !== null ? `; p ${c.p_value.toFixed(3)}` : ""})</span>
    </span>
  );
}

/** Rules 1, 2, 9, 10: headline, provenance, caveats, action line. */
export function EnvelopeBlock({ env }: { env: Envelope }) {
  const p = env.provenance;
  return (
    <>
      <section className="scr-card cd-headline" aria-label="Headline">
        <h2>{env.headline.sentence}</h2>
        {env.headline.plain && <p>{env.headline.plain}</p>}
        <p className="cd-action"><strong>Look first:</strong> {env.action_line}</p>
      </section>
      <p className="scr-source" data-testid="provenance">
        Window {p.window.from} to {p.window.to} · data cut-off {p.data_cutoff ?? "unknown"} · sources {p.sources.join(", ")} · engine {p.engine_family}
        {p.db13_as_of ? ` · DB13 as of ${p.db13_as_of}` : ""}
      </p>
      <ul className="cd-caveats" aria-label="Caveats">
        {[...env.caveats, env.precision_line].map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </>
  );
}

/** The standing caption while site comparisons are withheld (agent-side switch, coverage under 90%). */
export function SiteWithheld({ sc }: { sc: { withheld: boolean; caption: string | null } | undefined }) {
  if (!sc?.withheld || !sc.caption) return null;
  return (
    <p className="scr-card cd-withheld" role="note" data-testid="site-withheld">
      {sc.caption}
    </p>
  );
}

export function SourceNote({ d }: { d: { source: { tool: string; query_hash: string }; mode: string; synthetic: boolean; incomplete?: string } }) {
  return (
    <p className="scr-source" data-testid="source-line">
      Source: {d.source.tool} · query {d.source.query_hash}{d.mode === "live" && !d.synthetic ? " · live, read-only" : " · SAMPLE DATA"}{d.incomplete ? ` · INCOMPLETE: ${d.incomplete}` : ""}
    </p>
  );
}

export const STILL_LOADING_MS = 10_000;

/** "Loading…", then after 10 s "still loading" (the agent is slow, not failing): never an error because time passed. */
function LoadingNote() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), STILL_LOADING_MS);
    return () => clearTimeout(t);
  }, []);
  return (
    <p className="scr-muted" role="status">
      {slow ? "Still loading: a large window can take up to a minute. Nothing is wrong; the page will fill in." : "Loading…"}
    </p>
  );
}

export function ViewState<T>({ state, retry, children }: { state: { status: "loading" } | { status: "error"; code: string } | { status: "ok"; data: T }; retry: () => void; children: (data: T) => ReactNode }) {
  if (state.status === "loading") return <LoadingNote />;
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
    ["doctor_variation", "/cdmss/doctors", "Doctor variation"],
    ["contributors", "/cdmss/contributors", "Contributors"],
    ["redflags", "/cdmss/red-flags", "Red flags"],
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

type Scorecard = ViewPayload<"scorecard">["view"];

/** Site x metric matrix. */
export function ScorecardMatrix({ data }: { data: Scorecard }) {
  return (
    <>
      <p className="cd-def">Site = {data.site_basis === "doctor_home_site" ? "the doctor's home site, not where the note was written" : data.site_basis}.</p>
      <table className="scr-table" aria-label="Site scorecard">
        <thead>
          <tr>
            <th>Metric</th>
            {data.matrix.map((r) => (
              <th key={r.site} style={{ color: siteColour(r.site) }}>{r.site} <span className="cd-def">{r.n_notes} notes</span></th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.metrics.map((m) => (
            <tr key={m.metric_id}>
              <th scope="row">{m.label}</th>
              {data.matrix.map((r) => (
                <td key={r.site}>{r.cells[m.metric_id] ? <Figure s={r.cells[m.metric_id]} /> : "–"}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** Trend lines, one per site, fixed colours. */
export function TrendLines({ data, metricId }: { data: Scorecard; metricId: string }) {
  // The hospital-wide (ALL) line always draws; while site comparison is withheld it is the only line.
  const series = data.trend.filter((t) => t.metric_id === metricId);
  const weeks = Array.from(new Set(series.flatMap((s) => s.points.map((p) => p.week_to)))).sort();
  const vals = series.flatMap((s) => s.points.map((p) => p.value).filter((v): v is number => v !== null));
  if (!weeks.length || !vals.length) return <p className="scr-muted">No trend data.</p>;
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const W = 480, H = 160, P = 28;
  const x = (w: string) => P + (weeks.length === 1 ? 0 : (weeks.indexOf(w) * (W - 2 * P)) / (weeks.length - 1));
  const y = (v: number) => H - P - ((v - lo) / span) * (H - 2 * P);
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Weekly trend of ${metricId} by site`} className="cd-chart">
        {weeks.map((w) => <text key={w} x={x(w)} y={H - 8} fontSize="9" textAnchor="middle">{w.slice(5)}</text>)}
        {series.map((s) => (
          <polyline key={s.site} fill="none" stroke={siteColour(s.site)} strokeWidth="2" data-site={s.site}
            points={s.points.filter((p) => p.value !== null).map((p) => `${x(p.week_to)},${y(p.value as number)}`).join(" ")} />
        ))}
      </svg>
      <figcaption>{series.map((s) => <span key={s.site} style={{ color: siteColour(s.site) }}>■ {s.site} </span>)}<span className="cd-def">weeks ending (IST); range {lo.toFixed(1)}–{hi.toFixed(1)}</span></figcaption>
    </figure>
  );
}

/** Stacked mix bar from a list of {label, share} parts (e.g. raw band A-E). */
export function StackedMixBar({ rows }: { rows: Array<{ key: string; label: string; n: number; parts: Array<{ name: string; share: number }>; colour?: string; grey?: string }> }) {
  return (
    <div>
      {rows.map((b) => {
        let acc = 0;
        return (
          <div key={b.key} className="cd-mixrow">
            <span className="cd-mixlabel" style={{ color: b.colour }}>{b.label} <span className="cd-def">n {b.n}</span></span>
            {b.grey ? <span className="cd-grey" data-testid="mix-grey">count only: {b.grey}</span> : <svg viewBox="0 0 100 8" preserveAspectRatio="none" className="cd-mix" role="img" aria-label={`${b.label}: ${b.parts.map((p) => `${p.name} ${(p.share * 100).toFixed(0)}%`).join(", ")}`}>
              {b.parts.map((p) => {
                const r = <rect key={p.name} x={acc * 100} width={p.share * 100} height="8" fill={BAND_COLOURS[p.name] ?? "#999"}><title>{p.name} {(p.share * 100).toFixed(0)}%</title></rect>;
                acc += p.share;
                return r;
              })}
            </svg>}
          </div>
        );
      })}
    </div>
  );
}

/** V2 band mix: raw-band shares of PDQI-assessed notes per site (RULING Band); a site whose bands are under min-n
 * shows its count only. */
export function BandMix({ data }: { data: Scorecard }) {
  const rows = data.band_mix.map((b) => {
    const stats = (["A", "B", "C", "D", "E"] as const).map((k) => b.bands[k]);
    const hidden = stats.some((s) => s.status === "count_only" || s.value === null);
    const n = stats[0].n;
    return {
      key: b.site,
      label: b.site,
      n,
      colour: siteColour(b.site),
      grey: hidden ? `${n} assessed notes (${Object.entries(b.counts).map(([k, v]) => `${k} ${v}`).join(", ")})` : undefined,
      parts: stats.map((s, i) => ({ name: "ABCDE"[i], share: (s.value ?? 0) / 100 })),
    };
  });
  if (!rows.length) return <p className="scr-muted">No band mix for this family.</p>;
  return <StackedMixBar rows={rows} />;
}

type DV = ViewPayload<"doctor_variation">["view"];

/** Funnel plot of the rate against n with the agent's 95% and 99.8% limits (nothing is recomputed here). Only
 * doctors the agent ranked (rank set, position not greyed) are plotted. */
export function FunnelPlot({ data }: { data: DV }) {
  const f = data.funnel;
  const pts = data.doctors.filter((r) => r.position !== "greyed" && r.value !== null);
  if (!f || !f.limits.length || !pts.length) return <p className="scr-muted">No funnel for this metric, or not enough doctors with volume.</p>;
  const maxN = Math.max(...f.limits.map((l) => l.n), ...pts.map((r) => r.n)) * 1.05;
  const W = 480, H = 240, P = 32;
  const maxY = Math.min(1, Math.max(...f.limits.map((l) => l.hi998), ...pts.map((r) => r.value as number)) * 1.05);
  const x = (n: number) => P + (n / maxN) * (W - 2 * P);
  const y = (v: number) => H - P - (Math.max(0, v) / maxY) * (H - 2 * P);
  const line = (k: "lo95" | "hi95" | "lo998" | "hi998") => f.limits.map((l) => `${x(l.n)},${y(l[k])}`).join(" ");
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Funnel plot of doctor rates against volume" className="cd-chart">
        <line x1={P} x2={W - P} y1={y(f.centre)} y2={y(f.centre)} stroke="#888" strokeDasharray="4 3" />
        {(["lo95", "hi95"] as const).map((k) => <polyline key={k} fill="none" stroke="#888" points={line(k)} />)}
        {(["lo998", "hi998"] as const).map((k) => <polyline key={k} fill="none" stroke="#b33" strokeWidth="1.5" points={line(k)} />)}
        {pts.map((r) => (
          <circle key={r.doctor_uid} cx={x(r.n)} cy={y(r.value as number)} r="4" fill={siteColour(r.site)} data-position={r.position}>
            <title>{r.doctor_name}: {pct1(r.value)} over {r.n} notes</title>
          </circle>
        ))}
        <text x={P} y={H - 8} fontSize="10">notes audited (n) →</text>
      </svg>
      <figcaption>Dashed: {pct1(f.centre)} ({f.centre_basis}). Grey lines 95%, red lines 99.8%. {f.adjustment}.</figcaption>
    </figure>
  );
}

const POSITION_TEXT: Record<DoctorRow["position"], string> = {
  above_998: "above 99.8% limit", above_95: "above 95% limit", within: "within limits", below_95: "below 95% limit", below_998: "below 99.8% limit", greyed: "not in funnel (under 50 notes)",
};

/** Ranked dot-and-whisker. Names sit only beside n and the interval. Doctors with fewer than 10 notes (rank null,
 * count_only): count only, greyed, no rank. */
export function DotWhisker({ data }: { data: DV }) {
  const ranked = data.doctors.filter((r) => r.rank !== null).sort((a, b) => (a.rank as number) - (b.rank as number));
  const unranked = data.doctors.filter((r) => r.rank === null);
  const asPct = data.metric === "lv_rate";
  const W = 240;
  const [lo, hi] = asPct ? [0, 1] : [0, 100];
  return (
    <>
      <table className="scr-table" aria-label="Doctors ranked">
        <thead><tr><th>#</th><th>Doctor</th><th>Site</th><th>Notes (n)</th><th>Value and interval</th><th aria-hidden="true"></th><th>Against funnel</th></tr></thead>
        <tbody>
          {ranked.map((r) => (
            <tr key={r.doctor_uid}>
              <td>{r.rank}</td>
              <td>{r.doctor_name}</td>
              <td style={{ color: siteColour(r.site) }}>{r.site ?? "–"}</td>
              <td>{r.n}</td>
              <td><Figure s={r.stat} />{r.oe !== null && r.oe !== undefined && <span className="cd-def"> · O/E {r.oe.toFixed(2)}</span>}</td>
              <td>
                {r.ci95 && r.value !== null && (
                  <svg viewBox={`0 0 ${W} 12`} width={W} height="12" role="img" aria-label={`${r.doctor_name} interval`}>
                    <line x1={((r.ci95[0] - lo) / (hi - lo)) * W} x2={((r.ci95[1] - lo) / (hi - lo)) * W} y1="6" y2="6" stroke={siteColour(r.site)} />
                    <circle cx={((r.value - lo) / (hi - lo)) * W} cy="6" r="3.5" fill={siteColour(r.site)} />
                  </svg>
                )}
              </td>
              <td>{POSITION_TEXT[r.position]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(unranked.length > 0 || data.excluded.count > 0) && (
        <p className="cd-grey" data-testid="unranked">
          Not ranked: {unranked.map((r) => `${r.doctor_name} (n ${r.n})`).join("; ")}{unranked.length ? ". " : ""}
          {data.excluded.count} more excluded: {data.excluded.reason}.
        </p>
      )}
    </>
  );
}

type Contrib = ViewPayload<"contributors">["view"];

export function ContributorTable({ data }: { data: Contrib }) {
  return (
    <>
      <p>
        {data.site}: <Figure s={data.site_rate} /> · other sites: <Figure s={data.other_sites_rate} />
        {data.gap ? <> · gap {(data.gap.absolute * 100).toFixed(1)} points{data.gap.relative !== null ? ` (${(data.gap.relative * 100).toFixed(0)}% relative)` : ""}</> : " · no gap"}
        {data.top_contributor_removed && <> · site rate without its top contributor {pct1(data.top_contributor_removed.site_rate_without)}</>}
      </p>
      <table className="scr-table" aria-label="Contributors to the site gap">
        <thead><tr><th>Doctor</th><th>Notes (n)</th><th>Events</th><th>Rate and interval</th><th>Share of gap</th><th>Site rate without</th></tr></thead>
        <tbody>
          {data.contributors.map((r) => {
            const grey = r.status === "count_only";
            return (
              <tr key={r.doctor_uid} className={grey ? "cd-grey" : undefined}>
                <td>{r.doctor_name}</td>
                <td>{r.n}</td>
                <td>{grey ? "–" : r.events}</td>
                <td>{grey ? "–" : `${pct1(r.rate)}${r.ci95 ? ` (${pct1(r.ci95[0])}–${pct1(r.ci95[1])})` : ""}`}</td>
                <td>{grey || r.share_of_gap === null ? "–" : `${(r.share_of_gap * 100).toFixed(0)}%`}</td>
                <td>{grey ? "–" : pct1(r.site_rate_without)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

/** A link to the CDMSS case page. Labelled unverified unless the agent says the URL pattern is verified (the worklist
 * columns carry no flag, so they are always labelled). */
export function CaseLink({ url, verified }: { url: string | null | undefined; verified?: boolean }) {
  if (!url || !/^https?:\/\//.test(url)) return <span className="cd-grey">no case link</span>;
  return <a href={url} target="_blank" rel="noreferrer noopener">{verified === true ? "CDMSS page" : "CDMSS page (link unverified)"}</a>;
}

export function EvidenceList({ items }: { items: Evidence[] }) {
  if (!items.length) return <p className="cd-grey">No evidence rows.</p>;
  return (
    <ul>
      {items.map((e, i) => (
        <li key={`${e.uid ?? i}-${e.finding_no ?? i}`}>
          {e.note_day ? `${e.note_day}: ` : ""}{e.subject ?? "finding"}
          {e.quote ? <> — <q>{e.quote}</q></> : null}{" "}
          <CaseLink url={e.case?.url} verified={e.case?.url_verified} />
        </li>
      ))}
    </ul>
  );
}

type WL = ViewPayload<"worklists">;

const isHttp = (v: unknown): v is string => typeof v === "string" && /^https?:\/\//.test(v);

/** Named worklist (columns from the agent's columns_meta) with client-side CSV export (no request). */
export function WorklistTable({ data }: { data: WL }) {
  const cols = data.view.columns_meta;
  const download = () => {
    const blob = new Blob([toCsv(cols.map((c) => c.key), data.rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cdmss-${data.view.list}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <>
      <p>
        {data.rows.length} of {data.view.total} rows{data.view.total > data.rows.length ? " (lists show at most 500 rows; narrow the filter)" : ""}.{" "}
        <button type="button" onClick={download} disabled={!data.rows.length}>Export CSV</button>
      </p>
      <table className="scr-table" aria-label="Worklist">
        <thead><tr>{cols.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
        <tbody>
          {data.rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => {
                const v = r[c.key];
                return <td key={c.key}>{c.kind === "url" || c.key === "case_url" ? (isHttp(v) ? <CaseLink url={v} /> : "–") : v === null || v === undefined ? "–" : String(v)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
