import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const COOKIE_NAME = "epi_session";

// Public routes — no auth required
const PUBLIC_ROUTES = ["/auth/login", "/auth/signup", "/auth/pending"];
const PUBLIC_API_ROUTES = [
  "/api/auth/login",
  "/api/auth/signup",
  "/api/auth/logout",
];

// Admin-bootstrap routes — URL-gated like v1 (no auth required so we can run
// migrate + seed during deploys). Keep this list short and explicit.
const ADMIN_BOOTSTRAP_ROUTES = [
  "/api/admin/migrate",
  "/api/admin/seed-epi-base",
  "/api/admin/db-snapshot",
  "/api/admin/db-fresh",
  "/api/admin/wipe-smoke-residue",
];

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  return new TextEncoder().encode(secret);
}

interface MiddlewarePayload {
  profileId?: unknown;
  email?: unknown;
  status?: unknown;
  is_super_admin?: unknown;
  is_sgc_member?: unknown;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Static assets
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.startsWith("/manifest") ||
    pathname.endsWith(".png") ||
    pathname.endsWith(".ico") ||
    pathname.endsWith(".svg")
  ) {
    return NextResponse.next();
  }

  // Public pages
  if (PUBLIC_ROUTES.some((r) => pathname === r)) {
    return NextResponse.next();
  }

  // Public + bootstrap API routes (exact match)
  if (PUBLIC_API_ROUTES.some((r) => pathname === r)) {
    return NextResponse.next();
  }
  if (ADMIN_BOOTSTRAP_ROUTES.some((r) => pathname === r)) {
    return NextResponse.next();
  }

  // Session cookie
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }
    return NextResponse.redirect(new URL("/auth/login", request.url));
  }

  const secret = getJwtSecret();
  if (!secret) {
    return NextResponse.redirect(new URL("/auth/login", request.url));
  }

  try {
    const { payload: rawPayload } = await jwtVerify(token, secret);
    const payload = rawPayload as MiddlewarePayload;

    // Status must be active
    if (payload.status !== "active") {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json(
          { ok: false, error: "Account pending approval" },
          { status: 403 },
        );
      }
      return NextResponse.redirect(new URL("/auth/pending", request.url));
    }

    // /surgical-elo gated to super_admin OR sgc_member (lock-down decision)
    if (
      pathname.startsWith("/surgical-elo") &&
      !payload.is_super_admin &&
      !payload.is_sgc_member
    ) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json(
          { ok: false, error: "Forbidden" },
          { status: 403 },
        );
      }
      return NextResponse.redirect(new URL("/home", request.url));
    }

    // /surgical-elo/admin and any /admin gated to super_admin only
    if (
      (pathname.startsWith("/surgical-elo/admin") ||
        pathname.startsWith("/admin")) &&
      !payload.is_super_admin
    ) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json(
          { ok: false, error: "Forbidden" },
          { status: 403 },
        );
      }
      return NextResponse.redirect(new URL("/home", request.url));
    }

    return NextResponse.next();
  } catch {
    // Invalid/expired token — clear cookie + send to login
    const response = pathname.startsWith("/api/")
      ? NextResponse.json(
          { ok: false, error: "Session expired" },
          { status: 401 },
        )
      : NextResponse.redirect(new URL("/auth/login", request.url));
    response.cookies.delete(COOKIE_NAME);
    return response;
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
