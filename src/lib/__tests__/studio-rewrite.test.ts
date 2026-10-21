import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { middleware } from "@/middleware";

const require_ = createRequire(import.meta.url);
const { studioRewrites, studioRedirects } = require_("../../../studio-rewrites.js") as {
  studioRewrites: (o?: string) => Array<{ source: string; destination: string }>;
  studioRedirects: (o?: string) => Array<{ source: string; destination: string; permanent: boolean; missing: Array<{ type: string; value: string }> }>;
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

describe("STUDIO_ORIGIN redirects (root pages moved into the Studio)", () => {
  it("are empty when unset or invalid (rollback = remove the env)", () => {
    for (const v of [undefined, "", "not a url", "ftp://x.example", "https://x.example/other"]) {
      expect(studioRedirects(v), String(v)).toEqual([]);
    }
  });
  const MAPPING: Array<[string, string]> = [
    ["/overview", "/studio/overview"],
    ["/physicians", "/studio/physicians"],
    ["/physicians/:id", "/studio/physicians/:id"],
    ["/audit-findings", "/studio/audit-findings"],
    ["/audit-findings/:reference", "/studio/audit-findings/:reference"],
    ["/document-audits", "/studio/document-audits"],
    ["/document-audits/:id", "/studio/document-audits/:id"],
    ["/rmo-inbox", "/studio/rmo-inbox"],
    ["/incidents", "/studio/incidents"],
    ["/safety", "/studio/incidents"],
    ["/mm", "/studio/surgical"],
    ["/surgical-governance", "/studio/surgical"],
    ["/surgical-governance/vc/:id", "/studio/surgical/vcs/:id"],
    ["/onboarding", "/studio/onboarding"],
    ["/onboarding/:id", "/studio/onboarding/:id"],
    ["/admin/users", "/studio/admin/users"],
    ["/admin/resignations", "/studio/admin/resignations"],
  ];
  it("send exactly the mapped pages to /studio with a 307, never on the doctors host", () => {
    const rules = studioRedirects("https://studio.internal.example");
    expect(rules.map((r) => [r.source, r.destination, r.permanent])).toEqual(MAPPING.map(([s, d]) => [s, d, false]));
    for (const r of rules) {
      const re = new RegExp(`^${r.missing[0].value}$`);
      expect(r.missing[0].type).toBe("host");
      expect(re.test("doctors.evenos.app")).toBe(true);
      expect(re.test("governance.evenos.app")).toBe(false);
    }
  });
  it("every Studio destination is an existing Studio screen route", () => {
    const root = join(__dirname, "../../../studio/apps/app/src/app/(screens)");
    for (const [, dest] of MAPPING) {
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
  it("does not redirect admin ops, write/detail pages without a Studio equivalent, api, portal, login", () => {
    const sources = new Set(studioRedirects("https://studio.internal.example").map((r) => r.source));
    const unmapped = ["/admin", "/admin/pending", "/admin/metrics", "/admin/users/:id", "/audit-findings/mapping", "/incidents/new", "/incidents/:id",
      "/incidents/physician/:id", "/safety/report", "/safety/notifications", "/safety/incidents/:id", "/mm/new", "/mm/cases/:id",
      "/surgical-governance/admin", "/surgical-governance/capture-queue", "/surgical-governance/ot-sheets", "/surgical-governance/input/cases",
      "/api/:path*", "/portal", "/portal/:path*", "/login", "/logout", "/admin/migrate", "/admin/seed", "/admin/wipe"];
    for (const u of unmapped) expect(sources.has(u), u).toBe(false);
    for (const r of studioRedirects("https://studio.internal.example")) {
      expect(r.source.startsWith("/api") || r.source.startsWith("/portal") || r.source.includes("login")).toBe(false);
    }
  });
  it("next.config.js keeps the surgical-elo redirects and adds the studio ones only with the env", async () => {
    const prev = process.env.STUDIO_ORIGIN;
    try {
      delete process.env.STUDIO_ORIGIN;
      const base = await nextConfig.redirects();
      expect(base.map((r) => r.source)).toEqual(["/surgical-elo", "/surgical-elo/:path*"]);
      process.env.STUDIO_ORIGIN = "https://studio.internal.example";
      const withEnv = await nextConfig.redirects();
      expect(withEnv.map((r) => r.source)).toEqual([...base.map((r) => r.source), ...MAPPING.map(([s]) => s)]);
    } finally {
      if (prev === undefined) delete process.env.STUDIO_ORIGIN;
      else process.env.STUDIO_ORIGIN = prev;
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
