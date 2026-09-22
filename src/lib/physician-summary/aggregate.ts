/**
 * PHI-safe feedback aggregates for Sprint 3.2.
 * Only enum labels and counts leave this module. Raw category strings,
 * narratives, and identifiers are never copied into the aggregate.
 */

export interface SafeFeedbackRow {
  submitted_at: string;
  polarity: string;
  category: string | null;
  commendation_category: string | null;
  severity: string | null;
  status: string;
  source: string;
  patient_rating: number | null;
}

export interface MonthBucket {
  positive: number;
  negative: number;
}

export interface FeedbackAggregate {
  feedback_count: number;
  positive: number;
  negative: number;
  polarity_other: number;
  by_category: Record<string, number>;
  by_commendation: Record<string, number>;
  by_severity: Record<string, number>;
  by_status: Record<string, number>;
  by_source: Record<string, number>;
  by_rating: Record<string, number>;
  by_month: Record<string, MonthBucket>;
}

const CATEGORIES = new Set([
  "clinical",
  "patient_safety",
  "medical_error",
  "professionalism",
  "documentation",
  "etiquette",
  "vendor_compliance",
  "other",
]);

const COMMENDATIONS = new Set([
  "Clinical Excellence",
  "Patient Experience",
  "Teamwork & Collaboration",
  "Teaching & Mentorship",
  "Going Above & Beyond",
]);

const SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const STATUSES = new Set(["open", "closed"]);
const SOURCES = new Set(["patient", "peer", "governance", "external_public"]);

function bump(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

function bucket(value: string | null | undefined, allowed: Set<string>): string {
  if (!value) return "unset";
  return allowed.has(value) ? value : "other";
}

/** Calendar month in India Standard Time, YYYY-MM. Invalid timestamps are dropped. */
export function feedbackMonthKey(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "2-digit",
    timeZone: "Asia/Kolkata",
  }).formatToParts(d);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  if (!year || !month) return null;
  return `${year}-${month}`;
}

function sortedCounts(map: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(map).sort()) out[key] = map[key];
  return out;
}

/**
 * Counts non-retracted rows. Unknown enum values collapse to "other" or
 * "unset" so a dirty column cannot carry a name or narrative into the prompt.
 */
export function aggregateFeedback(rows: readonly SafeFeedbackRow[]): FeedbackAggregate {
  const by_category: Record<string, number> = {};
  const by_commendation: Record<string, number> = {};
  const by_severity: Record<string, number> = {};
  const by_status: Record<string, number> = {};
  const by_source: Record<string, number> = {};
  const by_rating: Record<string, number> = {};
  const by_month: Record<string, MonthBucket> = {};

  let feedback_count = 0;
  let positive = 0;
  let negative = 0;
  let polarity_other = 0;

  for (const row of rows) {
    if (row.status === "retracted") continue;
    feedback_count += 1;
    const polarity = row.polarity === "positive" || row.polarity === "negative" ? row.polarity : "other";
    if (polarity === "positive") positive += 1;
    else if (polarity === "negative") negative += 1;
    else polarity_other += 1;

    if (polarity === "negative") bump(by_category, bucket(row.category, CATEGORIES));
    if (polarity === "positive") bump(by_commendation, bucket(row.commendation_category, COMMENDATIONS));
    if (polarity === "negative") bump(by_severity, bucket(row.severity, SEVERITIES));
    bump(by_status, bucket(row.status, STATUSES));
    bump(by_source, bucket(row.source, SOURCES));

    const rating = row.patient_rating;
    if (typeof rating === "number" && Number.isInteger(rating) && rating >= 1 && rating <= 5) {
      bump(by_rating, String(rating));
    }

    const month = feedbackMonthKey(row.submitted_at);
    if (month && (polarity === "positive" || polarity === "negative")) {
      const slot = by_month[month] ?? { positive: 0, negative: 0 };
      if (polarity === "positive") slot.positive += 1;
      else slot.negative += 1;
      by_month[month] = slot;
    }
  }

  const months: Record<string, MonthBucket> = {};
  for (const key of Object.keys(by_month).sort()) months[key] = by_month[key];

  return {
    feedback_count,
    positive,
    negative,
    polarity_other,
    by_category: sortedCounts(by_category),
    by_commendation: sortedCounts(by_commendation),
    by_severity: sortedCounts(by_severity),
    by_status: sortedCounts(by_status),
    by_source: sortedCounts(by_source),
    by_rating: sortedCounts(by_rating),
    by_month: months,
  };
}

export function scopeStats(rows: readonly SafeFeedbackRow[]): {
  liveCount: number;
  newestAt: string | null;
} {
  let liveCount = 0;
  let newestMs = Number.NEGATIVE_INFINITY;
  let newestAt: string | null = null;
  for (const row of rows) {
    if (row.status === "retracted") continue;
    liveCount += 1;
    const ms = Date.parse(row.submitted_at);
    if (Number.isNaN(ms) || ms <= newestMs) continue;
    newestMs = ms;
    newestAt = new Date(ms).toISOString();
  }
  return { liveCount, newestAt };
}

/** Specialty is context only. Anything that is not a short label is omitted. */
export function sanitizeSpecialty(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value || value === "—") return null;
  if (!/^[A-Za-z][A-Za-z0-9 .&/'()-]{0,60}$/.test(value)) return null;
  return value;
}
