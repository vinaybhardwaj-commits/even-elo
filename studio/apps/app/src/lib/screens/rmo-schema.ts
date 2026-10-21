import { z } from "zod";
import { SourceTablePayload } from "./tool-schema";

// Contract for the RMO inbox screen (M2). Reads and writes go through /studio/api/rmo/<op>, which calls
// even-elo's existing /api/rmo-inbox routes with the staff session forwarded. No SQL here, none in the agent.

export const RMO_OPS = ["inbox", "author", "release"] as const;
export type RmoOp = (typeof RMO_OPS)[number];
export const isRmoOp = (v: string): v is RmoOp => (RMO_OPS as readonly string[]).includes(v);

export const PIPES = ["all", "open", "in_progress", "remediated", "contested", "escalated"] as const;

// Strict: unknown keys refused.
export const RMO_INBOX_PARAMS = z
  .object({ pipe: z.enum(PIPES).optional(), q: z.string().max(80).optional() })
  .strict();
export type RmoInboxParams = z.input<typeof RMO_INBOX_PARAMS>;

export const RMO_WRITE_PARAMS = {
  author: z.object({ finding_id: z.string().uuid(), authored_by_name: z.string().trim().max(120).optional() }).strict(),
  release: z.object({ finding_id: z.string().uuid() }).strict(),
} as const;

/** What /studio/api/rmo/inbox returns: three typed tables, each with its own source line. */
export const RmoInboxPayload = z.object({
  items: SourceTablePayload,
  counts: SourceTablePayload,
  exceptions: SourceTablePayload,
  /** false until the G3 second factor exists: the confirm cards stay disabled. */
  write_enabled: z.boolean(),
});
export type RmoInboxPayload = z.infer<typeof RmoInboxPayload>;

export const RMO_ITEM_COLUMNS = [
  "finding_id",
  "audit_id",
  "external_ref",
  "finding_label",
  "severity",
  "status",
  "physician_id",
  "physician_name",
  "specialty",
  "hospital_code",
  "doc_type_label",
  "authored_by_name",
  "authored_at",
  "open_age_days",
  "recurrence_count",
  "portal_visible",
  "author_pending",
  "signal_reference",
] as const;
