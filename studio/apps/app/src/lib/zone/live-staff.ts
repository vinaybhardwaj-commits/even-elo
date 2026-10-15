// Live staff role read for the Studio zone. Mirrors even-elo src/lib/staff-live.ts (loadLiveStaff)
// but uses the SELECT-only connection GOV_RO_DATABASE_URL over Neon's HTTP driver (edge-safe).
import { neon } from "@neondatabase/serverless";
import type { LiveStaff } from "./authorize";

type Row = { status: string | null; is_super_admin: boolean | null; must_change_pin: boolean | null };
type Query = (profileId: string) => Promise<Row[]>;

// The view profiles_with_roles is `SELECT p.*` frozen at even-elo migration 015, so it does NOT have
// must_change_pin (added to profiles in 020). Read it from the base table exactly like even-elo's
// login route does. The read-only role therefore needs SELECT on profiles as well as the view.
// Exported as text so a real-Postgres test (apps/agent/tests/test_studio_live_staff_sql.py) can run
// this exact statement against the even-elo migrations; $1 is the profile id.
export const LIVE_STAFF_SQL = `
SELECT p.status, p.is_super_admin,
       (SELECT base.must_change_pin FROM profiles base WHERE base.id = p.id) AS must_change_pin
FROM profiles_with_roles p
WHERE p.id = $1::uuid
LIMIT 1`;

let cached: { url: string; query: Query } | null = null;

function queryFor(url: string): Query {
  if (cached?.url === url) return cached.query;
  const sql = neon(url);
  const query: Query = async (profileId) => (await sql(LIVE_STAFF_SQL, [profileId])) as unknown as Row[];
  cached = { url, query };
  return query;
}

/** Fail closed: no URL, no row or any error -> null. */
export async function loadLiveStaff(profileId: string, query?: Query): Promise<LiveStaff | null> {
  if (!profileId) return null;
  try {
    const url = process.env.GOV_RO_DATABASE_URL;
    const q = query ?? (url ? queryFor(url) : null);
    if (!q) return null;
    const rows = await q(profileId);
    const r = Array.isArray(rows) ? rows[0] : undefined;
    if (!r) return null;
    return {
      status: String(r.status ?? ""),
      is_super_admin: r.is_super_admin === true,
      must_change_pin: r.must_change_pin !== false, // unknown = treat as pending (fail closed)
    };
  } catch {
    return null;
  }
}
