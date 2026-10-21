"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useScreenTool } from "@/lib/screens/use-screen-tool";
import type { ScreenToolParams } from "@/lib/screens/tool-schema";
import { DOC_TYPES, FINDING_SEVERITIES, FINDING_STATUSES } from "@/lib/screens/docaudit-schema";
import { BASE_PATH, DataTable, SourceLine, StatTile, ToolSection } from "./parts";
import { ScreenFrame } from "./screen-frame";
import { useScreenContext } from "./screen-context";

// Labels are fixed here; every number is the tool's.
export const HEADLINE_LABELS: Record<string, string> = {
  audits_total: "Document audits",
  findings_total: "Findings",
  findings_open: "Open findings",
  critical_high_open: "Open critical / high",
  doctors_with_findings: "Doctors with findings",
  findings_responded: "Findings with a doctor response",
  days_since_last_ingest: "Days since last ingest",
};

export type Filters = { hospital: string; name: string; docType: string; severity: string; status: string; physicianId: string };
export const EMPTY: Filters = { hospital: "", name: "", docType: "", severity: "", status: "", physicianId: "" };
const PAGE = 100;

type ListParams = ScreenToolParams<"list_document_audits">;

export function toListParams(f: Filters, offset = 0): ListParams {
  const filter: NonNullable<ListParams["filter"]> = {};
  if (f.hospital.trim()) filter.hospital_code = f.hospital.trim().slice(0, 40);
  if (f.name.trim()) filter.doctor_name_contains = f.name.trim().slice(0, 80);
  if (f.physicianId) filter.physician_id = f.physicianId;
  if ((DOC_TYPES as readonly string[]).includes(f.docType)) filter.doc_type = f.docType as (typeof DOC_TYPES)[number];
  if ((FINDING_SEVERITIES as readonly string[]).includes(f.severity)) filter.severity = f.severity as (typeof FINDING_SEVERITIES)[number];
  if ((FINDING_STATUSES as readonly string[]).includes(f.status)) filter.status = f.status as (typeof FINDING_STATUSES)[number];
  return { filter, limit: PAGE, offset };
}

const cell = (v: unknown) => (v === null || v === undefined ? "–" : String(v));
const yes = (v: unknown) => (v === true ? "yes" : v === false ? "no" : "–");

export function DocumentAuditsScreen() {
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [offset, setOffset] = useState(0);
  const hospital = applied.hospital.trim().slice(0, 40);

  const headlineParams = useMemo(() => (hospital ? { hospital_code: hospital } : {}), [hospital]);
  const rollupParams = useMemo(() => ({ ...(hospital ? { hospital_code: hospital } : {}), window_days: 90, limit: 25 }), [hospital]);
  const listParams = useMemo(() => toListParams(applied, offset), [applied, offset]);
  const headline = useScreenTool("document_audit_headline", headlineParams);
  const rollup = useScreenTool("document_audit_doctor_rollup", rollupParams);
  const list = useScreenTool("list_document_audits", listParams);

  useScreenContext("document_audits", applied.physicianId ? { physician_id: applied.physicianId } : {}, listParams.filter ?? {}, [
    { tool: "document_audit_headline", params: headlineParams, state: headline },
    { tool: "document_audit_doctor_rollup", params: rollupParams, state: rollup },
    { tool: "list_document_audits", params: listParams, state: list },
  ]);

  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  const apply = (next: Filters) => {
    setDraft(next);
    setApplied(next);
    setOffset(0);
  };

  return (
    <ScreenFrame title="Document audits">
      <form
        className="scr-filters scr-form"
        onSubmit={(e) => {
          e.preventDefault();
          apply(draft);
        }}
      >
        <label>
          Hospital code
          <input value={draft.hospital} onChange={set("hospital")} maxLength={40} />
        </label>
        <label>
          Doctor name
          <input value={draft.name} onChange={set("name")} maxLength={80} />
        </label>
        <label>
          Document type
          <select value={draft.docType} onChange={set("docType")}>
            <option value="">Any</option>
            {DOC_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          Finding severity
          <select value={draft.severity} onChange={set("severity")}>
            <option value="">Any</option>
            {FINDING_SEVERITIES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          Finding status
          <select value={draft.status} onChange={set("status")}>
            <option value="">Any</option>
            {FINDING_STATUSES.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Apply</button>
        <button type="button" onClick={() => apply(EMPTY)}>
          Clear
        </button>
      </form>

      <ToolSection title="Headline" note="Counts across all document audits for the chosen hospital." state={headline} retry={headline.retry}>
        {(data) => (
          <>
            <div className="scr-tiles">
              {data.rows.map((row) => (
                <StatTile key={String(row.metric)} label={HEADLINE_LABELS[String(row.metric)] ?? String(row.metric).replace(/_/g, " ")} value={typeof row.value === "number" ? row.value : null} data={data} />
              ))}
            </div>
            <SourceLine data={data} />
          </>
        )}
      </ToolSection>

      <ToolSection title="Doctors by open findings" note="Audits ingested in the last 90 days, the 25 doctors with most open findings." state={rollup} retry={rollup.retry}>
        {(data) => (
          <DataTable
            data={data}
            columns={["full_name", "primary_specialty", "audits", "findings", "open_findings", "critical_high_open", "contested", "responded", "last_finding_on"]}
            labels={{ full_name: "doctor", primary_specialty: "specialty", critical_high_open: "open critical / high", last_finding_on: "latest finding" }}
            renderCell={{
              full_name: (v, row) =>
                row.physician_id ? (
                  <button type="button" className="scr-link" onClick={() => apply({ ...EMPTY, hospital: applied.hospital, physicianId: String(row.physician_id) })}>
                    {cell(v)}
                  </button>
                ) : (
                  cell(v)
                ),
            }}
            empty="No findings in this window."
          />
        )}
      </ToolSection>

      <ToolSection title="Audits" note={applied.physicianId ? "Filtered to one doctor (use Clear to remove)." : undefined} state={list} retry={list.retry}>
        {(data) => (
          <>
            <Pager offset={offset} rowCount={data.row_count} total={data.total} onPage={setOffset} />
            <DataTable
              data={data}
              columns={["ingested_on", "full_name", "hospital_code", "doc_type", "doc_day", "findings", "open_findings", "top_severity", "routed", "has_pdf", "external_ref"]}
              labels={{ ingested_on: "ingested", full_name: "doctor", hospital_code: "hospital", doc_type: "type", doc_day: "note date", top_severity: "top severity", routed: "routed to doctor", has_pdf: "PDF", external_ref: "reference" }}
              rowHref={(row) => (row.audit_id ? `/document-audits/${String(row.audit_id)}` : null)}
              renderCell={{
                ingested_on: (v, row) =>
                  row.audit_id ? <a href={`${BASE_PATH}/document-audits/${String(row.audit_id)}`}>{cell(v)}</a> : cell(v),
                routed: (v) => yes(v),
                has_pdf: (v) => yes(v),
              }}
              empty={offset > 0 ? "No audits on this page." : "No document audits match these filters."}
            />
            <Pager offset={offset} rowCount={data.row_count} total={data.total} onPage={setOffset} />
            <p className="scr-muted">
              Finding text, evidence and doctor comments are not read here. <Link href="/physicians">Physicians</Link> links to each doctor&apos;s 360.
            </p>
          </>
        )}
      </ToolSection>
    </ScreenFrame>
  );
}

function Pager({ offset, rowCount, total, onPage }: { offset: number; rowCount: number; total?: number; onPage: (offset: number) => void }) {
  const hasPrev = offset > 0;
  const hasNext = total !== undefined ? offset + rowCount < total : rowCount >= PAGE;
  if (!hasPrev && !hasNext && total === undefined) return null;
  const first = rowCount === 0 ? 0 : offset + 1;
  return (
    <nav className="scr-pager" aria-label="Audit pages">
      <span className="scr-muted" data-testid="audit-range">
        {total !== undefined ? `Showing ${first}–${offset + rowCount} of ${total}` : `Showing ${first}–${offset + rowCount}`}
      </span>
      <button type="button" disabled={!hasPrev} onClick={() => onPage(Math.max(0, offset - PAGE))}>
        Previous
      </button>
      <button type="button" disabled={!hasNext} onClick={() => onPage(offset + PAGE)}>
        Next
      </button>
    </nav>
  );
}
