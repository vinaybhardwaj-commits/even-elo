"use client";

import { useMemo, useState } from "react";
import { useScreenTool } from "@/lib/screens/use-screen-tool";
import { AUDIT_STATUSES, AUDIT_VIEWS, type AnyScreenToolParams } from "@/lib/screens/tool-schema";
import { BASE_PATH, DataTable, ToolSection } from "./parts";
import { ScreenFrame } from "./screen-frame";
import { useScreenContext } from "./screen-context";

type Filters = { view: (typeof AUDIT_VIEWS)[number]; status: "" | (typeof AUDIT_STATUSES)[number]; doctor: string; hospital: string };
const EMPTY: Filters = { view: "attention", status: "", doctor: "", hospital: "" };

const VIEW_LABEL: Record<Filters["view"], string> = {
  attention: "Needs attention",
  overdue: "Overdue",
  disagreed: "Doctor disagreed",
  awaiting_ruling: "Awaiting ruling",
  awaiting_doctor: "Awaiting doctor",
  all: "All threads",
};

export function toParams(f: Filters): AnyScreenToolParams<"audit_findings"> {
  const p: AnyScreenToolParams<"audit_findings"> = { view: f.view, limit: 200 };
  if (f.status) p.status = f.status;
  if (f.doctor) p.doctor_uid = f.doctor;
  if (/^[A-Z]{2,6}$/.test(f.hospital.trim().toUpperCase())) p.hospital = f.hospital.trim().toUpperCase();
  return p;
}

export function AuditFindingsScreen() {
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const params = useMemo(() => toParams(applied), [applied]);
  const list = useScreenTool("audit_findings", params);
  // Doctor choices come from the per-doctor signal counts (opd_signals), not from the filtered list.
  const doctorParams = useMemo(() => ({ limit: 200 }), []);
  const doctors = useScreenTool("opd_signals", doctorParams);

  useScreenContext("audit_findings", {}, params, [
    { tool: "audit_findings", params, state: list },
    { tool: "opd_signals", params: doctorParams, state: doctors },
  ]);

  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }) as Filters);
  const doctorOptions = doctors.status === "ok" ? doctors.data.rows : [];

  return (
    <ScreenFrame title="Audit findings">
      <p className="scr-muted">
        CDMSS makes the audits; governance views and rules here. Comments and ruling notes are on the thread page only.
      </p>
      <form
        className="scr-filters scr-form"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(draft);
        }}
      >
        <label>
          View
          <select value={draft.view} onChange={set("view")}>
            {AUDIT_VIEWS.map((v) => (
              <option key={v} value={v}>
                {VIEW_LABEL[v]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select value={draft.status} onChange={set("status")}>
            <option value="">Any</option>
            {AUDIT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Doctor
          <select value={draft.doctor} onChange={set("doctor")}>
            <option value="">All doctors</option>
            {doctorOptions.map((r) => (
              <option key={String(r.doctor_uid)} value={String(r.doctor_uid)}>
                {String(r.doctor ?? r.doctor_uid)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Hospital code
          <input value={draft.hospital} onChange={set("hospital")} maxLength={6} placeholder="e.g. EHRC" />
        </label>
        <button type="submit">Apply</button>
        <button
          type="button"
          onClick={() => {
            setDraft(EMPTY);
            setApplied(EMPTY);
          }}
        >
          Clear
        </button>
      </form>

      <ToolSection title="Threads" note="Hospital is the prefix of the thread reference." state={list} retry={list.retry}>
        {(data) => (
          <DataTable
            data={data}
            columns={["reference", "hospital", "doctor", "finding", "status", "importance", "doctor_response", "ruling_action", "overdue", "routed_at"]}
            labels={{ doctor_response: "doctor said", ruling_action: "ruling", routed_at: "routed" }}
            rowHref={(row) => (row.reference ? `/audit-findings/${encodeURIComponent(String(row.reference))}` : null)}
            renderCell={{
              reference: (v) => (v ? <a href={`${BASE_PATH}/audit-findings/${encodeURIComponent(String(v))}`}>{String(v)}</a> : "–"),
              overdue: (v) => (v === true ? "overdue" : "–"),
            }}
            empty="No threads match these filters."
          />
        )}
      </ToolSection>
    </ScreenFrame>
  );
}
