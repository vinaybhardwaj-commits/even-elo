import type { NextRequest } from "next/server";
import { ACTOR_ID_HEADER, ACTOR_ROLE_HEADER, SESSION_COOKIE } from "@/lib/zone/authorize";
import type { OnboardingActor } from "./run";

/**
 * The staff member of a request src/proxy.ts has already authenticated. staff id and role come from the headers the
 * proxy overwrote (never the body). The session JWT is the cookie, forwarded to even-elo as-is.
 */
export function onboardingActor(req: NextRequest): OnboardingActor | null {
  const staffId = req.headers.get(ACTOR_ID_HEADER);
  const role = req.headers.get(ACTOR_ROLE_HEADER);
  if (!staffId || !role) return null;
  return { staffId, role, session: req.cookies.get(SESSION_COOKIE)?.value ?? null };
}
