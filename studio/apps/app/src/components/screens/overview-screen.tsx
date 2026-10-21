"use client";

import { useMemo, useState } from "react";
import { BarChart } from "@/components/generative-ui/charts/bar-chart";
import { PieChart } from "@/components/generative-ui/charts/pie-chart";
import { useScreenTool } from "@/lib/screens/use-screen-tool";
import { DataTable, SourceLine, StatTile, ToolSection } from "./parts";
import { ScreenFrame } from "./screen-frame";
import { useScreenContext } from "./screen-context";

// Labels are fixed here; the numbers are the tool's. `incidents_open` is the PATIENT FEEDBACK table
// (incident_summary / overview_counts read `incidents`, not the e-IRIS register), so it is labelled that way.
export const COUNT_LABELS: Record<string, string> = {
  physicians_active: "Active physicians",
  physicians_total: "Physicians (all statuses)",
  hospitals_active: "Active hospitals",
  engagements_open: "Open engagements",
  incidents_open: "Open patient feedback",
  interventions_total: "Interventions logged",
  signal_snapshot_days: "Signal snapshot days",
};

export const FEEDBACK_WINDOWS = [7, 30, 90] as const;

const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);

export function sumBy(rows: Array<Record<string, unknown>>, key: string, value = "incidents"): Array<{ label: string; value: number }> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const label = String(row[key] ?? "n/a");
    totals.set(label, (totals.get(label) ?? 0) + num(row[value]));
  }
  return [...totals].map(([label, v]) => ({ label, value: v }));
}

export function OverviewScreen() {
  const [windowDays, setWindowDays] = useState<(typeof FEEDBACK_WINDOWS)[number]>(30);
  const counts = useScreenTool("overview_counts", {});
  const feedbackParams = useMemo(() => ({ window_days: windowDays }), [windowDays]);
  const feedback = useScreenTool("incident_summary", feedbackParams);
  const signalParams = useMemo(() => ({ window_days: 7, limit: 30 }), []);
  const signals = useScreenTool("signal_snapshots", signalParams);
  const interventionParams = useMemo(() => ({ limit: 10 }), []);
  const interventions = useScreenTool("interventions", interventionParams);

  useScreenContext("overview", {}, { patient_feedback_window_days: windowDays }, [
    { tool: "overview_counts", params: {}, state: counts },
    { tool: "incident_summary", params: feedbackParams, state: feedback },
    { tool: "signal_snapshots", params: signalParams, state: signals },
    { tool: "interventions", params: interventionParams, state: interventions },
  ]);

  return (
    <ScreenFrame title="Programme overview">
      <ToolSection title="Headline counts" state={counts} retry={counts.retry}>
        {(data) => (
          <>
            <div className="scr-tiles">
              {data.rows.map((row) => (
                <StatTile
                  key={String(row.metric)}
                  label={COUNT_LABELS[String(row.metric)] ?? String(row.metric).replace(/_/g, " ")}
                  value={typeof row.value === "number" ? row.value : null}
                  data={data}
                />
              ))}
            </div>
            <SourceLine data={data} />
          </>
        )}
      </ToolSection>

      <ToolSection
        title="Patient feedback"
        note="Patient feedback records (not the e-IRIS incident register). Counts only; no narratives."
        state={feedback}
        retry={feedback.retry}
      >
        {(data) => (
          <>
            <div className="scr-filters" role="group" aria-label="Patient feedback window">
              {FEEDBACK_WINDOWS.map((d) => (
                <button key={d} type="button" aria-pressed={windowDays === d} onClick={() => setWindowDays(d)}>
                  Last {d} days
                </button>
              ))}
            </div>
            <div className="scr-charts">
              <BarChart title="By status" description={`Patient feedback, last ${windowDays} days`} data={sumBy(data.rows, "status")} />
              <PieChart title="By polarity" description={`Patient feedback, last ${windowDays} days`} data={sumBy(data.rows, "polarity")} />
            </div>
            <DataTable data={data} labels={{ incidents: "records" }} />
          </>
        )}
      </ToolSection>

      <ToolSection title="Governance signals" note="Latest signal snapshots, last 7 days." state={signals} retry={signals.retry}>
        {(data) => <DataTable data={data} empty="No signal snapshots in this window." />}
      </ToolSection>

      <ToolSection title="Recent interventions" note="Most recent 10; no free-text notes." state={interventions} retry={interventions.retry}>
        {(data) => (
          <DataTable
            data={data}
            columns={["done_on", "signal_label", "kind", "action", "cdmss_sync_state"]}
            labels={{ done_on: "date", signal_label: "signal", cdmss_sync_state: "sync" }}
          />
        )}
      </ToolSection>
    </ScreenFrame>
  );
}
