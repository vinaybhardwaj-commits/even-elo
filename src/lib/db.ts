import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

/**
 * Lazy Neon HTTP client.
 *
 * Why lazy: Next.js 14 build "collects page data" by loading every route
 * module. Eager `neon(process.env.DATABASE_URL)` at module load throws if
 * the env isn't a real connection string at build time. The proxy below
 * defers the `neon()` call until the first actual SQL invocation at runtime.
 *
 * Usage is unchanged from a non-lazy client:
 *   import { sql } from "@/lib/db";
 *   const rows = await sql`SELECT * FROM vcs`;
 *
 * Pattern: HTTP driver (no pool). Same as Even OS / CodeCreator. Watch out
 * for the GROUP BY alias gotcha — wrap aggregations in a subquery if needed
 * (per CLAUDE.md note from Rounds work).
 */

type SqlFn = NeonQueryFunction<false, false>;

let cached: SqlFn | null = null;

function client(): SqlFn {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Configure it in Vercel project env or .env.local.",
    );
  }
  cached = neon(url);
  return cached;
}

const target = ((...args: unknown[]) =>
  (client() as unknown as (...a: unknown[]) => unknown)(...args)) as SqlFn;

export const sql: SqlFn = new Proxy(target, {
  get(_t, prop) {
    const c = client() as unknown as Record<string | symbol, unknown>;
    const v = c[prop as string];
    return typeof v === "function" ? (v as (...args: unknown[]) => unknown).bind(c) : v;
  },
});
