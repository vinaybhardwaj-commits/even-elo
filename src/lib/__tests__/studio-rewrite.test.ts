import { createRequire } from "node:module";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { middleware } from "@/middleware";

const require_ = createRequire(import.meta.url);
const { studioRewrites } = require_("../../../studio-rewrites.js") as { studioRewrites: (o?: string) => Array<{ source: string; destination: string }> };
const nextConfig = require_("../../../next.config.js") as { rewrites: () => Promise<unknown> };

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
