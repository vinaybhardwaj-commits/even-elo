"use client";

import { useCallback, useEffect, useState } from "react";
import { authorAttribution } from "@/lib/document-audits";
import { localCardPdfHref } from "@/lib/findings-pdf";

interface LocalFinding {
  finding_id: string;
  audit_id: string;
  external_ref: string | null;
  finding_label: string;
  finding_body: string | null;
  severity: string;
  status: string;
  authored_by_name: string;
  authored_at: string;
  doc_type_label: string;
  pdf_url: string | null;
  pdf_status: "available" | "unavailable";
  response_owner: "pipe_a" | "local";
  signal_reference: string | null;
  doctor_response_verb: string | null;
  doctor_response_comment: string | null;
  doctor_responded_at: string | null;
}

/**
 * Stage 4 — local TriageBot-routed document-audit findings on the doctor portal.
 * Complements CDMSS FindingsForDoctor. Remediator = this physician; RMO author named.
 */
export function LocalDocumentAuditsForDoctor() {
  const [findings, setFindings] = useState<LocalFinding[] | null>(null);
  const [advisory, setAdvisory] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(() => {
    fetch("/api/portal/document-audits")
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) {
          setFindings(j.findings ?? []);
          setAdvisory(j.advisory ?? "");
        } else {
          setFindings([]);
        }
      })
      .catch(() => setFindings([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function respond(findingId: string, verb: "agree" | "disagree" | "needs_clarification") {
    setBusyId(findingId);
    setErr("");
    try {
      const r = await fetch("/api/portal/document-audits/respond", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ finding_id: findingId, verb }),
      });
      const j = await r.json();
      if (!j.ok) {
        setErr(j.error || "Could not save response");
      } else {
        load();
      }
    } catch {
      setErr("Could not save response");
    } finally {
      setBusyId(null);
    }
  }

  if (findings === null) return null;
  if (findings.length === 0) return null;

  return (
    <section className="bg-white border border-stone-200 rounded-xl">
      <div className="px-5 py-3.5 border-b border-stone-100">
        <h2 className="text-sm font-semibold">
          Document audit findings{" "}
          <span className="text-[11px] bg-stone-100 text-stone-600 rounded-full px-2 py-0.5 font-medium ml-1">
            {findings.length}
          </span>
        </h2>
        {advisory ? <p className="mt-1 text-[12.5px] text-stone-500 leading-snug">{advisory}</p> : null}
      </div>
      <div className="divide-y divide-stone-100 px-5">
        {findings.map((f) => {
          const pdfHref = localCardPdfHref(f.pdf_url, f.pdf_status);
          return (
            <div key={f.finding_id} className="py-4">
              <div className="text-sm font-semibold text-stone-900">{f.finding_label}</div>
              <div className="mt-1 text-[12px] text-stone-500">
                {f.doc_type_label}
                {f.external_ref ? ` · ${f.external_ref}` : ""}
                {` · ${authorAttribution(f.authored_by_name)}`}
              </div>
              {f.finding_body ? (
                <p className="mt-2 text-[13px] text-stone-600 leading-snug">{f.finding_body}</p>
              ) : null}
              {pdfHref ? (
                <a
                  href={pdfHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-flex rounded-lg border border-brand bg-brand/10 px-3 py-1.5 text-[12.5px] font-semibold text-brand hover:bg-brand hover:text-white"
                >
                  Download audit findings PDF
                </a>
              ) : (
                <p className="mt-3 text-[12px] text-stone-500">Audit findings PDF is not available from CDMSS yet.</p>
              )}
              {f.response_owner === "pipe_a" ? (
                <p className="mt-3 text-[12px] text-stone-600 bg-stone-50 border border-stone-100 rounded-md px-3 py-2">
                  This issue is on your Findings list
                  {f.signal_reference ? ` (${f.signal_reference})` : ""}. Respond there so you are not asked twice.
                </p>
              ) : f.doctor_response_verb ? (
                <p className="mt-3 text-[12px] text-stone-600 bg-stone-50 border border-stone-100 rounded-md px-3 py-2">
                  You responded: {f.doctor_response_verb}
                  {f.doctor_response_comment ? ` · ${f.doctor_response_comment}` : ""}
                </p>
              ) : (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busyId === f.finding_id}
                    onClick={() => respond(f.finding_id, "agree")}
                    className="px-3 py-2 rounded-lg text-[12.5px] font-medium border bg-white border-stone-200 text-stone-700 disabled:opacity-50"
                  >
                    Agree
                  </button>
                  <button
                    type="button"
                    disabled={busyId === f.finding_id}
                    onClick={() => respond(f.finding_id, "disagree")}
                    className="px-3 py-2 rounded-lg text-[12.5px] font-medium border bg-white border-stone-200 text-stone-700 disabled:opacity-50"
                  >
                    Disagree
                  </button>
                  <button
                    type="button"
                    disabled={busyId === f.finding_id}
                    onClick={() => respond(f.finding_id, "needs_clarification")}
                    className="px-3 py-2 rounded-lg text-[12.5px] font-medium border bg-white border-stone-200 text-stone-700 disabled:opacity-50"
                  >
                    Needs clarification
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {err ? <div className="px-5 pb-4 text-[12.5px] text-rose-600">{err}</div> : null}
    </section>
  );
}
