import { NextRequest, NextResponse } from "next/server";
import { ACTOR_ID_HEADER, ACTOR_ROLE_HEADER, authorizeStudioRequest, isForbiddenClientHeader } from "@/lib/zone/authorize";
import { FALLBACK_SCREEN_PATH } from "@/lib/zone/access";
import { loadLiveStaff } from "@/lib/zone/live-staff";

// Runs on EVERY studio request (pages, assets, API). The matcher excludes nothing; basePath
// "/studio" is stripped by Next before matching.
export const config = { matcher: "/:path*" };

export async function proxy(request: NextRequest) {
  const cookies: Record<string, string | undefined> = {};
  for (const c of request.cookies.getAll()) cookies[c.name] = c.value;

  const decision = await authorizeStudioRequest(
    {
      method: request.method,
      host: request.headers.get("host"),
      forwardedHost: request.headers.get("x-forwarded-host")?.split(",")[0] ?? null,
      origin: request.headers.get("origin"),
      pathname: request.nextUrl.pathname,
      cookies,
    },
    {
      STAFF_JWT_SECRET: process.env.STAFF_JWT_SECRET,
      JWT_SECRET: process.env.JWT_SECRET, // only read inside the JWT_LEGACY_ACCEPT_UNTIL window
      JWT_LEGACY_ACCEPT_UNTIL: process.env.JWT_LEGACY_ACCEPT_UNTIL,
      NODE_ENV: process.env.NODE_ENV,
    },
    { loadLiveStaff: (id) => loadLiveStaff(id) },
  );

  if (!decision.ok) {
    // A signed-in staff member opening a page their role does not reach lands on Overview (open to every active
    // staff member). APIs, and everything else, answer with the fixed code.
    const p = request.nextUrl.pathname;
    if (decision.reason === "role" && (request.method === "GET" || request.method === "HEAD") && !p.startsWith("/api/") && p !== FALLBACK_SCREEN_PATH) {
      const url = request.nextUrl.clone();
      url.pathname = FALLBACK_SCREEN_PATH;
      url.search = "";
      return NextResponse.redirect(url, 307);
    }
    // Reason is a fixed code, never request content.
    return NextResponse.json({ ok: false, error: decision.reason }, { status: decision.status });
  }

  // Overwrite (never trust) the actor headers the route handlers read.
  // Drop every client x-studio-* / authorization header too: CopilotKit forwards x-* and authorization
  // to the agent after the minted ones.
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (!isForbiddenClientHeader(name)) headers.append(name, value);
  });
  headers.set(ACTOR_ID_HEADER, decision.staffId);
  headers.set(ACTOR_ROLE_HEADER, decision.role);
  return NextResponse.next({ request: { headers } });
}
