"use client";

import { useState } from "react";
import { ScreenFrame } from "@/components/screens/screen-frame";
import { FAMILIES, type Family, type ViewId, type ViewParams } from "@/lib/cdmss/contract";
import { useCdmssContext } from "@/lib/cdmss/use-cdmss-context";
import { useCdmssView } from "@/lib/cdmss/use-cdmss-view";
import { ContributorTable, DotWhisker, EnvelopeBlock, Figure, FunnelPlot, ScorecardMatrix, StackedMixBar, TrendLines, ViewState, ViewTabs, WorklistTable } from "./exhibits";

// One component per view. Each makes exactly ONE useCdmssView call (one POST per mount per distinct params), reports
// the open view and filters to the side-panel agent, and renders the envelope above the exhibits.

const FAMILY_LABEL: Record<Family, string> = { opd: "OPD note audit", stewardship: "Antimicrobial stewardship" };
// Phase-1 default metric per family (catalogue ids).
const DEFAULT_METRIC: Record<Family, string> = { opd: "M-OPD-05", stewardship: "M-AMS-03" };

function Filters({ params, set, metrics }: { params: ViewParams; set: (p: ViewParams) => void; metrics?: string[] }) {
  return (
    <form className="scr-filters scr-form" onSubmit={(e) => e.preventDefault()}>
      <label>
        Family
        <select value={params.family ?? "opd"} onChange={(e) => { const family = e.target.value as Family; set({ ...params, family, metric_id: DEFAULT_METRIC[family] }); }}>
          {FAMILIES.map((f) => <option key={f} value={f}>{FAMILY_LABEL[f]}</option>)}
        </select>
      </label>
      {metrics && (
        <label>
          Metric
          <select value={params.metric_id ?? ""} onChange={(e) => set({ ...params, metric_id: e.target.value })}>
            {metrics.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
      )}
    </form>
  );
}

function useView<V extends ViewId>(view: V, initial: ViewParams) {
  const [params, setParams] = useState<ViewParams>({ family: "opd", ...initial });
  const state = useCdmssView(view, params);
  useCdmssContext(view, params, state.status);
  return { params, setParams, state };
}

const OPD_METRICS = ["M-OPD-01", "M-OPD-03", "M-OPD-05", "M-OPD-06"];
const AMS_METRICS = ["M-AMS-03"];
const metricsFor = (f?: Family) => (f === "stewardship" ? AMS_METRICS : OPD_METRICS);

export function ThisWeekScreen() {
  const { state } = useView("this_week", {});
  return (
    <ScreenFrame title="CDMSS · This week">
      <ViewTabs current="this_week" />
      <ViewState state={state} retry={state.retry}>
        {(d) => (
          <>
            <EnvelopeBlock env={d} />
            <div className="scr-tiles">
              {d.tiles.map((t) => (
                <section key={t.family} className="scr-card" aria-label={t.title}>
                  <h3>{t.title}</h3>
                  {t.state === "coming" ? (
                    <p className="cd-grey">Coming</p>
                  ) : (
                    <>
                      <p>{t.headline}</p>
                      {t.metric && <p><Figure m={t.metric} /></p>}
                      {t.change && <p>{t.change}{t.early_late ? ` (${t.early_late})` : ""}</p>}
                    </>
                  )}
                </section>
              ))}
            </div>
          </>
        )}
      </ViewState>
    </ScreenFrame>
  );
}

export function ScorecardScreen() {
  const { params, setParams, state } = useView("scorecard", {});
  return (
    <ScreenFrame title="CDMSS · Family scorecard">
      <ViewTabs current="scorecard" />
      <Filters params={params} set={setParams} />
      <ViewState state={state} retry={state.retry}>
        {(d) => (
          <>
            <EnvelopeBlock env={d} />
            <section className="scr-card" aria-label="Site scorecard"><ScorecardMatrix data={d} /></section>
            {d.metrics.map((m) => (
              <section key={m.id} className="scr-card" aria-label={`Trend ${m.label}`}>
                <h3>{m.label}: weekly trend</h3>
                <TrendLines data={d} metricId={m.id} />
                <ul>{d.change.filter((c) => c.metric_id === m.id).map((c) => <li key={c.site}>{c.site}: {c.verdict} ({c.early_late})</li>)}</ul>
              </section>
            ))}
            <section className="scr-card" aria-label="Band mix"><h3>Band mix (raw band)</h3><StackedMixBar data={d} /></section>
          </>
        )}
      </ViewState>
    </ScreenFrame>
  );
}

export function DoctorsScreen() {
  const { params, setParams, state } = useView("doctors", { metric_id: "M-OPD-05" });
  return (
    <ScreenFrame title="CDMSS · Doctor variation">
      <ViewTabs current="doctors" />
      <Filters params={params} set={setParams} metrics={metricsFor(params.family)} />
      <ViewState state={state} retry={state.retry}>
        {(d) => (
          <>
            <EnvelopeBlock env={d} />
            <section className="scr-card" aria-label="Funnel plot"><FunnelPlot data={d} /></section>
            <section className="scr-card" aria-label="Ranked doctors"><DotWhisker data={d} /></section>
          </>
        )}
      </ViewState>
    </ScreenFrame>
  );
}

export function ContributorsScreen() {
  const { params, setParams, state } = useView("contributors", { metric_id: "M-OPD-05" });
  return (
    <ScreenFrame title="CDMSS · Contributors">
      <ViewTabs current="contributors" />
      <Filters params={params} set={setParams} metrics={metricsFor(params.family)} />
      <ViewState state={state} retry={state.retry}>
        {(d) => (
          <>
            <EnvelopeBlock env={d} />
            <section className="scr-card" aria-label="Contributors"><ContributorTable data={d} /></section>
          </>
        )}
      </ViewState>
    </ScreenFrame>
  );
}

export function RedFlagsScreen() {
  const { params, setParams, state } = useView("red_flags", {});
  return (
    <ScreenFrame title="CDMSS · Red-flag dossiers">
      <ViewTabs current="red_flags" />
      <Filters params={params} set={setParams} />
      <ViewState state={state} retry={state.retry}>
        {(d) => (
          <>
            <EnvelopeBlock env={d} />
            {d.dossiers.map((x) => (
              <section key={x.doctor_uid} className="scr-card" aria-label={`Dossier ${x.name}`}>
                <h3>{x.name} · {x.site}</h3>
                <p>{x.why}</p>
                <ul>{x.metrics.map((m) => <li key={m.id}>{m.label}: <Figure m={m} /></li>)}</ul>
                <ul>
                  {x.findings.map((f) => (
                    <li key={f.finding_id}>
                      {f.subject}{f.quote ? <> — <q>{f.quote}</q></> : null}{" "}
                      {f.case_url ? <a href={f.case_url} target="_blank" rel="noreferrer noopener">open case</a> : null}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </>
        )}
      </ViewState>
    </ScreenFrame>
  );
}

export function WorklistsScreen() {
  const { params, setParams, state } = useView("worklists", { metric_id: "M-OPD-05" });
  return (
    <ScreenFrame title="CDMSS · Worklists">
      <ViewTabs current="worklists" />
      <Filters params={params} set={setParams} metrics={metricsFor(params.family)} />
      <ViewState state={state} retry={state.retry}>
        {(d) => (
          <>
            <EnvelopeBlock env={d} />
            <section className="scr-card" aria-label="Worklist"><WorklistTable data={d} /></section>
          </>
        )}
      </ViewState>
    </ScreenFrame>
  );
}
