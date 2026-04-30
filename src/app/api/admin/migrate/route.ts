import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { sql } from "@/lib/db";
import { MIGRATIONS } from "@/lib/migrations";
import { auditWrite } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Split a migration SQL block into discrete statements.
 * Naive but sufficient: our migrations don't contain DO blocks or strings
 * with semicolons. If that ever changes, switch to a proper splitter.
 */
function splitStatements(sqlText: string): string[] {
  return sqlText
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));
}

/**
 * POST /api/admin/migrate
 *
 * Applies pending migrations idempotently. Uses a `_migrations` marker table.
 * URL-gated; no auth in v1 (PRD §3 — committee tool, URL is the gate).
 *
 * Returns: { ok, executed, skipped, errors, applied: [{ id, durationMs }] }
 */
export async function POST() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return NextResponse.json(
      { ok: false, error: "DATABASE_URL not set on this deployment" },
      { status: 500 },
    );
  }
  const rawSql = neon(url);

  try {
    // Bootstrap the marker table (always idempotent).
    await rawSql`
      CREATE TABLE IF NOT EXISTS _migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        description text
      )
    `;

    const appliedRows = await rawSql`SELECT id FROM _migrations`;
    const alreadyApplied = new Set<string>(
      (appliedRows as Array<{ id: string }>).map((r) => r.id),
    );

    const applied: Array<{ id: string; statementCount: number; durationMs: number; description: string }> = [];
    const skipped: string[] = [];
    const errors: Array<{ id: string; statement?: string; error: string }> = [];

    for (const m of MIGRATIONS) {
      if (alreadyApplied.has(m.id)) {
        skipped.push(m.id);
        continue;
      }
      const statements = splitStatements(m.sql);
      const start = Date.now();
      let lastStatement = "";
      try {
        for (const stmt of statements) {
          lastStatement = stmt;
          await rawSql(stmt);
        }
        await rawSql`INSERT INTO _migrations (id, description) VALUES (${m.id}, ${m.description})`;
        applied.push({
          id: m.id,
          statementCount: statements.length,
          durationMs: Date.now() - start,
          description: m.description,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push({ id: m.id, statement: lastStatement.slice(0, 200), error: msg });
        // Stop on first failure — migrations must apply in order.
        break;
      }
    }

    if (applied.length > 0 || errors.length > 0) {
      try {
        await auditWrite({
          actor_position: "Committee Admin",
          action: "migrate",
          entity_type: "system",
          entity_id: "_migrations",
          after: { applied: applied.map((a) => a.id), errors },
        });
      } catch {
        // Audit table may not exist on the very first migration run — non-fatal.
      }
    }

    return NextResponse.json({
      ok: errors.length === 0,
      executed: applied.length,
      skipped: skipped.length,
      errors: errors.length,
      applied,
      skipped_ids: skipped,
      error_details: errors,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/**
 * GET /api/admin/migrate — read current marker state without applying.
 */
export async function GET() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS _migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        description text
      )
    `;
    const rows = await sql`SELECT id, applied_at, description FROM _migrations ORDER BY applied_at`;
    return NextResponse.json({
      ok: true,
      applied: rows,
      pending: MIGRATIONS.filter(
        (m) => !(rows as Array<{ id: string }>).some((r) => r.id === m.id),
      ).map((m) => ({ id: m.id, description: m.description })),
      total: MIGRATIONS.length,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
