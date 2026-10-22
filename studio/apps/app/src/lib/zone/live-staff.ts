// Live staff role read for the Studio zone. Mirrors even-elo src/lib/staff-live.ts (loadLiveStaff)
// but uses the SELECT-only connection GOV_RO_DATABASE_URL over Neon's HTTP driver (edge-safe).
import { neon } from "@neondatabase/serverless";
import type { LiveStaff } from "./authorize";

type Row = { status: string | null; is_super_admin: boolean | null; is_sgc_member?: boolean | null; is_site_medical_head?: boolean | null; is_hr?: boolean | null; must_change_pin: boolean | null };
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

// The live read: LIVE_STAFF_SQL plus the three hospital-role flags the per-screen predicates need (zone/access.ts).
// The flags are derived columns of the view (profiles no longer has them); ops/neon/0011_profiles_role_flags.sql grants
// exactly those three columns. Before 0011 is applied this read fails with InsufficientPrivilege and we fall back to
// LIVE_STAFF_SQL (so a deploy that precedes the grant keeps working): the flags are then unknown = false, i.e. plain
// staff, fail closed. tests/test_studio_live_staff_sql.py runs both statements against the real even-elo schema.
export const LIVE_STAFF_WIDE_SQL = `
SELECT p.status, p.is_super_admin, p.is_sgc_member, p.is_site_medical_head, p.is_hr,
       (SELECT base.must_change_pin FROM profiles base WHERE base.id = p.id) AS must_change_pin
FROM profiles_with_roles p
WHERE p.id = $1::uuid
LIMIT 1`;
const WIDE_RETRY_MS = 60_000;
let wideDeniedAt = 0;

let cached: { url: string; query: Query } | null = null;

function queryFor(url: string): Query {
  if (cached?.url === url) return cached.query;
  const sql = neon(url);
  const query: Query = async (profileId) => {
    if (Date.now() - wideDeniedAt >= WIDE_RETRY_MS) {
      try {
        return (await sql(LIVE_STAFF_WIDE_SQL, [profileId])) as unknown as Row[];
      } catch {
        wideDeniedAt = Date.now(); // not granted (or a blip): read the narrow row, retry the wide one in a minute
      }
    }
    return (await sql(LIVE_STAFF_SQL, [profileId])) as unknown as Row[];
  };
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
      is_sgc_member: r.is_sgc_member === true,
      is_site_medical_head: r.is_site_medical_head === true,
      is_hr: r.is_hr === true,
      must_change_pin: r.must_change_pin !== false, // unknown = treat as pending (fail closed)
    };
  } catch {
    return null;
  }
}
