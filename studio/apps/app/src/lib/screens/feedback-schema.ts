import { z } from "zod";
import { SourceTablePayload } from "./tool-schema";

// Contract for the Patient feedback screen (M3). "Patient feedback" is the governance DB `incidents` table
// (patient / peer / governance / external-public feedback about a physician). It is NOT the e-IRIS register.
// Reads and the retract write go through /studio/api/feedback/<op>, which calls even-elo's existing
// /api/incidents routes with the staff session forwarded. No SQL here, none in the agent.

export const FEEDBACK_OPS = ["list", "retract"] as const;
export type FeedbackOp = (typeof FEEDBACK_OPS)[number];
export const isFeedbackOp = (v: string): v is FeedbackOp => (FEEDBACK_OPS as readonly string[]).includes(v);

export const FEEDBACK_STATUSES = ["open", "closed", "retracted"] as const;
export const FEEDBACK_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const FEEDBACK_SOURCES = ["patient", "peer", "governance", "external_public"] as const;

// Strict: unknown keys refused. Values are the same sets even-elo's /api/incidents filters on.
export const FEEDBACK_LIST_PARAMS = z
  .object({
    status: z.enum(FEEDBACK_STATUSES).optional(),
    severity: z.enum(FEEDBACK_SEVERITIES).optional(),
    source: z.enum(FEEDBACK_SOURCES).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();
export type FeedbackListParams = z.input<typeof FEEDBACK_LIST_PARAMS>;

export const FEEDBACK_WRITE_PARAMS = {
  retract: z.object({ feedback_id: z.string().uuid(), retraction_reason: z.string().trim().min(1).max(500) }).strict(),
} as const;

/** What /studio/api/feedback/list returns: typed tables, each with its own source line. */
export const FeedbackPayload = z.object({
  items: SourceTablePayload,
  counts: SourceTablePayload,
  /** false until the G3 second factor exists: the confirm card stays disabled. */
  write_enabled: z.boolean(),
});
export type FeedbackPayload = z.infer<typeof FeedbackPayload>;

// Never emitted: the narrative or its preview, submitter identity, reporter name or email, patient_ref,
// retraction reason text. Ids, classification, dates and reply counts only.
export const FEEDBACK_ITEM_COLUMNS = [
  "feedback_id",
  "physician_id",
  "physician_name",
  "submitted_at",
  "hospital_code",
  "category",
  "severity",
  "polarity",
  "source",
  "commendation_category",
  "patient_rating",
  "status",
  "retracted_at",
  "reply_count",
  "reply_state",
  "last_reply_at",
] as const;
