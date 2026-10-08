import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSql, staff } from "./helpers/fixtures";

const h = vi.hoisted(() => ({
  user: null as unknown,
  sql: null as unknown as (...a: unknown[]) => unknown,
  neon: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn(async () => h.user) }));
vi.mock("@/lib/db", () => ({ sql: (...a: unknown[]) => h.sql(...a) }));
vi.mock("@neondatabase/serverless", () => ({ neon: h.neon }));

import { checkMigrateAuth } from "@/lib/migrate-auth";
import { GET, POST } from "@/app/api/admin/migrate/route";

const TOKEN = "migrate-token-0123456789";
const URL_ = "https://governance.test/api/admin/migrate";
const withAuth = (auth?: string, method = "POST") =>
  new Request(URL_, { method, headers: auth ? { authorization: auth } : {} });

describe("checkMigrateAuth (pure)", () => {
  it("opens for an active super admin session", () => {
    expect(checkMigrateAuth(null, undefined, staff.superAdmin)).toEqual({ ok: true, via: "session" });
  });
  it("opens for the exact bearer token", () => {
    expect(checkMigrateAuth(`Bearer ${TOKEN}`, TOKEN, null)).toEqual({ ok: true, via: "token" });
  });
  it("fails closed when neither is present", () => {
    expect(checkMigrateAuth(null, TOKEN, null)).toMatchObject({ ok: false, status: 401 });
    expect(checkMigrateAuth(undefined, undefined, undefined)).toMatchObject({ ok: false, status: 401 });
  });
  it("an unset or empty token disables the bearer path instead of opening it", () => {
    for (const header of ["Bearer ", "Bearer", "Bearer undefined", "Bearer null", "", "undefined"]) {
      expect(checkMigrateAuth(header, undefined, null).ok).toBe(false);
      expect(checkMigrateAuth(header, "", null).ok).toBe(false);
    }
  });
  it("refuses a short token (a guessable secret is not a secret)", () => {
    expect(checkMigrateAuth("Bearer abc", "abc", null).ok).toBe(false);
  });
  it("refuses a wrong token, a different scheme and a prefix of the token", () => {
    for (const header of ["Bearer wrong-token-0123456789", `Basic ${TOKEN}`, `Bearer ${TOKEN.slice(0, -1)}`, `bearer ${TOKEN}`, TOKEN]) {
      expect(checkMigrateAuth(header, TOKEN, null).ok).toBe(false);
    }
  });
  it("only a super admin session counts: not SMH, SGO, HR, pending accounts or a physician token", () => {
    for (const u of [staff.smh, staff.sgo, staff.hr, staff.pending, staff.physicianToken]) {
      expect(checkMigrateAuth(null, TOKEN, u).ok).toBe(false);
    }
    expect(checkMigrateAuth(null, TOKEN, { status: "active", is_super_admin: true, kind: "physician" }).ok).toBe(false);
  });
});

describe("/api/admin/migrate route", () => {
  beforeEach(() => {
    h.user = null;
    h.neon.mockReset();
    h.sql = fakeSql(() => []);
    process.env.ADMIN_MIGRATE_TOKEN = TOKEN;
    delete process.env.DATABASE_URL;
  });
  afterEach(() => {
    delete process.env.ADMIN_MIGRATE_TOKEN;
  });

  it("POST without credentials is 401 and never reaches the database", async () => {
    const res = await POST(withAuth());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "Unauthorized" });
    expect(h.neon).not.toHaveBeenCalled();
  });

  it("GET without credentials is 401 (the marker state is not public either)", async () => {
    const res = await GET(withAuth(undefined, "GET"));
    expect(res.status).toBe(401);
    expect(h.sql).not.toHaveBeenCalled();
  });

  it("fails closed when ADMIN_MIGRATE_TOKEN is not configured", async () => {
    delete process.env.ADMIN_MIGRATE_TOKEN;
    expect((await POST(withAuth("Bearer undefined"))).status).toBe(401);
    expect((await POST(withAuth("Bearer "))).status).toBe(401);
    expect((await GET(withAuth("Bearer undefined", "GET"))).status).toBe(401);
    expect(h.neon).not.toHaveBeenCalled();
  });

  it("a wrong token is 401", async () => {
    expect((await POST(withAuth("Bearer not-the-token-0123456"))).status).toBe(401);
    expect(h.neon).not.toHaveBeenCalled();
  });

  it("the right token gets past the gate (POST then stops at the missing DATABASE_URL, GET reads the marker table)", async () => {
    const post = await POST(withAuth(`Bearer ${TOKEN}`));
    expect(post.status).toBe(500);
    expect((await post.json()).error).toMatch(/DATABASE_URL/);
    const get = await GET(withAuth(`Bearer ${TOKEN}`, "GET"));
    expect(get.status).toBe(200);
    expect((await get.json()).ok).toBe(true);
  });

  it("a super admin session gets past the gate without a token; other staff and doctors do not", async () => {
    h.user = staff.superAdmin;
    expect((await POST(withAuth())).status).toBe(500); // past the gate, stopped by the missing DATABASE_URL
    for (const u of [staff.smh, staff.sgo, staff.hr, staff.physicianToken]) {
      h.user = u;
      expect((await POST(withAuth())).status).toBe(401);
      expect((await GET(withAuth(undefined, "GET"))).status).toBe(401);
    }
  });

  it("every handler in the route file authorizes before doing anything", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/admin/migrate/route.ts"), "utf8");
    const handlers = src.match(/export async function (GET|POST)\b/g) ?? [];
    expect(handlers).toHaveLength(2);
    expect((src.match(/const denied = await authorize\(req\);/g) ?? []).length).toBe(2);
    expect(src).not.toContain("URL-gated; no auth");
  });

  it("the middleware still lets the route through to its handler so a deploy script can use the bearer", () => {
    const src = readFileSync(join(process.cwd(), "src/middleware.ts"), "utf8");
    expect(src).toMatch(/ADMIN_BOOTSTRAP_ROUTES = \[\s*"\/api\/admin\/migrate"/);
    expect(src).toContain("ADMIN_MIGRATE_TOKEN");
  });
});
