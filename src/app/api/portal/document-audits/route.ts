import { NextResponse } from "next/server";
import { getCurrentPhysician } from "@/lib/physician-auth";
import { loadPortalRoutedFindings } from "@/lib/document-audits-db";
import { portalPdfStatus, portalResponseOwner, DOC_TYPE_LABEL, normalizeDocType } from "@/lib/document-audits";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/portal/document-audits — TriageBot-routed local document-audit findings
 * for the signed-in physician (Stage 4 lock). Complements CDMSS doctor-audits Findings.
 */
export async function GET() {
  const p = await getCurrentPhysician();
  if (!p) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const rows = await loadPortalRoutedFindings(p.physicianId);
  const findings = rows.map((r) => {
    const docType = normalizeDocType(r.doc_type);
    return {
      finding_id: r.finding_id,
      audit_id: r.audit_id,
      external_ref: r.external_ref,
      finding_label: r.finding_label,
      finding_body: r.finding_body,
      severity: r.severity,
      status: r.status,
      authored_by_name: r.authored_by_name,
      authored_at: r.authored_at,
      doc_type: docType,
      doc_type_label: docType ? DOC_TYPE_LABEL[docType] : r.doc_type,
      ...portalPdfStatus(r.cdmss_pdf_url),
      response_owner: portalResponseOwner(r.response_owner, r.signal_reference),
      signal_reference: r.signal_reference,
      doctor_response_verb: r.doctor_response_verb,
      doctor_response_comment: r.doctor_response_comment,
      doctor_responded_at: r.doctor_responded_at,
    };
  });

  return NextResponse.json({
    ok: true,
    findings,
    advisory:
      "Document-audit findings routed to you. A named RMO is shown once they confirm authorship. Respond here unless the card points you at Findings. The PDF link appears only when CDMSS has an audit-findings file.",
  });
}
