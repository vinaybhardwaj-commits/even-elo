import { sql } from "@/lib/db";

/**
 * Governance signal snapshot spine (EPI Redesign PRD v1.4-LOCKED §4.2/§6.1, R2).
 *
 * The CDMSS Governance Signals API is point-in-time; EPI accumulates one
 * snapshot per audited day in gov_signal_snapshots. Everything longitudinal
 * (trends, aging, lifecycle, movers, council diffs) is computed here from
 * the stored series — no CDMSS changes required.
 *
 * Contract: CDMSS-GOVERNANCE-SIGNALS-API-v1.0.md (+ handoff doc for v1.1).
 */

const SOURCE = "cdmss_opd";
const BASE = process.env.GOV_API_BASE || "https://even-cdmss.vercel.app";

export interface OpdAffectedDoctor {
  uid: string;
  name: string;
  mean: number;
  n: number;
}

export interface OpdSignal {
  kind?: "pdqi" | "domain"; // absent = pdqi (v1.0); "domain" signals carry metric/value/unit (CDMSS v1.1)
  attr?: string;
  metric?: string;
  value?: number;
  unit?: string;
  label: string;
  definition?: string;
  mean?: number;
  n: number;
  severity: "act_now" | "watch";
  trend: "improving" | "worsening" | "flat" | "no_baseline";
  delta?: number | null;
  scope: "systemic" | "concentrated" | "mixed" | "insufficient_data";
  eligible_doctors?: number;
  affected_share?: number | null;
  affected?: OpdAffectedDoctor[];
  action?: string;
}

export interface OpdHealthy {
  attr: string;
  label: string;
  mean: number;
  n: number;
}

export interface OpdSignalsPayload {
  ok: boolean;
  generator?: string;
  engine?: string;
  day: string;
  period: string;
  window?: { from: string; to: string };
  baseline?: { from: string; to: string; days: number };
  notes_total?: number;
  notes_assessed?: number;
  doctors_seen?: number;
  report?: {
    signals: OpdSignal[];
    healthy: OpdHealthy[];
    thresholds?: Record<string, number>;
  };
  advisory?: string;
}

export async function fetchOpdSignals(
  params: { day?: string; period?: string; baselineDays?: number } = {},
): Promise<OpdSignalsPayload> {
  const key = process.env.GOV_API_KEY;
  if (!key) throw new Error("GOV_API_KEY not configured");
  const qs = new URLSearchParams();
  if (params.day) qs.set("day", params.day);
  if (params.period) qs.set("period", params.period);
  if (params.baselineDays) qs.set("baselineDays", String(params.baselineDays));
  const url = `${BASE}/api/governance/opd-signals${qs.toString() ? `?${qs.toString()}` : ""}`;
  const res = await fetch(url, { headers: { "x-api-key": key }, cache: "no-store" });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`CDMSS signals API ${res.status}: ${body}`);
  }
  return (await res.json()) as OpdSignalsPayload;
}

/** Fetch one day (or the latest audited day) and upsert it into the snapshot store. */
export async function storeSnapshot(day?: string): Promise<{ day: string; generator: string | null }> {
  const payload = await fetchOpdSignals(day ? { day } : {});
  if (!payload?.ok || !payload.day) throw new Error("CDMSS payload not ok");
  await sql`
    INSERT INTO gov_signal_snapshots (source, day, period, generator, payload)
    VALUES (${SOURCE}, ${payload.day}::date, 'day', ${payload.generator ?? null}, ${JSON.stringify(payload)}::jsonb)
    ON CONFLICT (source, day, period)
    DO UPDATE SET payload = EXCLUDED.payload, generator = EXCLUDED.generator, fetched_at = now()`;
  return { day: payload.day, generator: payload.generator ?? null };
}

export interface SnapshotRow {
  day: string;
  generator: string | null;
  payload: OpdSignalsPayload;
}

export async function getSeries(days = 90): Promise<SnapshotRow[]> {
  const rows = (await sql`
    SELECT day::text AS day, generator, payload
    FROM gov_signal_snapshots
    WHERE source = ${SOURCE} AND period = 'day' AND day >= current_date - ${days}::int
    ORDER BY day ASC`) as unknown as SnapshotRow[];
  return rows;
}

/** Stable identity across pdqi (attr) and domain (metric) signals. */
export function signalKey(s: OpdSignal): string {
  return s.attr ?? s.metric ?? "unknown";
}

/**
 * A snapshot with 0 assessed notes is an empty window (e.g. today before the
 * audit cron) — NOT evidence that signals resolved. Skip such rows everywhere.
 */
export function hasData(row: SnapshotRow): boolean {
  const p = row.payload;
  return (
    (p.notes_assessed ?? 0) > 0 ||
    (p.report?.signals?.length ?? 0) > 0 ||
    (p.report?.healthy?.length ?? 0) > 0
  );
}

function dataRows(series: SnapshotRow[]): SnapshotRow[] {
  return series.filter(hasData);
}

export function latestSnapshot(series: SnapshotRow[]): SnapshotRow | null {
  const rows = dataRows(series);
  return rows.length ? rows[rows.length - 1] : null;
}

export interface SignalAge {
  ageDays: number; // days since the start of the current consecutive-signal run
  firstSeen: string;
  regressed: boolean; // signalled before, cleared, and is back
}

/** Per-attr aging for attrs active on the latest day. Presence = attr appears in that day's signals[]. */
export function computeAges(series: SnapshotRow[]): Record<string, SignalAge> {
  const out: Record<string, SignalAge> = {};
  const rows = dataRows(series);
  const latest = latestSnapshot(series);
  if (!latest) return out;
  const activeKeys = (latest.payload.report?.signals ?? []).map(signalKey);
  for (const attr of activeKeys) {
    let firstSeen = latest.day;
    let regressed = false;
    // walk back over data-bearing snapshots (consecutive, not calendar-strict)
    for (let i = rows.length - 1; i >= 0; i--) {
      const present = (rows[i].payload.report?.signals ?? []).some((s) => signalKey(s) === attr);
      if (present) {
        firstSeen = rows[i].day;
      } else {
        // gap: if the attr appears again even earlier, this is a regression
        for (let j = i; j >= 0; j--) {
          if ((rows[j].payload.report?.signals ?? []).some((s) => signalKey(s) === attr)) {
            regressed = true;
            break;
          }
        }
        break;
      }
    }
    const ageDays = Math.max(
      0,
      Math.round((new Date(latest.day).getTime() - new Date(firstSeen).getTime()) / 86400000),
    );
    out[attr] = { ageDays, firstSeen, regressed };
  }
  return out;
}

export interface ResolvedSignal {
  attr: string;
  label: string;
  lastSeen: string;
}

/** Attrs that signalled within the lookback window but are clear on the latest day. */
export function computeResolved(series: SnapshotRow[], lookbackDays = 14): ResolvedSignal[] {
  const latest = latestSnapshot(series);
  if (!latest) return [];
  const activeNow = new Set((latest.payload.report?.signals ?? []).map(signalKey));
  const seen = new Map<string, ResolvedSignal>();
  const cutoff = new Date(latest.day).getTime() - lookbackDays * 86400000;
  for (const row of dataRows(series)) {
    if (new Date(row.day).getTime() < cutoff) continue;
    for (const s of row.payload.report?.signals ?? []) {
      const k = signalKey(s);
      if (!activeNow.has(k)) seen.set(k, { attr: k, label: s.label, lastSeen: row.day });
    }
  }
  return Array.from(seen.values());
}

/** All attr means on a given snapshot (signals + healthy cover the full PDQI-9 set). */
export function attrMeans(row: SnapshotRow): Record<string, { label: string; mean: number }> {
  const out: Record<string, { label: string; mean: number }> = {};
  for (const s of row.payload.report?.signals ?? []) {
    if (typeof s.mean === "number") out[signalKey(s)] = { label: s.label, mean: s.mean };
  }
  for (const h of row.payload.report?.healthy ?? []) out[h.attr] = { label: h.label, mean: h.mean };
  return out;
}

export interface Mover {
  attr: string;
  label: string;
  delta: number;
  from: number;
  to: number;
}

/** Biggest attr-mean moves between the latest snapshot and one ~windowDays earlier. */
export function computeMovers(series: SnapshotRow[], windowDays = 30): { improving: Mover[]; worsening: Mover[] } {
  const rows = dataRows(series);
  const latest = latestSnapshot(series);
  if (!latest || rows.length < 2) return { improving: [], worsening: [] };
  const targetTime = new Date(latest.day).getTime() - windowDays * 86400000;
  let baseRow = rows[0];
  for (const row of rows) {
    if (new Date(row.day).getTime() <= targetTime) baseRow = row;
    else break;
  }
  if (baseRow.day === latest.day) baseRow = rows[Math.max(0, rows.length - 2)];
  const base = attrMeans(baseRow);
  const now = attrMeans(latest);
  const movers: Mover[] = [];
  for (const [attr, v] of Object.entries(now)) {
    if (base[attr] === undefined) continue;
    const delta = Math.round((v.mean - base[attr].mean) * 10) / 10;
    if (Math.abs(delta) >= 0.2) movers.push({ attr, label: v.label, delta, from: base[attr].mean, to: v.mean });
  }
  movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return {
    improving: movers.filter((m) => m.delta > 0).slice(0, 3),
    worsening: movers.filter((m) => m.delta < 0).slice(0, 3),
  };
}

/** Daily overall documentation-quality index (mean of all attr means) for sparklines. */
export function qualitySeries(series: SnapshotRow[]): Array<{ day: string; value: number }> {
  return dataRows(series).map((row) => {
    const means = Object.values(attrMeans(row)).map((m) => m.mean);
    const avg = means.length ? means.reduce((a, b) => a + b, 0) / means.length : 0;
    return { day: row.day, value: Math.round(avg * 100) / 100 };
  });
}
