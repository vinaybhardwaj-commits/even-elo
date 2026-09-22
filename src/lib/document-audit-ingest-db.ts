/**
 * Pipe B writer. Plans with document-audit-ingest.ts, then upserts.
 * Unmapped doctors are skipped (physicians.cdmss_doctor_uid). No fuzzy name match.
 * Portal flags stay off until a routed signal matches or an RMO releases.
 */

import { sql } from "@/lib/db";
import { SYSTEM_AUDIT_AUTHOR } from "@/lib/document-audits";
import {
  countSkips,
  formatIngestNote,
  hasAllPlannedFindings,
  matchRoutedFindings,
  planDocumentAuditIngest,
  shouldProbeAuditPdf,
  type ExistingAuditKey,
  type LocalFindingKey,
  type PlannedAudit,
  type RouteHit,
} from "@/lib/document-audit-ingest";

const BASE = process.env.GOV_API_BASE || "https://even-cdmss.vercel.app";
const PDF_PROBE_CAP = 8;
const hospitalCache = new Map<string, string | null>();

const EXPORT_PATH = "/api/governance/document-audits-export";
const NOTE_CLASS_PARAMS = new Set(["ot", "discharge_summary", "progress"]);
const DAY_PARAM = /^\d{4}-\d{2}-\d{2}$/;

/** Optional CDMSS export filters. Unset fields keep the export's own defaults. */
export interface DocumentAuditIngestOpts {
  window?: string | number | null;
  note_class?: string | null;
  from?: string | null;
  to?: string | null;
}

function positiveIntDays(raw: string | number | null | undefined): string | null {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1) return null;
  return String(n);
}

function dayParam(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  return DAY_PARAM.test(v) ? v : null;
}

function noteClassParam(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  return NOTE_CLASS_PARAMS.has(v) ? v : null;
}

/** `${BASE}/api/governance/document-audits-export` plus only provided, valid params. */
export function buildDocumentAuditsExportUrl(
  base: string,
  opts: DocumentAuditIngestOpts = {},
): string {
  const root = base.replace(/\/+$/, "");
  const params = new URLSearchParams();
  const windowDays = positiveIntDays(opts.window);
  if (windowDays) params.set("window", windowDays);
  const noteClass = noteClassParam(opts.note_class);
  if (noteClass) params.set("note_class", noteClass);
  const from = dayParam(opts.from);
  if (from) params.set("from", from);
  const to = dayParam(opts.to);
  if (to) params.set("to", to);
  const qs = params.toString();
  return qs ? `${root}${EXPORT_PATH}?${qs}` : `${root}${EXPORT_PATH}`;
}

function isoOrNull(v: string | null): string | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export interface IngestRunResult {
  ok: true;
  audits: number;
  findings: number;
  unmapped_doctor: number;
  routed: number;
  pdf_stored: number;
  pdf_unavailable: number;
  progress_supported: boolean;
  note: string;
  skips: ReturnType<typeof countSkips>;
}

async function fetchExport(opts: DocumentAuditIngestOpts = {}): Promise<unknown> {
  const key = process.env.GOV_API_KEY;
  if (!key) throw new Error("GOV_API_KEY not configured");
  const res = await fetch(buildDocumentAuditsExportUrl(BASE, opts), {
    headers: { "x-api-key": key },
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`CDMSS document-audits-export ${res.status}: ${body}`);
  }
  return res.json();
}

async function probeAuditPdf(auditId: string): Promise<string | null> {
  const key = process.env.GOV_API_KEY;
  if (!key || !auditId) return null;
  const url = `${BASE}/api/governance/audits/${encodeURIComponent(auditId)}/pdf`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "x-api-key": key, Range: "bytes=0-0" },
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (!(res.ok || res.status === 206)) return null;
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("text/html") || ct.includes("application/json")) return null;
    return url;
  } catch {
    return null;
  }
}

export async function recordIngestMeta(note: string, success: boolean): Promise<void> {
  const text = note.slice(0, 800);
  await sql`
    INSERT INTO document_audit_ingest_meta (id, last_attempt_at, last_success_at, note)
    VALUES (1, now(), CASE WHEN ${success} THEN now() ELSE NULL END, ${text})
    ON CONFLICT (id) DO UPDATE SET
      last_attempt_at = now(),
      last_success_at = CASE
        WHEN ${success} THEN now()
        ELSE document_audit_ingest_meta.last_success_at
      END,
      note = ${text},
      updated_at = now()
  `;
}

async function hospitalId(code: string, cache: Map<string, string | null>): Promise<string | null> {
  if (cache.has(code)) return cache.get(code) ?? null;
  const rows = (await sql`
    SELECT id::text AS id FROM hospitals WHERE code = ${code} LIMIT 1
  `) as unknown as Array<{ id: string }>;
  const id = rows[0]?.id ?? null;
  cache.set(code, id);
  return id;
}

async function physicianId(doctorUid: string, cache: Map<string, string | null>): Promise<string | null> {
  if (cache.has(doctorUid)) return cache.get(doctorUid) ?? null;
  const rows = (await sql`
    SELECT id::text AS id FROM physicians WHERE cdmss_doctor_uid = ${doctorUid} LIMIT 1
  `) as unknown as Array<{ id: string }>;
  const id = rows[0]?.id ?? null;
  cache.set(doctorUid, id);
  return id;
}

async function upsertAudit(audit: PlannedAudit, pdfUrl: string | null, physician: string): Promise<string> {
  const hospital = await hospitalId(audit.hospital_code, hospitalCache);
  const rows = (await sql`
    INSERT INTO document_audits (
      external_ref, hospital_id, hospital_code, physician_id, doc_type, note_date,
      last_synced_at, cdmss_pdf_url, source, note_class, source_audit_id, doctor_uid
    ) VALUES (
      ${audit.external_ref},
      ${hospital}::uuid,
      ${audit.hospital_code},
      ${physician}::uuid,
      ${audit.doc_type},
      ${audit.note_date},
      now(),
      ${pdfUrl},
      'cdmss',
      ${audit.note_class},
      ${audit.source_audit_id},
      ${audit.doctor_uid}
    )
    ON CONFLICT (external_ref) DO UPDATE SET
      hospital_id = COALESCE(EXCLUDED.hospital_id, document_audits.hospital_id),
      hospital_code = EXCLUDED.hospital_code,
      physician_id = EXCLUDED.physician_id,
      doc_type = EXCLUDED.doc_type,
      note_date = EXCLUDED.note_date,
      last_synced_at = now(),
      cdmss_pdf_url = COALESCE(EXCLUDED.cdmss_pdf_url, document_audits.cdmss_pdf_url),
      note_class = COALESCE(EXCLUDED.note_class, document_audits.note_class),
      source_audit_id = COALESCE(EXCLUDED.source_audit_id, document_audits.source_audit_id),
      doctor_uid = COALESCE(EXCLUDED.doctor_uid, document_audits.doctor_uid)
    RETURNING id::text AS id
  `) as unknown as Array<{ id: string }>;
  const id = rows[0]?.id;
  if (!id) throw new Error("audit_upsert_failed");
  return id;
}

async function upsertFinding(auditId: string, physician: string, finding: PlannedAudit["findings"][number]): Promise<void> {
  await sql`
    INSERT INTO document_audit_findings (
      audit_id, finding_label, finding_body, severity, status,
      authored_by_name, physician_id, recurrence_count, portal_visible,
      finding_ref, queue_item_ref, signal_reference, signal_type, note_class
    ) VALUES (
      ${auditId}::uuid,
      ${finding.finding_label},
      ${finding.finding_body},
      ${finding.severity},
      'open',
      ${SYSTEM_AUDIT_AUTHOR},
      ${physician}::uuid,
      ${finding.recurrence_count},
      false,
      ${finding.finding_ref},
      ${finding.queue_item_ref},
      ${finding.signal_reference},
      ${finding.signal_type},
      ${finding.note_class}
    )
    ON CONFLICT (audit_id, finding_ref) WHERE finding_ref IS NOT NULL DO UPDATE SET
      finding_label = CASE
        WHEN document_audit_findings.authored_by_name = ${SYSTEM_AUDIT_AUTHOR}
        THEN EXCLUDED.finding_label ELSE document_audit_findings.finding_label END,
      finding_body = CASE
        WHEN document_audit_findings.authored_by_name = ${SYSTEM_AUDIT_AUTHOR}
        THEN EXCLUDED.finding_body ELSE document_audit_findings.finding_body END,
      severity = CASE
        WHEN document_audit_findings.authored_by_name = ${SYSTEM_AUDIT_AUTHOR}
        THEN EXCLUDED.severity ELSE document_audit_findings.severity END,
      queue_item_ref = COALESCE(EXCLUDED.queue_item_ref, document_audit_findings.queue_item_ref),
      signal_reference = COALESCE(EXCLUDED.signal_reference, document_audit_findings.signal_reference),
      signal_type = COALESCE(EXCLUDED.signal_type, document_audit_findings.signal_type),
      note_class = COALESCE(EXCLUDED.note_class, document_audit_findings.note_class),
      recurrence_count = GREATEST(document_audit_findings.recurrence_count, EXCLUDED.recurrence_count),
      updated_at = now()
  `;
}

interface ExistingAuditRow extends ExistingAuditKey {
  audit_row_id: string;
  source_audit_id: string | null;
  last_synced_at: string | null;
  cdmss_pdf_url: string | null;
}

async function loadExistingAuditKeys(audits: PlannedAudit[]): Promise<Map<string, ExistingAuditRow>> {
  const externalRefs = audits.map((audit) => audit.external_ref);
  if (!externalRefs.length) return new Map();
  const rows = (await sql`
    SELECT
      da.id::text AS audit_row_id,
      da.external_ref,
      da.source_audit_id,
      da.last_synced_at::text AS last_synced_at,
      da.cdmss_pdf_url,
      ARRAY(
        SELECT f.finding_ref
        FROM document_audit_findings f
        WHERE f.audit_id = da.id AND f.finding_ref IS NOT NULL
      ) AS finding_refs
    FROM document_audits da
    WHERE da.external_ref = ANY(${externalRefs}::text[])
  `) as unknown as ExistingAuditRow[];
  return new Map(rows.map((row) => [row.external_ref, row]));
}

async function storeExistingAuditPdf(auditRowId: string, pdfUrl: string): Promise<void> {
  await sql`
    UPDATE document_audits
    SET cdmss_pdf_url = COALESCE(cdmss_pdf_url, ${pdfUrl})
    WHERE id = ${auditRowId}::uuid
  `;
}

async function loadLocalKeys(): Promise<LocalFindingKey[]> {
  const rows = (await sql`
    SELECT
      f.id::text AS finding_id,
      da.id::text AS audit_row_id,
      da.external_ref,
      da.source_audit_id,
      da.doctor_uid,
      COALESCE(f.note_class, da.note_class) AS note_class,
      f.finding_ref,
      f.queue_item_ref,
      f.signal_type,
      f.signal_reference
    FROM document_audit_findings f
    JOIN document_audits da ON da.id = f.audit_id
  `) as unknown as LocalFindingKey[];
  return rows;
}

async function applyRouteHit(hit: RouteHit): Promise<void> {
  await sql`
    UPDATE document_audit_findings SET
      portal_visible = true,
      response_owner = 'pipe_a',
      signal_reference = COALESCE(${hit.signal_reference}, signal_reference),
      queue_item_ref = COALESCE(${hit.queue_item_ref}, queue_item_ref),
      note_class = COALESCE(${hit.note_class}, note_class),
      signal_type = COALESCE(${hit.signal_type}, signal_type),
      updated_at = now()
    WHERE id = ${hit.finding_id}::uuid
  `;
  const routedAt = isoOrNull(hit.routed_at);
  await sql`
    UPDATE document_audits SET
      triage_routed_at = COALESCE(triage_routed_at, ${routedAt}::timestamptz, now())
    WHERE id = ${hit.audit_row_id}::uuid
  `;
}

export async function runDocumentAuditIngest(
  opts: DocumentAuditIngestOpts = {},
): Promise<IngestRunResult> {
  hospitalCache.clear();
  const payload = await fetchExport(opts);
  const plan = planDocumentAuditIngest(payload);
  if (!plan.ok) throw new Error(plan.error);

  const physicianCache = new Map<string, string | null>();
  let audits = 0;
  let findings = 0;
  let unmapped = 0;
  let pdfStored = 0;
  let pdfUnavailable = 0;
  let probes = 0;

  const existingAudits = await loadExistingAuditKeys(plan.audits);
  for (const audit of plan.audits) {
    const existing = existingAudits.get(audit.external_ref);
    if (hasAllPlannedFindings(audit, existing)) {
      if (!existing?.cdmss_pdf_url) {
        let pdf = audit.pdf_url;
        if (shouldProbeAuditPdf(audit, existing?.cdmss_pdf_url) && probes < PDF_PROBE_CAP) {
          probes += 1;
          pdf = await probeAuditPdf(audit.pdf_probe_id!);
        }
        if (pdf && existing) {
          await storeExistingAuditPdf(existing.audit_row_id, pdf);
          pdfStored += 1;
        } else {
          pdfUnavailable += 1;
        }
      }
      continue;
    }

    const physician = await physicianId(audit.doctor_uid, physicianCache);
    if (!physician) {
      unmapped += 1;
      continue;
    }
    let pdf = audit.pdf_url ?? existing?.cdmss_pdf_url ?? null;
    if (shouldProbeAuditPdf(audit, existing?.cdmss_pdf_url) && probes < PDF_PROBE_CAP) {
      probes += 1;
      pdf = await probeAuditPdf(audit.pdf_probe_id!);
    }
    if (pdf) pdfStored += 1;
    else pdfUnavailable += 1;
    const auditId = await upsertAudit(audit, pdf, physician);
    audits += 1;
    for (const finding of audit.findings) {
      await upsertFinding(auditId, physician, finding);
      findings += 1;
    }
  }

  const locals = await loadLocalKeys();
  const hits = matchRoutedFindings(locals, plan.signals);
  for (const hit of hits) await applyRouteHit(hit);

  const skips = countSkips(plan.skips);
  const note = formatIngestNote({
    audits,
    findings,
    unmapped_doctor: unmapped,
    skips,
    routed: hits.length,
    pdf_stored: pdfStored,
    pdf_unavailable: pdfUnavailable,
    progress_supported: plan.progress_supported,
  });
  await recordIngestMeta(note, true);
  return {
    ok: true,
    audits,
    findings,
    unmapped_doctor: unmapped,
    routed: hits.length,
    pdf_stored: pdfStored,
    pdf_unavailable: pdfUnavailable,
    progress_supported: plan.progress_supported,
    note,
    skips,
  };
}
