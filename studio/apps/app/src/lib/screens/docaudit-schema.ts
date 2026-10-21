import { z } from "zod";

// Document-audit read tools (M2). Same contract as the six M1 tools: strict params, validated by the screen route
// before anything reaches the agent. Kept in its own file so tool-schema.ts only gains two spread lines.

export const DOCAUDIT_TOOL_NAMES = ["list_document_audits", "document_audit_detail", "document_audit_doctor_rollup", "document_audit_headline"] as const;

const uuid = z.string().uuid();
const limit = z.number().int().min(1).max(200);
const hospital = z.string().max(40);

export const DOC_TYPES = ["progress", "ot", "discharge"] as const;
export const FINDING_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const FINDING_STATUSES = ["open", "in_progress", "remediated", "contested", "escalated"] as const;

export const DOCAUDIT_TOOL_PARAMS = {
  list_document_audits: z
    .object({
      filter: z
        .object({
          hospital_code: hospital.optional(),
          physician_id: uuid.optional(),
          doc_type: z.enum(DOC_TYPES).optional(),
          severity: z.enum(FINDING_SEVERITIES).optional(),
          status: z.enum(FINDING_STATUSES).optional(),
          doctor_name_contains: z.string().max(80).optional(),
        })
        .strict()
        .optional(),
      limit: limit.optional(),
      offset: z.number().int().min(0).max(100_000).optional(),
    })
    .strict(),
  document_audit_detail: z.object({ audit_id: uuid }).strict(),
  document_audit_doctor_rollup: z
    .object({ hospital_code: hospital.optional(), window_days: z.number().int().min(1).max(365).optional(), limit: limit.optional(), offset: z.number().int().min(0).max(100_000).optional() })
    .strict(),
  document_audit_headline: z.object({ hospital_code: hospital.optional() }).strict(),
} as const satisfies Record<(typeof DOCAUDIT_TOOL_NAMES)[number], z.ZodTypeAny>;
