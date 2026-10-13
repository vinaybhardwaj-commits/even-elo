import { NextRequest, NextResponse } from "next/server";
import { ACTOR_ID_HEADER, ACTOR_ROLE_HEADER, authorizeStudioRequest } from "@/lib/zone/authorize";
import { loadLiveStaff } from "@/lib/zone/live-staff";

// Runs on EVERY studio request (pages, assets, API). The matcher excludes nothing; basePath
// "/studio" is stripped by Next before matching.
export const config = { matcher: "/:path*" };

export async function middleware(request: NextRequest) {
  const cookies: Record<string, string | undefined> = {};
  for (const c of request.cookies.getAll()) cookies[c.name] = c.value;

  const decision = await authorizeStudioRequest(
    {
      method: request.method,
      host: request.headers.get("host"),
      forwardedHost: request.headers.get("x-forwarded-host")?.split(",")[0] ?? null,
      origin: request.headers.get("origin"),
      cookies,
    },
    { JWT_SECRET: process.env.JWT_SECRET, NODE_ENV: process.env.NODE_ENV },
    { loadLiveStaff: (id) => loadLiveStaff(id) },
  );

  if (!decision.ok) {
    // Reason is a fixed code, never request content.
    return NextResponse.json({ ok: false, error: decision.reason }, { status: decision.status });
  }

  // Overwrite (never trust) the actor headers the route handlers read.
  const headers = new Headers(request.headers);
  headers.delete(ACTOR_ID_HEADER);
  headers.delete(ACTOR_ROLE_HEADER);
  headers.set(ACTOR_ID_HEADER, decision.staffId);
  headers.set(ACTOR_ROLE_HEADER, decision.role);
  return NextResponse.next({ request: { headers } });
}
