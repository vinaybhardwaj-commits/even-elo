import { z } from "zod";
import { SourceTablePayload } from "./tool-schema";

// Contract for the Admin screens (M3): users and hospital roles, resignation requests, audit log.
// Reads and the three confirm-card writes go through /studio/api/admin/<op>, which calls even-elo's EXISTING
// /api/admin/* and /api/audit routes with the staff session forwarded. No SQL here, none in the agent.
//
// NOT here, on purpose: migrate, seed, wipe-smoke, dedupe, recompute and every other ops route (they stay on the
// old admin page); user create (carries a PIN), PIN reset, role revoke and user delete (hard deletes).

export const ADMIN_READ_OPS = ["users", "roles", "resignations", "audit"] as const;
export const ADMIN_WRITE_OPS = ["set_status", "grant_role", "process_resignation"] as const;
export const ADMIN_OPS = [...ADMIN_READ_OPS, ...ADMIN_WRITE_OPS] as const;
export type AdminOp = (typeof ADMIN_OPS)[number];
export const isAdminOp = (v: string): v is AdminOp => (ADMIN_OPS as readonly string[]).includes(v);
export const isAdminWriteOp = (op: AdminOp): op is (typeof ADMIN_WRITE_OPS)[number] => (ADMIN_WRITE_OPS as readonly string[]).includes(op);

export const USER_STATUSES = ["pending_approval", "active", "inactive", "suspended"] as const;
// Only the transitions the confirm card offers; the source route validates the full set again.
export const SETTABLE_STATUSES = ["active", "suspended"] as const;
export const HOSPITAL_ROLES = ["site_medical_head", "hr", "sgc_member"] as const;

const uuid = z.string().uuid();

// Strict: unknown keys refused, so nothing else can ride along to the upstream route.
export const ADMIN_PARAMS = {
  users: z.object({ status: z.enum(USER_STATUSES).optional() }).strict(),
  roles: z.object({ profile_id: uuid }).strict(),
  resignations: z.object({}).strict(),
  audit: z
    .object({
      action: z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9_.:-]+$/).optional(),
      entity_type: z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9_.:-]+$/).optional(),
      actor: z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9 _.:-]+$/).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).max(100_000).optional(),
    })
    .strict(),
  set_status: z.object({ profile_id: uuid, status: z.enum(SETTABLE_STATUSES) }).strict(),
  grant_role: z.object({ profile_id: uuid, hospital_code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,20}$/), role: z.enum(HOSPITAL_ROLES) }).strict(),
  process_resignation: z.object({ request_id: uuid }).strict(),
} as const;
export type AdminParams<O extends AdminOp> = z.input<(typeof ADMIN_PARAMS)[O]>;

/** What /studio/api/admin/<read op> returns: a typed table with its source line, plus counts for users. */
export const AdminPayload = z.object({
  table: SourceTablePayload,
  counts: SourceTablePayload.optional(),
  /** false until the G3 second factor exists (and always false for non-super_admin): confirm cards stay disabled. */
  write_enabled: z.boolean(),
});
export type AdminPayload = z.infer<typeof AdminPayload>;

// Never emitted: password hashes, PINs, requested_roles blobs, resignation reason text, audit before/after JSON.
export const USER_COLUMNS = ["profile_id", "full_name", "email", "status", "position_label", "hospital_code", "roles", "last_login_at", "created_at"] as const;
export const ROLE_COLUMNS = ["hospital_code", "role", "granted_at"] as const;
export const RESIGNATION_COLUMNS = ["request_id", "physician_name", "hospital_code", "status", "intended_last_date", "requested_at"] as const;
export const AUDIT_COLUMNS = ["at", "actor_position", "action", "entity_type", "entity_id"] as const;
export const USER_COUNT_COLUMNS = ["status", "users"] as const;
