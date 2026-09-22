/**
 * Stage 4 — Document Audits DB reads.
 * Returns empty honesty when tables are empty or unreadable — never invents volumes.
 */

import { sql } from "@/lib/db";
import {
  buildHeadline,
  emptyHeadline,
  exceptionScore,
  isSlaRisk,
  normalizeDocType,
  normalizePipeStatus,
  normalizeSeverity,
  openAgeDays,
  remediatorLabel,
  toListItem,
  type DocumentAuditListItem,
  type DocumentAuditsHeadline,
  type DocumentAuditRow,
  type PhysicianDocumentationEvent,
  type PhysicianDocumentationHeadline,
  type PipeStatus,
  type RmoInboxHeadline,
  type RmoWorkItem,
  type SgcExceptionItem,
  DOC_TYPE_LABEL,
  OPEN_PIPE,
  HIGH_SEV,
  formatAuditDate,
  ingestHonesty,
} from "@/lib/document-audits";
import { emptyAdherenceInputs, type AdherenceInputs } from "@/lib/adherence-stage4";

interface MetaRow {
  last_success_at: string | null;
}

interface CountBundle {
  total: number;
  open_findings: number;
  critical_high: number;
  doctors_with_findings: number;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function iso(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function loadIngestMeta(): Promise<{ lastSuccessAt: string | null }> {
  try {
    const rows = (await sql`
      SELECT last_success_at FROM document_audit_ingest_meta WHERE id = 1
    `) as unknown as MetaRow[];
    return { lastSuccessAt: iso(rows[0]?.last_success_at) };
  } catch {
    return { lastSuccessAt: null };
  }
}

export async function loadDocumentAuditCounts(hospitalCode: string | null): Promise<{
  headline: DocumentAuditsHeadline;
  available: boolean;
}> {
  try {
    const code = hospitalCode && hospitalCode !== "all" ? hospitalCode : "";
    const rows = (await sql`
      SELECT
        (SELECT count(*)::int FROM document_audits da
          WHERE (${code} = '' OR da.hospital_code = ${code})) AS total,
        (SELECT count(*)::int FROM document_audit_findings f
          JOIN document_audits da ON da.id = f.audit_id
          WHERE f.status IN ('open','in_progress','contested','escalated')
            AND (${code} = '' OR da.hospital_code = ${code})) AS open_findings,
        (SELECT count(*)::int FROM document_audit_findings f
          JOIN document_audits da ON da.id = f.audit_id
          WHERE f.severity IN ('critical','high')
            AND f.status IN ('open','in_progress','contested','escalated')
            AND (${code} = '' OR da.hospital_code = ${code})) AS critical_high,
        (SELECT count(DISTINCT f.physician_id)::int FROM document_audit_findings f
          JOIN document_audits da ON da.id = f.audit_id
          WHERE (${code} = '' OR da.hospital_code = ${code})) AS doctors_with_findings
    `) as unknown as CountBundle[];
    const c = rows[0] ?? {
      total: 0,
      open_findings: 0,
      critical_high: 0,
      doctors_with_findings: 0,
    };
    const meta = await loadIngestMeta();
    const lastFromAudits = (await sql`
      SELECT max(ingested_at) AS m FROM document_audits
      WHERE (${code} = '' OR hospital_code = ${code})
    `) as unknown as Array<{ m: unknown }>;
    const lastIngest = iso(lastFromAudits[0]?.m) ?? meta.lastSuccessAt;
    return {
      available: true,
      headline: buildHeadline({
        total: num(c.total),
        openFindings: num(c.open_findings),
        criticalHigh: num(c.critical_high),
        doctorsWithFindings: num(c.doctors_with_findings),
        lastIngest,
      }),
    };
  } catch {
    return { available: false, headline: emptyHeadline() };
  }
}

export async function loadDocumentAuditRows(opts: {
  hospitalCode: string | null;
  physicianId?: string | null;
  limit?: number;
}): Promise<DocumentAuditListItem[]> {
  try {
    const code = opts.hospitalCode && opts.hospitalCode !== "all" ? opts.hospitalCode : "";
    const pid = opts.physicianId ?? "";
    const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
    const rows = (await sql`
      SELECT
        da.id::text AS id,
        da.external_ref,
        da.hospital_code,
        da.physician_id::text AS physician_id,
        coalesce(p.full_name, 'Unknown') AS physician_name,
        coalesce(p.primary_specialty, '') AS specialty,
        da.doc_type,
        da.note_date::text AS note_date,
        da.ingested_at,
        da.cdmss_pdf_url,
        da.triage_routed_at,
        f.id::text AS finding_id,
        f.finding_label,
        f.finding_body,
        f.severity,
        f.status,
        f.authored_by_name,
        f.authored_at,
        coalesce(f.recurrence_count, 1) AS recurrence_count,
        coalesce(f.portal_visible, false) AS portal_visible,
        f.doctor_responded_at
      FROM document_audits da
      JOIN physicians p ON p.id = da.physician_id
      LEFT JOIN LATERAL (
        SELECT * FROM document_audit_findings x
        WHERE x.audit_id = da.id
        ORDER BY x.authored_at DESC
        LIMIT 1
      ) f ON true
      WHERE (${code} = '' OR da.hospital_code = ${code})
        AND (${pid} = '' OR da.physician_id = ${pid || "00000000-0000-0000-0000-000000000000"}::uuid)
      ORDER BY da.ingested_at DESC
      LIMIT ${limit}
    `) as unknown as DocumentAuditRow[];

    return rows.map((r) =>
      toListItem({
        ...r,
        ingested_at: iso(r.ingested_at) ?? new Date(0).toISOString(),
        note_date: r.note_date,
        authored_at: iso(r.authored_at),
        triage_routed_at: iso(r.triage_routed_at),
        doctor_responded_at: iso(r.doctor_responded_at),
        portal_visible: Boolean(r.portal_visible),
        recurrence_count: num(r.recurrence_count) || 1,
      }),
    );
  } catch {
    return [];
  }
}

export async function loadRmoInbox(opts: {
  hospitalCode: string | null;
  pipe?: PipeStatus | "all";
  physicianQuery?: string;
}): Promise<{
  headline: RmoInboxHeadline;
  pipe_counts: Record<PipeStatus, number>;
  items: RmoWorkItem[];
  exceptions: SgcExceptionItem[];
  doctors: Array<{ id: string; name: string; specialty: string }>;
}> {
  const emptyCounts: Record<PipeStatus, number> = {
    open: 0,
    in_progress: 0,
    remediated: 0,
    contested: 0,
    escalated: 0,
  };
  const empty = {
    headline: {
      open: 0,
      in_progress: 0,
      escalated: 0,
      sla_risk: 0,
      hospital_label: opts.hospitalCode && opts.hospitalCode !== "all" ? opts.hospitalCode : "All",
      honesty: "empty" as const,
    },
    pipe_counts: emptyCounts,
    items: [] as RmoWorkItem[],
    exceptions: [] as SgcExceptionItem[],
    doctors: [] as Array<{ id: string; name: string; specialty: string }>,
  };

  try {
    const code = opts.hospitalCode && opts.hospitalCode !== "all" ? opts.hospitalCode : "";
    const rows = (await sql`
      SELECT
        f.id::text AS finding_id,
        da.id::text AS audit_id,
        da.external_ref,
        f.finding_label,
        f.severity,
        f.status,
        f.physician_id::text AS physician_id,
        coalesce(p.full_name, 'Unknown') AS physician_name,
        coalesce(p.primary_specialty, '') AS specialty,
        da.hospital_code,
        da.doc_type,
        f.authored_by_name,
        f.authored_at,
        coalesce(f.recurrence_count, 1) AS recurrence_count
      FROM document_audit_findings f
      JOIN document_audits da ON da.id = f.audit_id
      JOIN physicians p ON p.id = f.physician_id
      WHERE (${code} = '' OR da.hospital_code = ${code})
      ORDER BY f.authored_at DESC
      LIMIT 500
    `) as unknown as Array<{
      finding_id: string;
      audit_id: string;
      external_ref: string | null;
      finding_label: string;
      severity: string;
      status: string;
      physician_id: string;
      physician_name: string;
      specialty: string;
      hospital_code: string;
      doc_type: string;
      authored_by_name: string;
      authored_at: unknown;
      recurrence_count: number;
    }>;

    const asOf = new Date();
    const items: RmoWorkItem[] = [];
    for (const r of rows) {
      const status = normalizePipeStatus(r.status);
      const severity = normalizeSeverity(r.severity);
      const docType = normalizeDocType(r.doc_type);
      if (!status || !severity || !docType) continue;
      const authoredAt = iso(r.authored_at) ?? asOf.toISOString();
      const age = openAgeDays(authoredAt, asOf);
      items.push({
        finding_id: r.finding_id,
        audit_id: r.audit_id,
        external_ref: r.external_ref,
        finding_label: r.finding_label,
        severity,
        status,
        physician_id: r.physician_id,
        physician_name: r.physician_name,
        specialty: r.specialty,
        hospital_code: r.hospital_code,
        doc_type: docType,
        doc_type_label: DOC_TYPE_LABEL[docType],
        authored_by_name: r.authored_by_name,
        authored_at: authoredAt,
        open_age_days: age,
        recurrence_count: num(r.recurrence_count) || 1,
        remediator_note: remediatorLabel(r.physician_name),
      });
    }

    const q = (opts.physicianQuery ?? "").trim().toLowerCase();
    const filtered = q
      ? items.filter(
          (i) =>
            i.physician_name.toLowerCase().includes(q) ||
            i.specialty.toLowerCase().includes(q) ||
            i.physician_id.toLowerCase().includes(q),
        )
      : items;

    const pipe = opts.pipe && opts.pipe !== "all" ? opts.pipe : null;
    const pipeItems = pipe ? filtered.filter((i) => i.status === pipe) : filtered;

    const open = items.filter((i) => i.status === "open").length;
    const inProgress = items.filter((i) => i.status === "in_progress").length;
    const escalated = items.filter((i) => i.status === "escalated").length;
    const slaRisk = items.filter(
      (i) => OPEN_PIPE.has(i.status) && isSlaRisk(i.open_age_days, i.severity),
    ).length;

    const pipe_counts: Record<PipeStatus, number> = {
      open,
      in_progress: inProgress,
      remediated: items.filter((i) => i.status === "remediated").length,
      contested: items.filter((i) => i.status === "contested").length,
      escalated,
    };

    const exceptions: SgcExceptionItem[] = items
      .filter((i) => OPEN_PIPE.has(i.status))
      .map((i) => ({
        finding_id: i.finding_id,
        finding_label: i.finding_label,
        severity: i.severity,
        status: i.status,
        physician_name: i.physician_name,
        hospital_code: i.hospital_code,
        open_age_days: i.open_age_days,
        recurrence_count: i.recurrence_count,
        exception_score: exceptionScore({
          severity: i.severity,
          recurrence: i.recurrence_count,
          openAgeDays: i.open_age_days,
        }),
        authored_by_name: i.authored_by_name,
      }))
      .sort((a, b) => b.exception_score - a.exception_score)
      .slice(0, 40);

    const doctorMap = new Map<string, { id: string; name: string; specialty: string }>();
    for (const i of items) {
      if (!doctorMap.has(i.physician_id)) {
        doctorMap.set(i.physician_id, {
          id: i.physician_id,
          name: i.physician_name,
          specialty: i.specialty,
        });
      }
    }

    const meta = await loadIngestMeta();
    const honesty = ingestHonesty(items.length, meta.lastSuccessAt ?? (items[0]?.authored_at ?? null));

    return {
      headline: {
        open,
        in_progress: inProgress,
        escalated,
        sla_risk: slaRisk,
        hospital_label: empty.headline.hospital_label,
        honesty,
      },
      pipe_counts,
      items: pipeItems,
      exceptions,
      doctors: Array.from(doctorMap.values()),
    };
  } catch {
    return empty;
  }
}

export async function loadPhysicianDocumentation(
  physicianId: string,
): Promise<{
  headline: PhysicianDocumentationHeadline;
  events: PhysicianDocumentationEvent[];
}> {
  const emptyHead: PhysicianDocumentationHeadline = {
    total: 0,
    open_findings: 0,
    critical_high: 0,
    last_event: null,
    honesty: "empty",
  };
  try {
    const rows = (await sql`
      SELECT
        f.id::text AS finding_id,
        da.id::text AS audit_id,
        da.external_ref,
        da.doc_type,
        f.finding_label,
        f.finding_body,
        f.severity,
        f.status,
        f.authored_by_name,
        f.authored_at,
        da.cdmss_pdf_url,
        da.note_date::text AS note_date
      FROM document_audit_findings f
      JOIN document_audits da ON da.id = f.audit_id
      WHERE f.physician_id = ${physicianId}::uuid
      ORDER BY f.authored_at DESC
      LIMIT 200
    `) as unknown as Array<{
      finding_id: string;
      audit_id: string;
      external_ref: string | null;
      doc_type: string;
      finding_label: string;
      finding_body: string | null;
      severity: string;
      status: string;
      authored_by_name: string;
      authored_at: unknown;
      cdmss_pdf_url: string | null;
      note_date: string | null;
    }>;

    const asOf = new Date();
    const events: PhysicianDocumentationEvent[] = [];
    for (const r of rows) {
      const status = normalizePipeStatus(r.status);
      const severity = normalizeSeverity(r.severity);
      const docType = normalizeDocType(r.doc_type);
      if (!status || !severity || !docType) continue;
      const authoredAt = iso(r.authored_at) ?? asOf.toISOString();
      events.push({
        finding_id: r.finding_id,
        audit_id: r.audit_id,
        external_ref: r.external_ref,
        date_label: formatAuditDate(r.note_date ?? authoredAt),
        doc_type: docType,
        doc_type_label: DOC_TYPE_LABEL[docType],
        finding_label: r.finding_label,
        finding_body: r.finding_body,
        severity,
        status,
        authored_by_name: r.authored_by_name,
        open_age_days: OPEN_PIPE.has(status) ? openAgeDays(authoredAt, asOf) : 0,
        cdmss_pdf_url: r.cdmss_pdf_url,
      });
    }

    const open = events.filter((e) => OPEN_PIPE.has(e.status)).length;
    const critHigh = events.filter(
      (e) => OPEN_PIPE.has(e.status) && HIGH_SEV.has(e.severity),
    ).length;
    const last = events[0]?.date_label ?? null;
    const meta = await loadIngestMeta();
    const honesty = ingestHonesty(events.length, meta.lastSuccessAt);

    return {
      headline: {
        total: events.length,
        open_findings: open,
        critical_high: critHigh,
        last_event: last,
        honesty,
      },
      events,
    };
  } catch {
    return { headline: emptyHead, events: [] };
  }
}

/** Portal: TriageBot-routed local findings for the signed-in physician. */
export async function loadPortalRoutedFindings(physicianId: string): Promise<
  Array<{
    finding_id: string;
    audit_id: string;
    external_ref: string | null;
    finding_label: string;
    finding_body: string | null;
    severity: string;
    status: string;
    authored_by_name: string;
    authored_at: string;
    doc_type: string;
    cdmss_pdf_url: string | null;
    doctor_response_verb: string | null;
    doctor_response_comment: string | null;
    doctor_responded_at: string | null;
  }>
> {
  try {
    const rows = (await sql`
      SELECT
        f.id::text AS finding_id,
        da.id::text AS audit_id,
        da.external_ref,
        f.finding_label,
        f.finding_body,
        f.severity,
        f.status,
        f.authored_by_name,
        f.authored_at,
        da.doc_type,
        da.cdmss_pdf_url,
        f.doctor_response_verb,
        f.doctor_response_comment,
        f.doctor_responded_at
      FROM document_audit_findings f
      JOIN document_audits da ON da.id = f.audit_id
      WHERE f.physician_id = ${physicianId}::uuid
        AND (f.portal_visible = true OR da.triage_routed_at IS NOT NULL)
      ORDER BY f.authored_at DESC
      LIMIT 100
    `) as unknown as Array<{
      finding_id: string;
      audit_id: string;
      external_ref: string | null;
      finding_label: string;
      finding_body: string | null;
      severity: string;
      status: string;
      authored_by_name: string;
      authored_at: unknown;
      doc_type: string;
      cdmss_pdf_url: string | null;
      doctor_response_verb: string | null;
      doctor_response_comment: string | null;
      doctor_responded_at: unknown;
    }>;
    return rows.map((r) => ({
      ...r,
      authored_at: iso(r.authored_at) ?? new Date(0).toISOString(),
      doctor_responded_at: iso(r.doctor_responded_at),
    }));
  } catch {
    return [];
  }
}

export async function recordDoctorFindingResponse(opts: {
  findingId: string;
  physicianId: string;
  verb: "agree" | "disagree" | "needs_clarification";
  comment: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const rows = (await sql`
      UPDATE document_audit_findings
      SET
        doctor_response_verb = ${opts.verb},
        doctor_response_comment = ${opts.comment},
        doctor_responded_at = now(),
        status = CASE
          WHEN status IN ('open','in_progress') AND ${opts.verb} = 'agree' THEN 'remediated'
          WHEN status IN ('open','in_progress') AND ${opts.verb} = 'disagree' THEN 'contested'
          ELSE status
        END,
        updated_at = now()
      WHERE id = ${opts.findingId}::uuid
        AND physician_id = ${opts.physicianId}::uuid
        AND (portal_visible = true OR EXISTS (
          SELECT 1 FROM document_audits da
          WHERE da.id = document_audit_findings.audit_id AND da.triage_routed_at IS NOT NULL
        ))
      RETURNING id::text AS id
    `) as unknown as Array<{ id: string }>;
    if (!rows[0]) return { ok: false, error: "not_found" };
    return { ok: true };
  } catch {
    return { ok: false, error: "db_error" };
  }
}

export async function loadAdherenceInputs(): Promise<AdherenceInputs> {
  try {
    const rows = (await sql`
      SELECT
        (SELECT count(*)::int FROM document_audit_findings) AS audit_finding_count,
        (SELECT count(*)::int FROM document_audit_findings WHERE status = 'remediated') AS remediated_count,
        (SELECT count(*)::int FROM document_audit_findings
          WHERE status IN ('open','in_progress','contested','escalated')) AS open_pressure_count,
        (SELECT count(*)::int FROM case_observations co
          JOIN streams s ON s.id = co.stream_id
          WHERE s.component = 'adherence') AS surgical_feedback_count,
        (SELECT avg(adherence_score)::float FROM score_snapshots
          WHERE adherence_score IS NOT NULL) AS snapshot_percent
    `) as unknown as Array<{
      audit_finding_count: number;
      remediated_count: number;
      open_pressure_count: number;
      surgical_feedback_count: number;
      snapshot_percent: number | null;
    }>;
    const r = rows[0];
    if (!r) return emptyAdherenceInputs();
    return {
      auditFindingCount: num(r.audit_finding_count),
      remediatedCount: num(r.remediated_count),
      openPressureCount: num(r.open_pressure_count),
      surgicalFeedbackCount: num(r.surgical_feedback_count),
      snapshotPercent:
        r.snapshot_percent === null || r.snapshot_percent === undefined
          ? null
          : Number(r.snapshot_percent),
    };
  } catch {
    return emptyAdherenceInputs();
  }
}

/** Network-wide volumes for Overview tiles (honest zeros when empty). */
export async function loadDocumentAuditVolumes(): Promise<{
  auditCount: number | null;
  openFindingCount: number | null;
}> {
  try {
    const rows = (await sql`
      SELECT
        (SELECT count(*)::int FROM document_audits) AS audits,
        (SELECT count(*)::int FROM document_audit_findings
          WHERE status IN ('open','in_progress','contested','escalated')) AS open_findings
    `) as unknown as Array<{ audits: number; open_findings: number }>;
    return {
      auditCount: num(rows[0]?.audits),
      openFindingCount: num(rows[0]?.open_findings),
    };
  } catch {
    return { auditCount: null, openFindingCount: null };
  }
}
