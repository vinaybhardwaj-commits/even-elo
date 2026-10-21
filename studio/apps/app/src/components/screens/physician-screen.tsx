"use client";

import Link from "next/link";
import { useMemo } from "react";
import { isUuid } from "@/lib/screens/tool-schema";
import { useScreenTool } from "@/lib/screens/use-screen-tool";
import { DataTable, SourceLine, StatTile, ToolSection } from "./parts";
import { ScreenFrame } from "./screen-frame";
import { useScreenContext } from "./screen-context";

const FIELDS: Array<[string, string]> = [
  ["primary_specialty", "Specialty"],
  ["current_status", "Status"],
  ["date_joined_network", "Joined network"],
  ["registration_council", "Registration council"],
  ["registration_expiry", "Registration expiry"],
];

export function PhysicianScreen({ id }: { id: string }) {
  const valid = isUuid(id);
  const profileParams = useMemo(() => (valid ? { physician_id: id } : null), [valid, id]);
  const signalParams = useMemo(() => (valid ? { physician_id: id, window_days: 90, limit: 50 } : null), [valid, id]);
  const interventionParams = useMemo(() => (valid ? { physician_id: id, limit: 50 } : null), [valid, id]);
  const listParams = useMemo(() => (valid ? { physician_id: id, limit: 50 } : null), [valid, id]);
  const metricsParams = useMemo(() => (valid ? { physician_id: id, months: 12, limit: 50 } : null), [valid, id]);
  const feedbackParams = useMemo(() => (valid ? { physician_id: id, window_days: 365, source: "patient" as const, limit: 50 } : null), [valid, id]);
  const profile = useScreenTool("physician_profile", profileParams);
  const privileges = useScreenTool("physician_privileges", listParams);
  const oppe = useScreenTool("physician_oppe", listParams);
  const metrics = useScreenTool("physician_metrics", metricsParams);
  const qualifications = useScreenTool("physician_qualifications", listParams);
  const feedback = useScreenTool("feedback_by_physician", feedbackParams);
  const signals = useScreenTool("signal_snapshots", signalParams);
  const interventions = useScreenTool("interventions", interventionParams);

  useScreenContext("physician_360", { physician_id: valid ? id : "(invalid id)" }, { signal_window_days: 90, metrics_months: 12, patient_feedback_window_days: 365 }, [
    { tool: "physician_profile", params: profileParams, state: profile },
    { tool: "physician_privileges", params: listParams, state: privileges },
    { tool: "physician_oppe", params: listParams, state: oppe },
    { tool: "physician_metrics", params: metricsParams, state: metrics },
    { tool: "physician_qualifications", params: listParams, state: qualifications },
    { tool: "feedback_by_physician", params: feedbackParams, state: feedback },
    { tool: "signal_snapshots", params: signalParams, state: signals },
    { tool: "interventions", params: interventionParams, state: interventions },
  ]);

  const row = profile.status === "ok" ? profile.data.rows[0] : undefined;
  const title = row ? String(row.full_name ?? "Physician") : "Physician 360";

  return (
    <ScreenFrame title={title}>
      <p>
        <Link href="/physicians">← All physicians</Link>
      </p>
      {!valid && (
        <p className="scr-error" role="alert">
          This physician id is not valid.
        </p>
      )}
      {valid && (
        <>
          <ToolSection title="Profile" note="No contact details or registration number are read." state={profile} retry={profile.retry}>
            {(data) => {
              const r = data.rows[0];
              if (!r) return <p className="scr-muted">No physician with this id.</p>;
              const engagements = String(r.engagements ?? "")
                .split(" | ")
                .filter(Boolean);
              return (
                <>
                  <dl className="scr-dl">
                    {r.preferred_name ? (
                      <>
                        <dt>Preferred name</dt>
                        <dd>{String(r.preferred_name)}</dd>
                      </>
                    ) : null}
                    {FIELDS.map(([key, label]) => (
                      <div key={key}>
                        <dt>{label}</dt>
                        <dd>{r[key] === null || r[key] === undefined ? "–" : String(r[key])}</dd>
                      </div>
                    ))}
                  </dl>
                  <SourceLine data={data} />
                  <h3 className="scr-sub">Engagements</h3>
                  {engagements.length === 0 ? (
                    <p className="scr-muted">No engagements recorded.</p>
                  ) : (
                    <ul className="scr-list">
                      {engagements.map((e) => {
                        // "hospital · category · status": show category and status separately, never one as the other.
                        const [hospital, category, status] = e.split(" · ");
                        if (!hospital || !category || !status) return <li key={e}>{e}</li>;
                        return (
                          <li key={e}>
                            {hospital} · category: {category} · status: {status}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <p className="scr-source">Engagements from {data.source.tool} · query {data.source.query_hash} (hospital code, category, status).</p>
                </>
              );
            }}
          </ToolSection>

          <div className="scr-tiles">
            {signals.status === "ok" && <StatTile label="Signals naming this physician (90 days)" value={signals.data.row_count} data={signals.data} />}
            {interventions.status === "ok" && <StatTile label="Interventions logged" value={interventions.data.row_count} data={interventions.data} />}
          </div>

          <ToolSection
            title="Signals"
            note="Governance signals that list this physician as affected, last 90 days."
            state={signals}
            retry={signals.retry}
          >
            {(data) => (
              <DataTable
                data={data}
                columns={["day", "signal", "severity", "trend", "scope", "n", "physician_n", "physician_value"]}
                labels={{ n: "cohort n", physician_n: "physician n", physician_value: "physician value" }}
                empty="No signals name this physician in the last 90 days."
              />
            )}
          </ToolSection>

          <ToolSection title="Interventions" note="Recorded interventions; no free-text notes." state={interventions} retry={interventions.retry}>
            {(data) => (
              <DataTable
                data={data}
                columns={["done_on", "signal_label", "kind", "action", "cdmss_sync_state"]}
                labels={{ done_on: "date", signal_label: "signal", cdmss_sync_state: "sync" }}
                empty="No interventions recorded for this physician."
              />
            )}
          </ToolSection>

          <ToolSection
            title="Privileges"
            note="Clinical privileges by hospital; no withdrawal reasons."
            state={privileges}
            retry={privileges.retry}
          >
            {(data) => (
              <DataTable
                data={data}
                columns={["hospital_code", "procedure_or_specialty", "is_core", "basis", "granted_date", "expires_at", "withdrawn_date"]}
                labels={{ hospital_code: "hospital", procedure_or_specialty: "procedure or specialty", is_core: "core", granted_date: "granted", expires_at: "expires", withdrawn_date: "withdrawn" }}
                renderCell={{ is_core: (v) => (v === true ? "Core" : v === false ? "Special" : "–") }}
                empty="No privileges recorded for this physician."
              />
            )}
          </ToolSection>

          <ToolSection title="OPPE reviews" note="Review periods, due dates and status; no reviewer notes or packets." state={oppe} retry={oppe.retry}>
            {(data) => (
              <DataTable
                data={data}
                columns={["hospital_code", "period_start", "period_end", "due_on", "status", "completed_on"]}
                labels={{ hospital_code: "hospital", period_start: "period start", period_end: "period end", due_on: "due", completed_on: "completed" }}
                empty="No OPPE reviews recorded for this physician."
              />
            )}
          </ToolSection>

          <ToolSection title="Monthly volumes" note="OPD, IPD and OT counts and revenue by hospital, last 12 months." state={metrics} retry={metrics.retry}>
            {(data) => (
              <DataTable
                data={data}
                columns={["hospital_code", "year", "month", "opd_count", "ipd_admissions", "ot_cases", "revenue_inr"]}
                labels={{ hospital_code: "hospital", opd_count: "OPD", ipd_admissions: "IPD admissions", ot_cases: "OT cases", revenue_inr: "revenue (INR)" }}
                empty="No monthly volumes in the last 12 months."
              />
            )}
          </ToolSection>

          <ToolSection
            title="Qualifications"
            note="Degree, institution tier, year and verification; no institution names or certificates."
            state={qualifications}
            retry={qualifications.retry}
          >
            {(data) => (
              <DataTable
                data={data}
                columns={["degree", "institution_tier", "year_completed", "country", "verified", "verified_on"]}
                labels={{ institution_tier: "tier", year_completed: "year", verified_on: "verified on" }}
                renderCell={{ verified: (v) => (v === true ? "Yes" : v === false ? "No" : "–") }}
                empty="No qualifications recorded for this physician."
              />
            )}
          </ToolSection>

          <ToolSection
            title="Patient feedback"
            note="Counts for this physician since the start of the month 12 months ago, by polarity, severity and status. No comments, reporters or patient references."
            state={feedback}
            retry={feedback.retry}
          >
            {(data) => (
              <DataTable
                data={data}
                columns={["polarity", "severity", "status", "incidents"]}
                labels={{ incidents: "count" }}
                empty="No patient feedback recorded for this physician since the start of the month 12 months ago."
              />
            )}
          </ToolSection>
        </>
      )}
    </ScreenFrame>
  );
}
