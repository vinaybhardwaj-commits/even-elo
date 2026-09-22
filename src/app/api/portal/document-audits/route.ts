import { NextResponse } from "next/server";
import { getCurrentPhysician } from "@/lib/physician-auth";
import { loadPortalRoutedFindings } from "@/lib/document-audits-db";
import { resolveAuditPdfUrl, DOC_TYPE_LABEL, normalizeDocType } from "@/lib/document-audits";

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
      pdf_url: resolveAuditPdfUrl({
        cdmss_pdf_url: r.cdmss_pdf_url,
        audit_id: r.external_ref || r.audit_id,
      }),
      doctor_response_verb: r.doctor_response_verb,
      doctor_response_comment: r.doctor_response_comment,
      doctor_responded_at: r.doctor_responded_at,
    };
  });

  return NextResponse.json({
    ok: true,
    findings,
    advisory:
      "Document-audit findings authored by an RMO and routed to you. Respond here; download the CDMSS PDF when available.",
  });
}
