import { createRequire } from "node:module";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { signStaffJwt } from "@/lib/jwt";
import { middleware } from "@/middleware";
import { SCREEN_IDS, canAccessScreen, encodeRoles } from "../../../studio/apps/app/src/lib/zone/access";

const require_ = createRequire(import.meta.url);
const { canAccessStudioScreen, canAccessStudioPath, SCREEN_ROLES } = require_("../../../studio-access.js") as {
  canAccessStudioScreen: (u: Record<string, boolean>, s: string) => boolean;
  canAccessStudioPath: (u: Record<string, boolean>, p: string) => boolean;
  SCREEN_ROLES: Record<string, string[]>;
};
const { STUDIO_REDIRECTS } = require_("../../../studio-rewrites.js") as { STUDIO_REDIRECTS: Array<[string, string]> };

type Persona = { name: string; flags: Record<string, boolean> };
const PERSONAS: Persona[] = [
  { name: "super_admin", flags: { is_super_admin: true } },
  { name: "sgc_member (SGO)", flags: { is_sgc_member: true } },
  { name: "site_medical_head", flags: { is_site_medical_head: true } },
  { name: "hr", flags: { is_hr: true } },
  { name: "sgo + hr", flags: { is_sgc_member: true, is_hr: true } },
  { name: "rmo / plain active staff", flags: {} },
];
const roleOf = (f: Record<string, boolean>) => encodeRoles({ super_admin: f.is_super_admin, sgc_member: f.is_sgc_member, site_medical_head: f.is_site_medical_head, hr: f.is_hr });

describe("studio-access.js (even-elo redirect) = Studio zone access.ts", () => {
  it("same screens", () => {
    expect([...SCREEN_IDS].sort()).toEqual(Object.keys(SCREEN_ROLES).sort());
  });
  it("same answer for every persona x screen", () => {
    for (const p of PERSONAS) {
      for (const screen of SCREEN_IDS) {
        expect(canAccessStudioScreen(p.flags, screen), `${p.name} ${screen}`).toBe(canAccessScreen(roleOf(p.flags), screen));
      }
    }
  });
});

// Role x screen: the even-elo redirect. A user is redirected to a moved page only when the TARGET screen admits them.
const ORIGIN = "https://studio.internal.example";
const prev = { o: process.env.STUDIO_ORIGIN, s: process.env.STAFF_JWT_SECRET, l: process.env.JWT_LEGACY_ACCEPT_UNTIL };
beforeAll(() => {
  process.env.STAFF_JWT_SECRET = "staff-test-secret-0123456789abcdef";
  delete process.env.JWT_LEGACY_ACCEPT_UNTIL;
});
afterEach(() => delete process.env.STUDIO_ORIGIN);
afterAll(() => {
  for (const [k, v] of [["STUDIO_ORIGIN", prev.o], ["STAFF_JWT_SECRET", prev.s], ["JWT_LEGACY_ACCEPT_UNTIL", prev.l]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const sample = (from: string) => from.replace(/:(\w+)/g, "x1");
async function visit(path: string, claims: Record<string, unknown>, headers: Record<string, string> = {}) {
  const token = await signStaffJwt({ profileId: "p", email: "x@example.test", status: "active", must_change_pin: false, ...claims }, "1h");
  return middleware(new NextRequest(`https://governance.evenos.app${path}`, { headers: { host: "governance.evenos.app", cookie: `epi_session=${token}`, ...headers } }));
}

describe("even-elo middleware redirect: role x moved page", () => {
  for (const p of PERSONAS) {
    it(p.name, async () => {
      process.env.STUDIO_ORIGIN = ORIGIN;
      for (const [from, to] of STUDIO_REDIRECTS) {
        const path = sample(from);
        const target = sample(to);
        const expectRedirect = canAccessStudioPath(p.flags, target);
        const claims = { status: "active", is_super_admin: false, is_sgc_member: false, is_site_medical_head: false, is_hr: false, ...p.flags };
        const r = await visit(path, claims);
        const loc = r.headers.get("location") ?? "";
        expect(r.status === 307 && new URL(loc).pathname === target, `${p.name} ${path}`).toBe(expectRedirect);
        if (!expectRedirect) expect(loc, `${p.name} ${path}`).not.toContain("/studio");
        // prefetch: 204 exactly where the click would be redirected, otherwise the old page is served as before
        const pre = await visit(path, claims, { "next-router-prefetch": "1" });
        expect(pre.status === 204, `prefetch ${p.name} ${path}`).toBe(expectRedirect);
      }
    });
  }

  it("pending and suspended accounts never reach the Studio redirect", async () => {
    process.env.STUDIO_ORIGIN = ORIGIN;
    for (const status of ["pending_approval", "suspended"]) {
      const r = await visit("/overview", { status, is_super_admin: true });
      expect(new URL(r.headers.get("location")!).pathname).toBe("/auth/pending");
    }
    const pin = await visit("/overview", { is_super_admin: true, must_change_pin: true });
    expect(new URL(pin.headers.get("location")!).pathname).toBe("/auth/change-pin");
  });

  it("no STUDIO_ORIGIN = nothing redirects, for any persona", async () => {
    delete process.env.STUDIO_ORIGIN;
    for (const p of PERSONAS) {
      const r = await visit("/overview", { status: "active", ...p.flags });
      expect(r.headers.get("location") ?? "").not.toContain("/studio");
    }
  });
});
