// X-Studio-Actor: short-lived HS256 JWT the app mints per agent call. The agent trusts only this
// (plus the service token), never cookies.
import { SignJWT } from "jose";

export const ACTOR_AUDIENCE = "studio-agent";
export const ACTOR_TTL_SECONDS = 45; // agent accepts exp - iat <= 60

export async function mintActorToken(
  staffId: string,
  role: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  if (!secret) throw new Error("STUDIO_ACTOR_SECRET is required");
  return new SignJWT({ role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(staffId)
    .setAudience(ACTOR_AUDIENCE)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + ACTOR_TTL_SECONDS)
    .setJti(crypto.randomUUID())
    .sign(new TextEncoder().encode(secret));
}

/** Headers for the agent call. Cookies are never forwarded. */
export async function agentHeaders(
  staffId: string,
  role: string,
  env: { STUDIO_SERVICE_TOKEN?: string; STUDIO_ACTOR_SECRET?: string },
): Promise<Record<string, string>> {
  if (!env.STUDIO_SERVICE_TOKEN) throw new Error("STUDIO_SERVICE_TOKEN is required");
  return {
    "X-Studio-Service-Token": env.STUDIO_SERVICE_TOKEN,
    "X-Studio-Actor": await mintActorToken(staffId, role, env.STUDIO_ACTOR_SECRET ?? ""),
  };
}
