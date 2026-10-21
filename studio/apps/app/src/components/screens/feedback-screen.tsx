"use client";

import { useMemo, useState } from "react";
import { FEEDBACK_SEVERITIES, FEEDBACK_SOURCES, FEEDBACK_STATUSES, type FeedbackListParams, type FeedbackPayload } from "@/lib/screens/feedback-schema";
import { postFeedbackRetract, useFeedback, type FeedbackState } from "@/lib/screens/use-feedback";
import { describeScreenError, type ScreenToolState } from "@/lib/screens/use-screen-tool";
import { BASE_PATH, DataTable, StatTile } from "./parts";
import { ScreenFrame } from "./screen-frame";
import { useScreenContext } from "./screen-context";

// Patient feedback: the governance `incidents` table (feedback about a physician from patients, peers, governance
// and external reporters). It is NOT the e-IRIS incident register: that is the "e-IRIS incidents" screen.
// Narrative text, submitter identity and retraction reasons are never loaded here.

type Row = FeedbackPayload["items"]["rows"][number];
const str = (v: unknown) => (v === null || v === undefined ? "–" : String(v));
const sumWhere = (data: FeedbackPayload["counts"], pick: (r: FeedbackPayload["counts"]["rows"][number]) => boolean) =>
  data.rows.filter(pick).reduce((n, r) => n + (typeof r.feedback === "number" ? r.feedback : 0), 0);

const WRITE_ERRORS: Record<string, string> = {
  second_factor_required: "This action needs the second factor, which is not available yet.",
  forbidden: "Only a super_admin can retract feedback.",
  not_found: "That feedback no longer exists.",
  already_retracted: "That feedback is already retracted.",
  reason_required: "A retraction reason is required.",
  unauthorized: "Your session is no longer valid. Sign in again.",
  bad_params: "The request was not accepted.",
};

const asScreenState = (s: FeedbackState): ScreenToolState => (s.status === "ok" ? { status: "ok", data: s.data.items } : s.status === "error" ? s : { status: "loading" });

export function FeedbackScreen() {
  const [status, setStatus] = useState<string>("");
  const [severity, setSeverity] = useState<string>("");
  const [source, setSource] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const params = useMemo<FeedbackListParams>(
    () => ({
      limit: 100,
      ...(status ? { status: status as (typeof FEEDBACK_STATUSES)[number] } : {}),
      ...(severity ? { severity: severity as (typeof FEEDBACK_SEVERITIES)[number] } : {}),
      ...(source ? { source: source as (typeof FEEDBACK_SOURCES)[number] } : {}),
    }),
    [status, severity, source],
  );
  const feedback = useFeedback(params);

  useScreenContext("feedback", selectedId ? { feedback_id: selectedId } : {}, { table: "patient feedback", ...params }, [
    { tool: "patient_feedback", params, state: asScreenState(feedback) },
  ]);

  const select = (setter: (v: string) => void) => (e: React.ChangeEvent<HTMLSelectElement>) => {
    setter(e.target.value);
    setSelectedId(null);
  };

  return (
    <ScreenFrame title="Patient feedback">
      <p className="scr-muted">Feedback about physicians (patient, peer, governance, external). This is not the e-IRIS incident register: see e-IRIS incidents.</p>
      <form className="scr-filters scr-form" onSubmit={(e) => e.preventDefault()} aria-label="Feedback filters">
        <label>
          Status
          <select value={status} onChange={select(setStatus)}>
            <option value="">All</option>
            {FEEDBACK_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label>
          Severity
          <select value={severity} onChange={select(setSeverity)}>
            <option value="">All</option>
            {FEEDBACK_SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label>
          Source
          <select value={source} onChange={select(setSource)}>
            <option value="">All</option>
            {FEEDBACK_SOURCES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
          </select>
        </label>
      </form>

      {feedback.status === "loading" && <p className="scr-muted" role="status">Loading…</p>}
      {feedback.status === "error" && (
        <div className="scr-error" role="alert">
          <p>{describeScreenError(feedback.code)}</p>
          <button type="button" onClick={feedback.retry}>Retry</button>
        </div>
      )}
      {feedback.status === "ok" && <Loaded data={feedback.data} selectedId={selectedId} onSelect={setSelectedId} onChanged={feedback.retry} />}
    </ScreenFrame>
  );
}

function Loaded({ data, selectedId, onSelect, onChanged }: { data: FeedbackPayload; selectedId: string | null; onSelect: (id: string | null) => void; onChanged: () => void }) {
  const selected = data.items.rows.find((r) => r.feedback_id === selectedId) ?? null;
  return (
    <>
      <section className="scr-card" aria-label="Feedback counts">
        <header className="scr-card-head">
          <h2>Counts</h2>
          <p>Across all feedback you can see, whatever the filters above.</p>
        </header>
        <div className="scr-tiles">
          <StatTile label="Open" value={sumWhere(data.counts, (r) => r.status === "open")} data={data.counts} />
          <StatTile label="Closed" value={sumWhere(data.counts, (r) => r.status === "closed")} data={data.counts} />
          <StatTile label="Retracted" value={sumWhere(data.counts, (r) => r.status === "retracted")} data={data.counts} />
          <StatTile label="High or critical" value={sumWhere(data.counts, (r) => r.severity === "high" || r.severity === "critical")} data={data.counts} />
        </div>
        <DataTable data={data.counts} empty="No feedback." />
      </section>

      <section className="scr-card" aria-label="Feedback list">
        <header className="scr-card-head">
          <h2>Feedback</h2>
          <p>Reply status: a reply is the target physician's right of reply from the doctor portal.</p>
        </header>
        <DataTable
          data={data.items}
          columns={["submitted_at", "physician_name", "hospital_code", "source", "category", "severity", "polarity", "status", "reply_state", "last_reply_at", "submitter_label", "narrative_preview", "retraction_reason"]}
          labels={{ submitted_at: "submitted", physician_name: "physician", reply_state: "replies", last_reply_at: "last reply" }}
          renderCell={{
            submitted_at: (v, row) => (
              <button type="button" aria-pressed={row.feedback_id === selectedId} onClick={() => onSelect(String(row.feedback_id))}>
                {str(v).slice(0, 10)}
              </button>
            ),
          }}
          empty="No feedback matches."
        />
      </section>

      {selected && <Detail row={selected} writeEnabled={data.write_enabled} onChanged={onChanged} />}
    </>
  );
}

function Detail({ row, writeEnabled, onChanged }: { row: Row; writeEnabled: boolean; onChanged: () => void }) {
  const fields: Array<[string, unknown]> = [
    ["Physician", row.physician_name],
    ["Submitted", row.submitted_at],
    ["Hospital", row.hospital_code],
    ["Source", row.source],
    ["Category", row.category],
    ["Severity", row.severity],
    ["Polarity", row.polarity],
    ["Commendation", row.commendation_category],
    ["Patient rating", row.patient_rating],
    ["Status", row.status],
    ["Retracted at", row.retracted_at],
    ["Replies", `${str(row.reply_count)} (${str(row.reply_state)})`],
    ["Last reply", row.last_reply_at],
  ];
  const id = String(row.feedback_id);
  const retracted = row.status === "retracted";
  return (
    <section className="scr-card" aria-label="Feedback detail">
      <header className="scr-card-head">
        <h2>Feedback detail</h2>
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
      <p className="scr-source">Source: patient_feedback · row of the feedback table above. The narrative is on the even-elo page only.</p>
      <RetractCard key={id} id={id} enabled={writeEnabled && !retracted} disabledNote={retracted ? "Already retracted." : undefined} onDone={onChanged} />
    </section>
  );
}

/** Two steps, never automatic: Review shows the effect and asks for the reason, Confirm sends it. Disabled while there is no second factor. */
function RetractCard({ id, enabled, disabledNote, onDone }: { id: string; enabled: boolean; disabledNote?: string; onDone: () => void }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<string | null>(null);
  return (
    <div className="scr-card" role="group" aria-label="Retract feedback">
      <h3 className="scr-sub">Retract this feedback</h3>
      <p className="scr-muted">Marks the feedback as retracted with your reason. The record and its audit trail are kept; nothing is deleted.</p>
      {!enabled && <p className="scr-muted" data-testid="second-factor-note">{disabledNote ?? "Needs second factor. This action is disabled until it is available."}</p>}
      {result && <p className="scr-error" role="alert">{result}</p>}
      {!armed ? (
        <button type="button" disabled={!enabled} onClick={() => setArmed(true)}>Review</button>
      ) : (
        <>
          <label>
            Reason
            <textarea value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button
            type="button"
            disabled={!enabled || busy || !reason.trim()}
            onClick={async () => {
              setBusy(true);
              const err = await postFeedbackRetract({ feedback_id: id, retraction_reason: reason.trim() });
              setBusy(false);
              if (err) setResult(WRITE_ERRORS[err] ?? "The change failed. Nothing was saved.");
              else {
                setArmed(false);
                setReason("");
                setResult(null);
                onDone();
              }
            }}
          >
            Confirm
          </button>
          <button type="button" disabled={busy} onClick={() => setArmed(false)}>Cancel</button>
        </>
      )}
    </div>
  );
}
