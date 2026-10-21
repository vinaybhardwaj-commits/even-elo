"use client";

import Link from "next/link";
import { useMemo } from "react";
import { isUuid } from "@/lib/screens/tool-schema";
import { useScreenTool } from "@/lib/screens/use-screen-tool";
import { BASE_PATH, DataTable, SourceLine, ToolSection } from "./parts";
import { ScreenFrame } from "./screen-frame";
import { useScreenContext } from "./screen-context";

const FIELDS: Array<[string, string]> = [
  ["hospital_code", "Hospital"],
  ["doc_type", "Document type"],
  ["doc_day", "Note date"],
  ["ingested_on", "Ingested"],
  ["routed_on", "Routed to doctor"],
  ["external_ref", "Reference"],
];

const cell = (v: unknown) => (v === null || v === undefined ? "–" : String(v));
const yes = (v: unknown) => (v === true ? "yes" : v === false ? "no" : "–");

export function DocumentAuditScreen({ id }: { id: string }) {
  const valid = isUuid(id);
  const params = useMemo(() => (valid ? { audit_id: id } : null), [valid, id]);
  const detail = useScreenTool("document_audit_detail", params);

  useScreenContext("document_audit", { audit_id: valid ? id : "(invalid id)" }, {}, [{ tool: "document_audit_detail", params, state: detail }]);

  const head = detail.status === "ok" ? detail.data.rows[0] : undefined;
  const title = head ? `${cell(head.full_name)} · ${cell(head.doc_type)} audit` : "Document audit";

  return (
    <ScreenFrame title={title}>
      <p>
        <Link href="/document-audits">← All document audits</Link>
      </p>
      {!valid && (
        <p className="scr-error" role="alert">
          This document audit id is not valid.
        </p>
      )}
      {valid && (
        <ToolSection
          title="Audit and findings"
          note="Read-only. Finding text, evidence, doctor comments and the PDF link are shown as on the document-audits page; authoring and release to the portal stay in the RMO inbox."
          state={detail}
          retry={detail.retry}
        >
          {(data) => {
            const r = data.rows[0];
            if (!r) return <p className="scr-muted">No document audit with this id.</p>;
            const findings = data.rows.filter((row) => row.finding_id);
            return (
              <>
                <dl className="scr-dl">
                  <div>
                    <dt>Doctor</dt>
                    <dd>{r.physician_id ? <a href={`${BASE_PATH}/physicians/${String(r.physician_id)}`}>{cell(r.full_name)}</a> : cell(r.full_name)}</dd>
                  </div>
                  <div>
                    <dt>Specialty</dt>
                    <dd>{cell(r.primary_specialty)}</dd>
                  </div>
                  {FIELDS.map(([key, label]) => (
                    <div key={key}>
                      <dt>{label}</dt>
                      <dd>{cell(r[key])}</dd>
                    </div>
                  ))}
                  <div>
                    <dt>PDF on file</dt>
                    <dd>
                      {typeof r.pdf_url === "string" && /^https?:\/\//i.test(r.pdf_url) ? (
                        <a href={r.pdf_url} target="_blank" rel="noopener noreferrer">
                          Open PDF
                        </a>
                      ) : (
                        yes(r.has_pdf)
                      )}
                    </dd>
                  </div>
                </dl>
                <SourceLine data={data} />
                <h3 className="scr-sub">Findings ({findings.length})</h3>
                {findings.length === 0 ? (
                  <p className="scr-muted">No findings recorded for this audit.</p>
                ) : (
                  <DataTable
                    data={{ ...data, rows: findings, row_count: findings.length }}
                    columns={["finding_label", "finding_body", "evidence_excerpt", "severity", "status", "authored_by_name", "author_confirmed", "authored_on", "recurrence_count", "portal_visible", "response_owner", "response_verb", "response_comment", "responded_on", "sync_state"]}
                    labels={{ finding_label: "finding", finding_body: "finding text", evidence_excerpt: "evidence", authored_by_name: "author", response_comment: "doctor comment", author_confirmed: "RMO confirmed", authored_on: "authored", recurrence_count: "recurrence", portal_visible: "released to portal", response_owner: "response owner", response_verb: "doctor response", responded_on: "responded", sync_state: "CDMSS sync" }}
                    renderCell={{ author_confirmed: (v) => yes(v), portal_visible: (v) => yes(v) }}
                  />
                )}
              </>
            );
          }}
        </ToolSection>
      )}
    </ScreenFrame>
  );
}
