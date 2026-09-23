import { NextRequest, NextResponse } from "next/server";
import { getCurrentPhysician } from "@/lib/physician-auth";
import { sql } from "@/lib/db";
import { fetchDoctorAudits, type DoctorAuditSignal } from "@/lib/doctor-audits";
import { doctorMayFetchAuditPdf, isAuditUuid, type AuditPdfSignal } from "@/lib/findings-pdf";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const PDF_TIMEOUT_MS = 20000;

/**
 * GET /api/portal/findings/pdf?ref=<audit uuid>
 *
 * Session-authenticated proxy for the CDMSS audit-findings PDF. The browser
 * never receives GOV_API_KEY and never links at
 * `{GOV_API_BASE}/api/governance/audits/:id/pdf` (that route is 401 without
 * the key).
 *
 * Binding matches the Findings list: the physician's `cdmss_doctor_uid` is
 * read from the session, then doctor-audits is fetched for that uid. A signal
 * grants the file only when it has instances and a real audit UUID. A
 * portal-visible local document audit for this physician is the other grant,
 * so the local strip can download without exposing the CDMSS URL.
 *
 * A missing session is 401. A reference that is not an audit UUID (including
 * EHRC-AUD-*) is 400. An audit this doctor cannot see is 404 — the same answer
 * whether it belongs to someone else or does not exist. Upstream failure is
 * 502, never an empty PDF and never the upstream body.
 */

async function lookupDoctorUid(physicianId: string): Promise<string | null> {
  try {
    const rows = (await sql`
      SELECT cdmss_doctor_uid FROM physicians WHERE id=${physicianId}::uuid`) as unknown as Array<{
      cdmss_doctor_uid: string | null;
    }>;
    return rows[0]?.cdmss_doctor_uid ?? null;
  } catch {
    return null;
  }
}

/** Portal-visible local document audit whose CDMSS id is this audit UUID. */
async function physicianHasLocalAuditPdf(physicianId: string, auditId: string): Promise<boolean> {
  try {
    const rows = (await sql`
      SELECT da.source_audit_id
      FROM document_audit_findings f
      JOIN document_audits da ON da.id = f.audit_id
      WHERE f.physician_id = ${physicianId}::uuid
        AND (f.portal_visible = true OR da.triage_routed_at IS NOT NULL)
        AND (
          lower(da.source_audit_id) = lower(${auditId})
          OR position(lower(${auditId}) in lower(coalesce(da.cdmss_pdf_url, ''))) > 0
        )
      LIMIT 1`) as unknown as Array<{ source_audit_id: string | null }>;
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function fetchCdmssAuditPdf(auditId: string): Promise<Response> {
  const key = process.env.GOV_API_KEY;
  if (!key) throw new Error("GOV_API_KEY not configured");
  const base = process.env.GOV_API_BASE || "https://even-cdmss.vercel.app";
  const res = await fetch(`${base}/api/governance/audits/${encodeURIComponent(auditId)}/pdf`, {
    headers: { "x-api-key": key, accept: "application/pdf" },
    cache: "no-store",
    signal: AbortSignal.timeout(PDF_TIMEOUT_MS),
  });
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (!res.ok || !res.body) throw new Error(`CDMSS audit pdf ${res.status}`);
  if (ct.includes("json") || ct.includes("text/html") || ct.includes("text/plain")) {
    throw new Error(`CDMSS audit pdf content-type ${ct || "unknown"}`);
  }
  if (ct && !ct.includes("pdf") && !ct.includes("octet-stream")) {
    throw new Error(`CDMSS audit pdf content-type ${ct}`);
  }
  return res;
}

export async function GET(request: NextRequest) {
  const p = await getCurrentPhysician();
  if (!p) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const ref = (request.nextUrl.searchParams.get("ref") || "").trim();
  if (!isAuditUuid(ref)) {
    return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  }

  const uid = await lookupDoctorUid(p.physicianId);

  let signals: AuditPdfSignal[] = [];
  let listFailed = false;
  if (uid) {
    try {
      const upstream = await fetchDoctorAudits(uid, { window: 90, status: "all" });
      const list = Array.isArray(upstream?.signals) ? upstream.signals : [];
      signals = list as DoctorAuditSignal[];
    } catch {
      listFailed = true;
    }
  }

  const localMatch = await physicianHasLocalAuditPdf(p.physicianId, ref);
  if (!doctorMayFetchAuditPdf({ auditId: ref, signals, localMatch })) {
    if (listFailed && !localMatch) {
      return NextResponse.json({ ok: false, error: "upstream_unavailable" }, { status: 502 });
    }
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  try {
    const upstream = await fetchCdmssAuditPdf(ref);
    const headers = new Headers();
    headers.set("Content-Type", "application/pdf");
    headers.set("Content-Disposition", 'inline; filename="audit-findings.pdf"');
    headers.set("Cache-Control", "private, no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    return new NextResponse(upstream.body, { status: 200, headers });
  } catch {
    return NextResponse.json({ ok: false, error: "upstream_unavailable" }, { status: 502 });
  }
}
