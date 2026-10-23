"use client";

import { useEffect, useState } from "react";
import { ScreenFrame } from "@/components/screens/screen-frame";
import { DV_METRICS, FAMILIES, WORKLISTS, type SiteOption, type DvMetric, type Family, type ViewId, type ViewParams, type WorklistId } from "@/lib/cdmss/contract";
import { useCdmssContext } from "@/lib/cdmss/use-cdmss-context";
import { useCdmssView } from "@/lib/cdmss/use-cdmss-view";
import { BandMix, ChangeLine, ContributorTable, DotWhisker, EnvelopeBlock, EvidenceList, Figure, FunnelPlot, ScorecardMatrix, SiteWithheld, SourceNote, TrendLines, ViewState, ViewTabs, WorklistTable, siteColour } from "./exhibits";

// One component per view. Each makes exactly ONE useCdmssView call (one POST per mount per distinct params), reports
// the open view and filters to the side-panel agent, and renders the envelope above the exhibits.

const FAMILY_LABEL: Record<Family, string> = { opd: "OPD note audit", ams: "Antimicrobial stewardship" };
const WORKLIST_LABEL: Record<WorklistId, string> = { signals_open: "Open signals", signals_overdue: "Overdue signals", low_value_findings: "Low-value findings", missing_pdqi: "Notes without PDQI-9" };
const WINDOWS = [7, 28, 91] as const;

function Select<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: ReadonlyArray<[T, string]>; onChange: (v: T) => void }) {
  return (
    <label>
      {label}
      <select value={String(value)} onChange={(e) => { const o = options.find(([v]) => String(v) === e.target.value); if (o) onChange(o[0]); }}>
        {options.map(([v, l]) => <option key={String(v)} value={String(v)}>{l}</option>)}
      </select>
    </label>
  );
}

const FamilyFilter = ({ p, set }: { p: ViewParams; set: (n: ViewParams) => void }) => (
  <Select label="Family" value={p.family ?? "opd"} options={FAMILIES.map((f) => [f, FAMILY_LABEL[f]] as [Family, string])} onChange={(family) => set({ ...p, family })} />
);
const WindowFilter = ({ p, set }: { p: ViewParams; set: (n: ViewParams) => void }) => (
  <Select label="Window" value={p.window_days ?? 28} options={WINDOWS.map((d) => [d, `${d} days`] as [number, string])} onChange={(window_days) => set({ ...p, window_days })} />
);

/** Keeps the last site list the agent sent, so the picker does not empty while the next read loads. */
function useSites(state: { status: string; data?: { view: { sites: SiteOption[] } } }): SiteOption[] {
  const [sites, setSites] = useState<SiteOption[]>([]);
  const fresh = state.status === "ok" ? state.data?.view.sites : undefined;
  const key = fresh ? JSON.stringify(fresh) : "";
  useEffect(() => {
    if (fresh) setSites(fresh);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return sites;
}

const SitePicker = ({ sites, value, onChange, all }: { sites: SiteOption[]; value: string | undefined; onChange: (v: string | undefined) => void; all: boolean }) => {
  const opts = sites.filter((x) => (all ? true : x.code !== "ALL"));
  if (!opts.length) return null;
  return (
    <Select label="Site" value={value ?? "ALL"} options={opts.map((x) => [x.code, `${x.label} (${x.n} notes)`] as [string, string])} onChange={(v) => onChange(v === "ALL" ? undefined : v)} />
  );
};

function useView<V extends ViewId>(view: V, initial: ViewParams) {
  const [params, setParams] = useState<ViewParams>(initial);
  const state = useCdmssView(view, params);
  useCdmssContext(view, params, state.status, state.status === "ok" ? state.data.source.query_hash : null);
  return { params, setParams, state };
}

export function ThisWeekScreen() {
  const { state } = useView("this_week", {});
  return (
    <ScreenFrame title="CDMSS · This week">
      <ViewTabs current="this_week" />
      <ViewState state={state} retry={state.retry}>
        {(d) => (
          <>
            <EnvelopeBlock env={d.view.envelope} />
            <div className="scr-tiles">
              {d.view.families.map((f) => (
                <section key={f.family} className="scr-card" aria-label={f.label}>
                  <h3>{f.label}</h3>
                  {f.status === "coming" ? (
                    <p className="cd-grey">Coming</p>
                  ) : (
                    f.tiles?.map((t) => (
                      <div key={t.stat.metric_id}>
                        <p>{t.headline ?? t.stat.label}</p>
                        <p><Figure s={t.stat} /></p>
                        {t.stat.change && <p><ChangeLine s={t.stat} /></p>}
                      </div>
                    ))
                  )}
                </section>
              ))}
            </div>
            <SourceNote d={d} />
          </>
        )}
      </ViewState>
    </ScreenFrame>
  );
}

export function ScorecardScreen() {
  const { params, setParams, state } = useView("scorecard", { family: "opd", window_days: 28 });
  const sites = useSites(state);
  return (
    <ScreenFrame title="CDMSS · Family scorecard">
      <ViewTabs current="scorecard" />
      <form className="scr-filters scr-form" onSubmit={(e) => e.preventDefault()}><FamilyFilter p={params} set={setParams} /><WindowFilter p={params} set={setParams} />{!(state.status === "ok" && state.data.view.site_comparison?.withheld) && <SitePicker sites={sites} value={params.site} all onChange={(site) => setParams({ ...params, site })} />}</form>
      <ViewState state={state} retry={state.retry}>
        {(d) => {
          return (
            <>
              <EnvelopeBlock env={d.view.envelope} />
              <SiteWithheld sc={d.view.site_comparison} />
              <section className="scr-card" aria-label="Site scorecard"><ScorecardMatrix data={d.view} /></section>
              {d.view.metrics.filter((m) => d.view.trend.some((t) => t.metric_id === m.metric_id)).map((m) => (
                <section key={m.metric_id} className="scr-card" aria-label={`Trend ${m.label}`}>
                  <h3>{m.label}: weekly trend</h3>
                  <TrendLines data={d.view} metricId={m.metric_id} />
                  <ul>
                    {d.view.matrix.filter((r) => r.cells[m.metric_id]?.change).map((r) => (
                      <li key={r.site}><span style={{ color: siteColour(r.site) }}>{r.site}</span>: <ChangeLine s={r.cells[m.metric_id]} /></li>
                    ))}
                  </ul>
                </section>
              ))}
              {d.view.band_mix.length > 0 && <section className="scr-card" aria-label="Band mix"><h3>Band mix (raw band, PDQI-assessed notes)</h3><BandMix data={d.view} /></section>}
              <SourceNote d={d} />
            </>
          );
        }}
      </ViewState>
    </ScreenFrame>
  );
}

const DV_LABEL: Record<DvMetric, string> = { lv_rate: "Notes with a low-value finding", nqi: "Mean NQI" };

export function DoctorsScreen() {
  const { params, setParams, state } = useView("doctor_variation", { metric: "lv_rate", window_days: 28 });
  return (
    <ScreenFrame title="CDMSS · Doctor variation">
      <ViewTabs current="doctor_variation" />
      <form className="scr-filters scr-form" onSubmit={(e) => e.preventDefault()}>
        <Select label="Measure" value={params.metric ?? "lv_rate"} options={DV_METRICS.map((m) => [m, DV_LABEL[m]] as [DvMetric, string])} onChange={(metric) => setParams({ ...params, metric })} />
        <WindowFilter p={params} set={setParams} />
      </form>
      <ViewState state={state} retry={state.retry}>
        {(d) => (
          <>
            <EnvelopeBlock env={d.view.envelope} />
            {d.view.funnel && <section className="scr-card" aria-label="Funnel plot"><FunnelPlot data={d.view} /></section>}
            <section className="scr-card" aria-label="Ranked doctors"><DotWhisker data={d.view} /></section>
            <SourceNote d={d} />
          </>
        )}
      </ViewState>
    </ScreenFrame>
  );
}

export function ContributorsScreen() {
  // The contract requires a site. The site list is data-driven: one V2 read supplies it (cached 30 s), the V4 read
  // waits (idle) until a site is chosen, by default the site with the most notes. Two reads per mount, no loop.
  const [window_days, setWindow] = useState(28);
  const [picked, setPicked] = useState<string | undefined>();
  const siteRead = useCdmssView("scorecard", { window_days });
  const known = useSites(siteRead);
  const site = picked ?? known.filter((x) => x.code !== "ALL").sort((a, b) => b.n - a.n)[0]?.code;
  const params: ViewParams | null = site ? { site, metric: "lv_rate", window_days } : null;
  const state = useCdmssView("contributors", params);
  useCdmssContext("contributors", params ?? { window_days }, state.status, state.status === "ok" ? state.data.source.query_hash : null);
  const own = useSites(state);
  // Withheld is known from the V2 read as soon as it lands, before V4 answers: the picker is gone in both cases.
  const withheld = (state.status === "ok" && state.data.view.site_comparison?.withheld) || (siteRead.status === "ok" && siteRead.data.view.site_comparison?.withheld);
  const sites = own.length ? own : known;
  return (
    <ScreenFrame title="CDMSS · Contributors">
      <ViewTabs current="contributors" />
      <form className="scr-filters scr-form" onSubmit={(e) => e.preventDefault()}>
        {!withheld && <SitePicker sites={sites} value={site} all={false} onChange={setPicked} />}
        <Select label="Window" value={window_days} options={WINDOWS.map((d) => [d, `${d} days`] as [number, string])} onChange={setWindow} />
      </form>
      {params === null && siteRead.status === "error" && <ViewState state={siteRead} retry={siteRead.retry}>{() => null}</ViewState>}
      {params === null && siteRead.status === "loading" && <p className="scr-muted" role="status">Loading…</p>}
      {params === null && siteRead.status === "ok" && <p className="scr-muted">No site has notes in this window.</p>}
      {params !== null && (
        <ViewState state={state} retry={state.retry}>
          {(d) => (
            <>
              <EnvelopeBlock env={d.view.envelope} />
              <SiteWithheld sc={d.view.site_comparison} />
              {d.view.site_comparison?.withheld ? (
                <section className="scr-card" aria-label="Hospital-wide"><h3>Hospital-wide</h3><p><Figure s={d.view.site_rate} /></p></section>
              ) : (
                <section className="scr-card" aria-label="Contributors"><ContributorTable data={d.view} /></section>
              )}
              <SourceNote d={d} />
            </>
          )}
        </ViewState>
      )}
    </ScreenFrame>
  );
}

export function RedFlagsScreen() {
  const { params, setParams, state } = useView("redflags", { window_days: 28 });
  return (
    <ScreenFrame title="CDMSS · Red-flag dossiers">
      <ViewTabs current="redflags" />
      <form className="scr-filters scr-form" onSubmit={(e) => e.preventDefault()}><WindowFilter p={params} set={setParams} /></form>
      <ViewState state={state} retry={state.retry}>
        {(d) => (
          <>
            <EnvelopeBlock env={d.view.envelope} />
            {d.view.dossiers.map((x) => (
              <section key={x.doctor_uid} className="scr-card" aria-label={`Dossier ${x.doctor_name}`}>
                <h3>{x.doctor_name} · {x.site ?? "unmapped"}</h3>
                <ul aria-label="Signals">
                  {x.signals.map((s) => (
                    <li key={s.signal_id}>
                      {s.signal_type ?? "signal"} · importance {s.importance ?? "–"} · {s.status ?? "–"}{s.response_required ? " · response required" : ""}{s.overdue ? " · OVERDUE" : ""}{s.reference ? ` · ${s.reference}` : ""}
                    </li>
                  ))}
                </ul>
                <EvidenceList items={x.evidence} />
              </section>
            ))}
            <SourceNote d={d} />
          </>
        )}
      </ViewState>
    </ScreenFrame>
  );
}

export function WorklistsScreen() {
  const { params, setParams, state } = useView("worklists", { list: "low_value_findings", window_days: 28, limit: 500 });
  return (
    <ScreenFrame title="CDMSS · Worklists">
      <ViewTabs current="worklists" />
      <form className="scr-filters scr-form" onSubmit={(e) => e.preventDefault()}>
        <Select label="List" value={params.list ?? "low_value_findings"} options={WORKLISTS.map((w) => [w, WORKLIST_LABEL[w]] as [WorklistId, string])} onChange={(list) => setParams({ ...params, list })} />
        <WindowFilter p={params} set={setParams} />
      </form>
      <ViewState state={state} retry={state.retry}>
        {(d) => (
          <>
            <EnvelopeBlock env={d.view.envelope} />
            <section className="scr-card" aria-label="Worklist"><WorklistTable data={d} /></section>
            <SourceNote d={d} />
          </>
        )}
      </ViewState>
    </ScreenFrame>
  );
}
