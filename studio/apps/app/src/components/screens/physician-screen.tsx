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
  const profile = useScreenTool("physician_profile", profileParams);
  const signals = useScreenTool("signal_snapshots", signalParams);
  const interventions = useScreenTool("interventions", interventionParams);

  useScreenContext("physician_360", { physician_id: valid ? id : "(invalid id)" }, { signal_window_days: 90 }, [
    { tool: "physician_profile", params: profileParams, state: profile },
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
                      {engagements.map((e) => (
                        <li key={e}>{e}</li>
                      ))}
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

          <section className="scr-card" aria-label="Patient feedback">
            <header className="scr-card-head">
              <h2>Patient feedback</h2>
            </header>
            <p className="scr-muted">
              Not available per physician. The patient feedback read (incident_summary) returns programme-wide counts only, so nothing here is
              attributed to this physician.
            </p>
          </section>
        </>
      )}
    </ScreenFrame>
  );
}
