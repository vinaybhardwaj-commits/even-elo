"use client";

import { useMemo, useState } from "react";
import type { RmoInboxPayload } from "@/lib/screens/rmo-schema";
import { PIPES, type RmoInboxParams } from "@/lib/screens/rmo-schema";
import { asScreenState, postRmoWrite, useRmoInbox } from "@/lib/screens/use-rmo-inbox";
import { describeScreenError } from "@/lib/screens/use-screen-tool";
import { BASE_PATH, DataTable, StatTile } from "./parts";
import { ScreenFrame } from "./screen-frame";
import { useScreenContext } from "./screen-context";

type Row = RmoInboxPayload["items"]["rows"][number];
type Pipe = (typeof PIPES)[number];
const str = (v: unknown) => (v === null || v === undefined ? "–" : String(v));

const WRITE_ERRORS: Record<string, string> = {
  second_factor_required: "This action needs the second factor, which is not available yet.",
  forbidden: "Your role cannot do this.",
  not_found: "That finding no longer exists.",
  unauthorized: "Your session is no longer valid. Sign in again.",
  bad_params: "The request was not accepted.",
};

export function RmoInboxScreen() {
  const [pipe, setPipe] = useState<Pipe>("all");
  const [draftQ, setDraftQ] = useState("");
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const params = useMemo<RmoInboxParams>(() => ({ pipe, ...(q.trim() ? { q: q.trim().slice(0, 80) } : {}) }), [pipe, q]);
  const inbox = useRmoInbox(params);

  useScreenContext("rmo-inbox", selectedId ? { finding_id: selectedId } : {}, params, [{ tool: "rmo_inbox", params, state: asScreenState(inbox) }]);

  return (
    <ScreenFrame title="RMO inbox">
      <form
        className="scr-filters scr-form"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(draftQ);
          setSelectedId(null);
        }}
      >
        <label>
          Physician or specialty
          <input value={draftQ} onChange={(e) => setDraftQ(e.target.value)} maxLength={80} />
        </label>
        <button type="submit">Apply</button>
        {PIPES.map((p) => (
          <button key={p} type="button" aria-pressed={pipe === p} onClick={() => { setPipe(p); setSelectedId(null); }}>
            {p.replace("_", " ")}
          </button>
        ))}
      </form>

      {inbox.status === "loading" && (
        <p className="scr-muted" role="status">
          Loading…
        </p>
      )}
      {inbox.status === "error" && (
        <div className="scr-error" role="alert">
          <p>{describeScreenError(inbox.code)}</p>
          <button type="button" onClick={inbox.retry}>
            Retry
          </button>
        </div>
      )}
      {inbox.status === "ok" && <Loaded data={inbox.data} selectedId={selectedId} onSelect={setSelectedId} onChanged={inbox.retry} />}
    </ScreenFrame>
  );
}

function Loaded({ data, selectedId, onSelect, onChanged }: { data: RmoInboxPayload; selectedId: string | null; onSelect: (id: string | null) => void; onChanged: () => void }) {
  const selected = data.items.rows.find((r) => r.finding_id === selectedId) ?? null;
  const metric = (name: string) => {
    const hit = data.counts.rows.find((r) => r.metric === name);
    return typeof hit?.value === "number" ? hit.value : null;
  };
  return (
    <>
      <section className="scr-card" aria-label="Pipe counts">
        <header className="scr-card-head">
          <h2>Pipe</h2>
        </header>
        <div className="scr-tiles">
          <StatTile label="Open" value={metric("pipe_open")} data={data.counts} />
          <StatTile label="In progress" value={metric("pipe_in_progress")} data={data.counts} />
          <StatTile label="Escalated" value={metric("pipe_escalated")} data={data.counts} />
          <StatTile label="SLA risk" value={metric("sla_risk")} data={data.counts} />
        </div>
      </section>

      <section className="scr-card" aria-label="Findings">
        <header className="scr-card-head">
          <h2>Findings</h2>
          <p>Remediator is the target physician through the portal; the RMO authors and releases.</p>
        </header>
        <DataTable
          data={data.items}
          columns={["finding_label", "severity", "status", "physician_name", "hospital_code", "doc_type_label", "authored_by_name", "open_age_days"]}
          labels={{ finding_label: "finding", doc_type_label: "document", authored_by_name: "author", open_age_days: "age (days)" }}
          renderCell={{
            finding_label: (v, row) => (
              <button type="button" aria-pressed={row.finding_id === selectedId} onClick={() => onSelect(String(row.finding_id))}>
                {str(v)}
              </button>
            ),
          }}
          empty="No findings match."
        />
      </section>

      {selected && <Detail row={selected} writeEnabled={data.write_enabled} onChanged={onChanged} />}

      <section className="scr-card" aria-label="SGC exceptions">
        <header className="scr-card-head">
          <h2>SGC exception queue</h2>
          <p>Open findings ranked by severity, recurrence and age.</p>
        </header>
        <DataTable
          data={data.exceptions}
          columns={["finding_label", "severity", "physician_name", "hospital_code", "open_age_days", "recurrence_count", "exception_score"]}
          labels={{ finding_label: "finding", open_age_days: "age (days)", recurrence_count: "recurrence", exception_score: "score" }}
          empty="No exceptions."
        />
      </section>
    </>
  );
}

function Detail({ row, writeEnabled, onChanged }: { row: Row; writeEnabled: boolean; onChanged: () => void }) {
  const fields: Array<[string, unknown]> = [
    ["Finding", row.finding_label],
    ["Severity", row.severity],
    ["Pipe status", row.status],
    ["Physician", row.physician_name],
    ["Specialty", row.specialty],
    ["Hospital", row.hospital_code],
    ["Document", row.doc_type_label],
    ["Audit ref", row.external_ref],
    ["Authored by", row.author_pending ? "Pending RMO confirmation" : row.authored_by_name],
    ["Authored at", row.authored_at],
    ["Open age (days)", row.open_age_days],
    ["Recurrence", row.recurrence_count],
    ["On portal", row.portal_visible ? "Yes" : "No"],
    ["Signal", row.signal_reference],
  ];
  const id = String(row.finding_id);
  return (
    <section className="scr-card" aria-label="Finding detail">
      <header className="scr-card-head">
        <h2>Finding detail</h2>
        {row.physician_id && <p><a href={`${BASE_PATH}/physicians/${String(row.physician_id)}`}>Open physician</a></p>}
      </header>
      <dl className="scr-dl">
        {fields.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{str(v)}</dd>
          </div>
        ))}
      </dl>
      <p className="scr-source">Source: rmo_inbox · row of the findings table above</p>
      <ConfirmCard
        key={`author-${id}`}
        title="Confirm author stamp"
        effect={`Stamps you as the author of this finding (${str(row.authored_by_name)} is replaced).`}
        enabled={writeEnabled}
        run={() => postRmoWrite("author", { finding_id: id })}
        onDone={onChanged}
      />
      <ConfirmCard
        key={`release-${id}`}
        title="Release to portal"
        effect={`Makes this finding visible to ${str(row.physician_name)} in the physician portal.`}
        enabled={writeEnabled && !row.portal_visible}
        disabledNote={row.portal_visible ? "Already on the portal." : undefined}
        run={() => postRmoWrite("release", { finding_id: id })}
        onDone={onChanged}
      />
    </section>
  );
}

/** Two steps, never automatic: Review shows the effect, Confirm sends it. Disabled while there is no second factor. */
function ConfirmCard({ title, effect, enabled, disabledNote, run, onDone }: { title: string; effect: string; enabled: boolean; disabledNote?: string; run: () => Promise<string | null>; onDone: () => void }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  return (
    <div className="scr-card" role="group" aria-label={title}>
      <h3 className="scr-sub">{title}</h3>
      <p className="scr-muted">{effect}</p>
      {!enabled && <p className="scr-muted" data-testid="second-factor-note">{disabledNote ?? "Needs second factor. This action is disabled until it is available."}</p>}
      {result && <p className="scr-error" role="alert">{result}</p>}
      {!armed ? (
        <button type="button" disabled={!enabled} onClick={() => setArmed(true)}>
          Review
        </button>
      ) : (
        <>
          <button
            type="button"
            disabled={!enabled || busy}
            onClick={async () => {
              setBusy(true);
              const err = await run();
              setBusy(false);
              if (err) setResult(WRITE_ERRORS[err] ?? "The change failed. Nothing was saved.");
              else {
                setArmed(false);
                setResult(null);
                onDone();
              }
            }}
          >
            Confirm
          </button>
          <button type="button" disabled={busy} onClick={() => setArmed(false)}>
            Cancel
          </button>
        </>
      )}
    </div>
  );
}
