"use client";

import { useState } from "react";
import { ScreenFrame } from "@/components/screens/screen-frame";
import { DV_METRICS, FAMILIES, WORKLISTS, type DvMetric, type Family, type ViewId, type ViewParams, type WorklistId } from "@/lib/cdmss/contract";
import { useCdmssContext } from "@/lib/cdmss/use-cdmss-context";
import { useCdmssView } from "@/lib/cdmss/use-cdmss-view";
import { ChangeLine, ContributorTable, DotWhisker, EnvelopeBlock, EvidenceList, Figure, FunnelPlot, ScorecardMatrix, SourceNote, TrendLines, ViewState, ViewTabs, WorklistTable, siteColour } from "./exhibits";

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
  return (
    <ScreenFrame title="CDMSS · Family scorecard">
      <ViewTabs current="scorecard" />
      <form className="scr-filters scr-form" onSubmit={(e) => e.preventDefault()}><FamilyFilter p={params} set={setParams} /><WindowFilter p={params} set={setParams} /></form>
      <ViewState state={state} retry={state.retry}>
        {(d) => {
          return (
            <>
              <EnvelopeBlock env={d.view.envelope} />
              <section className="scr-card" aria-label="Site scorecard"><ScorecardMatrix data={d.view} /></section>
              {d.view.metrics.map((m) => (
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
  const { params, setParams, state } = useView("doctor_variation", { family: "opd", metric: "lv_rate", window_days: 28 });
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
  // The contract requires a site; EHRC is the default until the site list comes from the agent (open question).
  const { params, setParams, state } = useView("contributors", { family: "opd", site: "EHRC", metric: "lv_rate", window_days: 28 });
  return (
    <ScreenFrame title="CDMSS · Contributors">
      <ViewTabs current="contributors" />
      <form className="scr-filters scr-form" onSubmit={(e) => e.preventDefault()}>
        <Select label="Site" value={params.site ?? "EHRC"} options={[["EHRC", "EHRC"], ["EHBR", "EHBR"]] as Array<[string, string]>} onChange={(site) => setParams({ ...params, site })} />
        <WindowFilter p={params} set={setParams} />
      </form>
      <ViewState state={state} retry={state.retry}>
        {(d) => (
          <>
            <EnvelopeBlock env={d.view.envelope} />
            <section className="scr-card" aria-label="Contributors"><ContributorTable data={d.view} /></section>
            <SourceNote d={d} />
          </>
        )}
      </ViewState>
    </ScreenFrame>
  );
}

export function RedFlagsScreen() {
  const { params, setParams, state } = useView("redflags", { family: "opd", window_days: 28 });
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
                <h3>{x.doctor_name} · {x.site ?? "unmapped"} <span className="cd-def">{x.n_notes} notes</span></h3>
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
  const { params, setParams, state } = useView("worklists", { family: "opd", list: "low_value_findings", window_days: 28, limit: 500 });
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
