"use client";

import { useMemo, useState } from "react";
import { INCIDENT_ID_RE, type HttpToolParams } from "@/lib/screens/tool-schema";
import { useHttpTool } from "@/lib/screens/use-http-tool";
import { describeScreenError } from "@/lib/screens/use-screen-tool";
import { DataTable, StatTile, ToolSection } from "./parts";
import { ScreenFrame } from "./screen-frame";
import { useScreenContext } from "./screen-context";

// e-IRIS incident register (safety / M&M). This is NOT patient feedback: that is the "Patient feedback" screen
// and a different table. Facts come from eiris_incidents / eiris_incident_detail only, each block shows its
// source line. Narrative, root cause and CAPA text is fetched only on request and the server allows it for
// super_admin alone; it is never put in the side-panel context.

const SEVERITY_FILTERS = ["", "major", "moderate", "minor"] as const;
const TOTAL_LABELS: Record<string, string> = {
  total: "All time",
  open: "Open",
  near_miss: "Near miss",
  high_sev: "High severity",
  with_rca: "With RCA",
  overdue: "Overdue",
  due_soon: "Due soon",
};

const DETAIL_ERRORS: Record<string, string> = {
  forbidden: "Narrative and RCA text is for super_admin only.",
  not_found: "That incident was not found.",
};

export function IncidentsScreen() {
  const [status, setStatus] = useState<"" | "open" | "closed">("");
  const [severity, setSeverity] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [withText, setWithText] = useState(false);

  const summaryParams = useMemo<HttpToolParams<"eiris_incidents">>(() => ({ view: "summary" }), []);
  const listParams = useMemo<HttpToolParams<"eiris_incidents">>(
    () => ({ view: "list", limit: 100, ...(status ? { status } : {}), ...(severity ? { severity } : {}) }),
    [status, severity],
  );
  const detailParams = useMemo<HttpToolParams<"eiris_incident_detail"> | null>(
    () => (selectedId && INCIDENT_ID_RE.test(selectedId) ? { incident_id: selectedId, ...(withText ? { include_text: true } : {}) } : null),
    [selectedId, withText],
  );
  const summary = useHttpTool("eiris_incidents", summaryParams);
  const list = useHttpTool("eiris_incidents", listParams);
  const detail = useHttpTool("eiris_incident_detail", detailParams);

  // Ids and filters only. `include_text` is deliberately not reported to the panel.
  useScreenContext(
    "incidents",
    selectedId ? { incident_id: selectedId } : {},
    { register: "e-IRIS", status: status || "all", severity: severity || "all" },
    [
      { tool: "eiris_incidents", params: summaryParams, state: summary },
      { tool: "eiris_incidents", params: listParams, state: list },
      ...(detailParams ? [{ tool: "eiris_incident_detail", params: { incident_id: detailParams.incident_id }, state: detail }] : []),
    ],
  );

  return (
    <ScreenFrame title="e-IRIS incidents">
      <p className="scr-muted">The e-IRIS safety incident register. Patient feedback about physicians is a different table: see Patient feedback.</p>

      <ToolSection title="Counts by severity" note="From the newest incidents the register returns; the totals rows are the register's own all-time counts." state={summary} retry={summary.retry}>
        {(data) => {
          const totals = data.rows.filter((r) => r.scope === "totals");
          return (
            <>
              <div className="scr-tiles">
                {totals.map((r) => (
                  <StatTile key={String(r.key)} label={TOTAL_LABELS[String(r.key)] ?? String(r.key)} value={typeof r.total === "number" ? r.total : null} data={data} />
                ))}
              </div>
              <DataTable data={data} labels={{ key: "severity / metric" }} empty="No incidents." />
            </>
          );
        }}
      </ToolSection>

      <form className="scr-filters scr-form" onSubmit={(e) => e.preventDefault()} aria-label="Incident filters">
        <label>
          Status
          <select value={status} onChange={(e) => { setStatus(e.target.value as "" | "open" | "closed"); setSelectedId(null); }}>
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
          </select>
        </label>
        <label>
          Severity
          <select value={severity} onChange={(e) => { setSeverity(e.target.value); setSelectedId(null); }}>
            {SEVERITY_FILTERS.map((s) => (
              <option key={s} value={s}>{s || "All"}</option>
            ))}
          </select>
        </label>
      </form>

      <ToolSection title="Incident register" state={list} retry={list.retry}>
        {(data) => (
          <DataTable
            data={data}
            columns={["id", "reported_at", "severity", "state", "type", "department", "has_rca", "sla_state", "due_at"]}
            labels={{ id: "incident", has_rca: "RCA", sla_state: "SLA" }}
            renderCell={{
              id: (v) => (
                <button type="button" aria-pressed={v === selectedId} onClick={() => { setSelectedId(String(v)); setWithText(false); }}>
                  {String(v)}
                </button>
              ),
            }}
            empty="No incidents match."
          />
        )}
      </ToolSection>

      {selectedId && (
        <ToolSection title={`Incident ${selectedId}`} note="Classification, dates, SLA and RCA / CAPA structure. No patient or reporter identity." state={detail} retry={detail.retry}>
          {(data) => <DataTable data={data} columns={["section", "field", "value"]} empty="No detail." />}
        </ToolSection>
      )}
      {selectedId && (
        <p className="scr-muted">
          {withText ? "Free text shown (super_admin only). It is not sent to the side panel." : "Free text (narrative, root cause, CAPA actions) is hidden."}{" "}
          <button type="button" onClick={() => setWithText((v) => !v)}>
            {withText ? "Hide free text" : "Show free text"}
          </button>
        </p>
      )}
      {selectedId && detail.status === "error" && DETAIL_ERRORS[detail.code] && (
        <p className="scr-error" role="alert">
          {DETAIL_ERRORS[detail.code] ?? describeScreenError(detail.code)}
        </p>
      )}
    </ScreenFrame>
  );
}
