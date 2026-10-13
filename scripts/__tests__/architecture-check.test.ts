import { describe, expect, it } from "vitest";
import { checkFiles } from "../architecture-check.mjs";

type F = { path: string; text: string };
type P = { rule: string; file: string; line: number; message: string };
const run = (files: F[], opts: Record<string, unknown> = {}): P[] => checkFiles(files, opts);

describe("architecture:check portal wall", () => {
  it("passes when portal code imports only shared modules", () => {
    const f = { path: "src/app/api/portal/me/route.ts", text: 'import { sql } from "@/lib/db";\nimport { x } from "@/lib/physician-auth";' };
    expect(run([f])).toEqual([]);
  });
  it("fails with file:line for a staff-only import (alias, relative, dir)", () => {
    const f = {
      path: "src/app/portal/page.tsx",
      text: 'import a from "react";\nimport { g } from "@/lib/staff-guard";\nimport b from "@/components/admin/Foo";\nimport c from "../../lib/auth";',
    };
    const r = run([f]);
    expect(r.map((x) => [x.rule, x.line])).toEqual([["portal-wall", 2], ["portal-wall", 3], ["portal-wall", 4]]);
    expect(r[0].file).toBe("src/app/portal/page.tsx");
  });
  it("does not flag staff code importing staff modules", () => {
    expect(run([{ path: "src/app/admin/page.tsx", text: 'import { g } from "@/lib/staff-guard";' }])).toEqual([]);
  });
  it("honours KNOWN_EXCEPTIONS", () => {
    const f = { path: "src/app/portal/page.tsx", text: 'import { g } from "@/lib/staff-guard";' };
    expect(run([f], { portalExceptions: { "src/app/portal/page.tsx": ["src/lib/staff-guard.ts"] } })).toEqual([]);
  });
});

describe("architecture:check upstream DB", () => {
  it("passes for DATABASE_URL", () => {
    expect(run([{ path: "src/lib/x.ts", text: "const u = process.env.DATABASE_URL;" }])).toEqual([]);
  });
  it("fails for upstream env names, other PG env, and URL literals", () => {
    const f = { path: "src/lib/x.ts", text: "a(process.env.CDMSS_DATABASE_URL);\nb(process.env.METABASE_URL);\nc(process.env.POSTGRES_URL);\nd('postgres://u@h/db');\ne(process.env.NEWCAT_PG_URL)" };
    const r = run([f], { upstreamExceptions: {}, neonExceptions: [] });
    expect(r.map((x) => x.line).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(r.every((x) => x.rule === "upstream-db")).toBe(true);
  });
  it("ignores comments and honours exceptions", () => {
    expect(run([{ path: "src/lib/x.ts", text: "// process.env.CDMSS_DATABASE_URL" }])).toEqual([]);
    expect(run([{ path: "src/lib/x.ts", text: "process.env.POSTGRES_URL" }], { upstreamExceptions: { "src/lib/x.ts": "debt" } })).toEqual([]);
  });
});

describe("architecture:check one DB client", () => {
  it("passes for neon( in src/lib/db.ts", () => {
    expect(run([{ path: "src/lib/db.ts", text: "cached = neon(url);" }])).toEqual([]);
  });
  it("fails for a new call site", () => {
    const r = run([{ path: "src/lib/new.ts", text: "const sql = neon(url);" }], { neonExceptions: [] });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ rule: "one-db-client", file: "src/lib/new.ts", line: 1 });
  });
  it("allows listed legacy sites only", () => {
    const text = "const sql = neon(url);";
    const files = [{ path: "src/lib/old.ts", text }, { path: "src/lib/new.ts", text }];
    const r = run(files, { neonExceptions: ["src/lib/old.ts"] });
    expect(r.map((x) => x.file)).toEqual(["src/lib/new.ts"]);
  });
});
