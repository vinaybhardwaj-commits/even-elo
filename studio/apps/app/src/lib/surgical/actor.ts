import type { NextRequest } from "next/server";
import { ACTOR_ID_HEADER, ACTOR_ROLE_HEADER, SESSION_COOKIE } from "@/lib/zone/authorize";
import { verifyStaffSession } from "@/lib/zone/staff-jwt";
import type { SurgicalActor } from "./run";

/**
 * The staff member of a request src/proxy.ts has already authenticated. staff id and role come from the headers the
 * proxy overwrote (never the body). The session JWT is the cookie, forwarded to even-elo as-is; position_label is
 * read from it only after verifying it again (needed as actor_position by even-elo's PATCH routes).
 */
export async function surgicalActor(req: NextRequest, withPosition: boolean): Promise<SurgicalActor | null> {
  const staffId = req.headers.get(ACTOR_ID_HEADER);
  const role = req.headers.get(ACTOR_ROLE_HEADER);
  if (!staffId || !role) return null;
  const session = req.cookies.get(SESSION_COOKIE)?.value ?? null;
  let position: string | null = null;
  if (withPosition && session) {
    const claims = await verifyStaffSession(session, {
      STAFF_JWT_SECRET: process.env.STAFF_JWT_SECRET,
      JWT_SECRET: process.env.JWT_SECRET,
      JWT_LEGACY_ACCEPT_UNTIL: process.env.JWT_LEGACY_ACCEPT_UNTIL,
    });
    const label = (claims as Record<string, unknown> | null)?.position_label;
    if (claims && (claims as Record<string, unknown>).profileId === staffId && typeof label === "string") position = label;
  }
  return { staffId, role, session, position };
}
