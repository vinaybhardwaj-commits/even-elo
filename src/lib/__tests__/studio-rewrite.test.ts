import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { signStaffJwt } from "@/lib/jwt";
import { middleware } from "@/middleware";

const require_ = createRequire(import.meta.url);
const { studioRewrites, studioRedirectPath, STUDIO_REDIRECTS } = require_("../../../studio-rewrites.js") as {
  studioRewrites: (o?: string) => Array<{ source: string; destination: string }>;
  studioRedirectPath: (o: string | undefined, pathname: string, host?: string) => string | null;
  STUDIO_REDIRECTS: Array<[string, string]>;
};
const nextConfig = require_("../../../next.config.js") as { rewrites: () => Promise<unknown>; redirects: () => Promise<Array<{ source: string; destination: string; permanent: boolean }>> };

describe("STUDIO_ORIGIN rewrite", () => {
  it("is empty when unset or invalid (no env = no rewrite)", () => {
    for (const v of [undefined, "", "not a url", "ftp://x.example", "https://u:p@x.example", "https://x.example/other", "https://x.example/?q=1"]) {
      expect(studioRewrites(v), String(v)).toEqual([]);
    }
  });
  it("proxies /studio and /studio/:path* to the origin's /studio", () => {
    expect(studioRewrites("https://studio.internal.example")).toEqual([
      { source: "/studio", destination: "https://studio.internal.example/studio" },
      { source: "/studio/:path*", destination: "https://studio.internal.example/studio/:path*" },
    ]);
    expect(studioRewrites("http://127.0.0.1:3000/")[0].destination).toBe("http://127.0.0.1:3000/studio");
  });
  it("next.config.js reads the env at config time", async () => {
    const prev = process.env.STUDIO_ORIGIN;
    try {
      delete process.env.STUDIO_ORIGIN;
      expect(await nextConfig.rewrites()).toEqual([]);
      process.env.STUDIO_ORIGIN = "https://studio.internal.example";
      expect(await nextConfig.rewrites()).toHaveLength(2);
    } finally {
      if (prev === undefined) delete process.env.STUDIO_ORIGIN;
      else process.env.STUDIO_ORIGIN = prev;
    }
  });
});

const ORIGIN = "https://studio.internal.example";
const MAPPING: Array<[string, string]> = [
  ["/overview", "/studio/overview"],
  ["/physicians", "/studio/physicians"],
  ["/physicians/p1", "/studio/physicians/p1"],
  ["/audit-findings", "/studio/audit-findings"],
  ["/audit-findings/AF-1", "/studio/audit-findings/AF-1"],
  ["/document-audits", "/studio/document-audits"],
  ["/document-audits/d1", "/studio/document-audits/d1"],
  ["/rmo-inbox", "/studio/rmo-inbox"],
  ["/incidents", "/studio/incidents"],
  ["/safety", "/studio/incidents"],
  ["/mm", "/studio/surgical"],
  ["/surgical-governance", "/studio/surgical"],
  ["/surgical-governance/vc/v1", "/studio/surgical/vcs/v1"],
  ["/onboarding", "/studio/onboarding"],
  ["/onboarding/o1", "/studio/onboarding/o1"],
  ["/onboarding/new", "/studio/onboarding/new"],
  ["/admin/users", "/studio/admin/users"],
  ["/admin/resignations", "/studio/admin/resignations"],
];
const UNMAPPED = ["/admin", "/admin/pending", "/admin/metrics", "/admin/users/u1", "/audit-findings/mapping", "/incidents/new", "/incidents/i1",
  "/incidents/physician/p1", "/safety/report", "/safety/notifications", "/safety/incidents/i1", "/safety/incidents/i1/rca", "/mm/new", "/mm/cases/c1",
  "/surgical-governance/admin", "/surgical-governance/capture-queue", "/surgical-governance/ot-sheets", "/surgical-governance/input/cases",
  "/api/admin/users", "/api/audit-findings/AF-1", "/api/admin/migrate", "/portal", "/portal/login", "/auth/login", "/api/auth/logout", "/home"];

async function jwt(superAdmin: boolean) {
  return signStaffJwt({ profileId: "p", email: "x@example.test", status: "active", is_super_admin: superAdmin, is_sgc_member: true }, "1h");
}
async function hit(path: string, token: string | null, opts: { host?: string; method?: string; headers?: Record<string, string> } = {}) {
  const host = opts.host ?? "governance.evenos.app";
  const headers: Record<string, string> = { host, ...opts.headers };
  if (token) headers.cookie = `epi_session=${token}`;
  return middleware(new NextRequest(`https://${host}${path}`, { method: opts.method ?? "GET", headers }));
}

describe("Studio redirects (role-conditional, in middleware)", () => {
  const prev = { o: process.env.STUDIO_ORIGIN, s: process.env.STAFF_JWT_SECRET, l: process.env.JWT_LEGACY_ACCEPT_UNTIL };
  beforeAll(() => {
    process.env.STAFF_JWT_SECRET = "staff-test-secret-0123456789abcdef";
    delete process.env.JWT_LEGACY_ACCEPT_UNTIL;
  });
  afterEach(() => { delete process.env.STUDIO_ORIGIN; });
  afterAll(() => {
    for (const [k, v] of [["STUDIO_ORIGIN", prev.o], ["STAFF_JWT_SECRET", prev.s], ["JWT_LEGACY_ACCEPT_UNTIL", prev.l]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it("next.config.js no longer carries Studio redirects (only surgical-elo), with or without the env", async () => {
    for (const v of [undefined, ORIGIN]) {
      if (v) process.env.STUDIO_ORIGIN = v; else delete process.env.STUDIO_ORIGIN;
      expect((await nextConfig.redirects()).map((r) => r.source)).toEqual(["/surgical-elo", "/surgical-elo/:path*"]);
    }
  });

  it("super_admin gets a 307 to the Studio route for every mapped page, query preserved", async () => {
    process.env.STUDIO_ORIGIN = ORIGIN;
    const t = await jwt(true);
    for (const [from, to] of MAPPING) {
      const r = await hit(`${from}?a=1&b=x%20y`, t);
      expect(r.status, from).toBe(307);
      const loc = new URL(r.headers.get("location")!);
      expect(loc.pathname + loc.search, from).toBe(`${to}?a=1&b=x%20y`);
      expect(loc.host, from).toBe("governance.evenos.app");
    }
  });

  it("<Link> prefetches are not redirected (alone or with rsc / _rsc / state-tree), so they cost nothing in the Studio", async () => {
    process.env.STUDIO_ORIGIN = ORIGIN;
    const t = await jwt(true);
    const prefetches: Array<[string, string, Record<string, string>]> = [
      ["prefetch header alone", "/overview", { "next-router-prefetch": "1" }],
      ["prefetch + rsc", "/overview", { "next-router-prefetch": "1", rsc: "1" }],
      ["prefetch + rsc + _rsc param + state tree", "/physicians/p1?a=1&_rsc=zz", { "next-router-prefetch": "1", rsc: "1", "next-router-state-tree": "%5B%22%22%5D" }],
    ];
    for (const [name, path, headers] of prefetches) {
      const r = await hit(path, t, { headers });
      expect(r.status, name).toBe(200);
      expect(r.headers.get("location"), name).toBeNull();
      expect(r.headers.get("x-middleware-next"), name).toBe("1");
    }
  });

  it("a super_admin clicking a Link to a moved page (rsc: 1 navigation, with or without _rsc / state tree) still reaches the Studio", async () => {
    process.env.STUDIO_ORIGIN = ORIGIN;
    const t = await jwt(true);
    const navs: Array<[string, string, Record<string, string>]> = [
      ["rsc header", "/overview", { rsc: "1" }],
      ["rsc + state tree", "/overview", { rsc: "1", "next-router-state-tree": "%5B%22%22%5D" }],
      ["rsc + _rsc param", "/overview?_rsc=abc12", { rsc: "1" }],
      ["_rsc param alone", "/physicians/p1?_rsc=zz", {}],
      ["plain navigation", "/overview", {}],
    ];
    for (const [name, path, headers] of navs) {
      const r = await hit(path, t, { headers });
      expect(r.status, name).toBe(307);
      expect(new URL(r.headers.get("location")!).pathname, name).toMatch(/^\/studio\//);
    }
    expect((await hit("/overview", t, { headers: { "next-router-prefetch": "0" } })).status).toBe(307);
  });

  it("non-super_admin never redirects to the Studio on any mapped path", async () => {
    process.env.STUDIO_ORIGIN = ORIGIN;
    const t = await jwt(false);
    for (const [from] of MAPPING) {
      const r = await hit(from, t);
      expect(r.headers.get("location") ?? "", from).not.toContain("/studio");
    }
    // pages the old app still serves to them pass straight through
    for (const p of ["/overview", "/physicians", "/physicians/p1", "/audit-findings", "/rmo-inbox", "/incidents", "/safety", "/onboarding"]) {
      const r = await hit(p, t);
      expect(r.status, p).toBe(200);
      expect(r.headers.get("location")).toBeNull();
    }
  });

  it("no env or invalid env = no redirect, even for super_admin", async () => {
    const t = await jwt(true);
    for (const v of [undefined, "", "not a url", "ftp://x.example", "https://x.example/other"]) {
      if (v === undefined) delete process.env.STUDIO_ORIGIN; else process.env.STUDIO_ORIGIN = v;
      for (const [from] of MAPPING) {
        const r = await hit(from, t);
        expect((r.headers.get("location") ?? "").includes("/studio"), `${v} ${from}`).toBe(false);
      }
    }
  });

  it("unmapped pages, api, portal and login never redirect to the Studio (super_admin, env set), incl. /audit-findings/mapping", async () => {
    process.env.STUDIO_ORIGIN = ORIGIN;
    const t = await jwt(true);
    for (const p of UNMAPPED) {
      const r = await hit(p, t);
      expect(r.headers.get("location") ?? "", p).not.toContain("/studio");
    }
    const r = await hit("/audit-findings/mapping", t);
    expect(r.status).toBe(200);
  });

  it("only GET/HEAD navigations redirect; the doctors host and unauthenticated requests never do", async () => {
    process.env.STUDIO_ORIGIN = ORIGIN;
    const t = await jwt(true);
    expect((await hit("/overview", t, { method: "POST" })).status).toBe(200);
    expect((await hit("/overview", t, { method: "HEAD" })).status).toBe(307);
    const d = await hit("/overview", t, { host: "doctors.evenos.app" });
    expect(d.status).toBe(404);
    const anon = await hit("/overview", null);
    expect(new URL(anon.headers.get("location")!).pathname).toBe("/auth/login");
  });

  it("studioRedirectPath handles trailing slash, doctors host and the exclusion directly", () => {
    expect(studioRedirectPath(ORIGIN, "/overview/", "governance.evenos.app")).toBe("/studio/overview");
    expect(studioRedirectPath(ORIGIN, "/overview", "doctors.evenos.app")).toBeNull();
    expect(studioRedirectPath(ORIGIN, "/audit-findings/mapping", "x")).toBeNull();
    expect(studioRedirectPath(undefined, "/overview", "x")).toBeNull();
  });

  it("every Studio destination is an existing Studio screen route", () => {
    const root = join(__dirname, "../../../studio/apps/app/src/app/(screens)");
    for (const [, dest] of STUDIO_REDIRECTS) {
      const segs = dest.replace(/^\/studio\//, "").split("/").map((x) => (x.startsWith(":") ? "*" : x));
      let dir = root;
      for (const seg of segs) {
        const names = readdirSync(dir);
        const hit = seg === "*" ? names.find((n) => /^\[.+\]$/.test(n)) : seg;
        expect(hit && names.includes(hit), dest).toBeTruthy();
        dir = join(dir, hit!);
      }
      expect(existsSync(join(dir, "page.tsx")), dest).toBe(true);
    }
  });
});

describe("doctors host never reaches /studio", () => {
  it("404 for /studio and below, with or without a staff cookie", async () => {
    for (const p of ["/studio", "/studio/", "/studio/api/copilotkit", "/studio/_next/static/x.js", "/studio/x.png"]) {
      for (const headers of [{}, { cookie: "epi_session=anything" }] as Array<Record<string, string>>) {
        const r = await middleware(new NextRequest(`https://doctors.evenos.app${p}`, { headers: { host: "doctors.evenos.app", ...headers } }));
        expect(r.status, p).toBe(404);
        expect(r.headers.get("x-middleware-rewrite")).toBeNull();
      }
    }
  });
});
