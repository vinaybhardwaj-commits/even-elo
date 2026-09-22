/**
 * Physician feedback detail (Sprint 1.2).
 * Summary copy is the empty state. This module does not call a model.
 */

import { HEADLINE_SUMMARY_LABEL, SUMMARY_STATE_NONE, categoryLabel } from "./feedback-home";

export const SUMMARY_PANEL_TITLE = "Summary";
export const SUMMARY_EMPTY_TITLE = "No summary yet";
export const SUMMARY_EMPTY_COPY =
  "This physician has feedback, but no summary is stored. Gemini and Vertex are not wired yet, so this page will not invent one.";
export const NO_FEEDBACK_COPY = "No feedback on file for this physician.";
export const NO_FEEDBACK_SUMMARY_COPY = "There is no feedback to summarise, and no summary is stored.";
export const REGENERATE_LABEL = "Regenerate summary";
export const REGENERATE_HINT = "Available when Vertex is wired — Stage 3";
export const STALE_HINT = "Nothing is stored to go stale. That check waits until a summary exists.";

export interface FeedbackTimelineItem {
  id: string;
  submitted_at: string;
  polarity: string;
  category: string | null;
  commendation_category: string | null;
  severity: string | null;
  status: string;
  source: string;
}

export interface FeedbackDetailPhysician {
  id: string;
  name: string;
  specialty: string;
  hospital_codes: string[];
}

export interface FeedbackDetailHeadline {
  total: number;
  negative: number;
  positive: number;
  last_activity: string | null;
  negative_hint: string;
  positive_hint: string;
  summaries: typeof SUMMARY_STATE_NONE;
  summaries_label: typeof HEADLINE_SUMMARY_LABEL;
}

export interface FeedbackDetailPayload {
  ok: true;
  physician: FeedbackDetailPhysician;
  headline: FeedbackDetailHeadline;
  timeline: FeedbackTimelineItem[];
}

type HintRow = {
  polarity: string;
  status: string;
  severity: string | null;
  source: string;
};

export function timelineCategory(item: Pick<FeedbackTimelineItem, "polarity" | "category" | "commendation_category">): string {
  if (item.polarity === "positive" && item.commendation_category) return item.commendation_category;
  return categoryLabel(item.category);
}

export function negativeActivityHint(rows: HintRow[]): string {
  const neg = rows.filter((row) => row.polarity === "negative" && row.status !== "retracted");
  if (neg.length === 0) return "None";
  const allOpen = neg.every((row) => row.status === "open");
  const severities = new Set(neg.map((row) => row.severity).filter((value): value is string => !!value));
  if (allOpen && severities.size === 1) return `All open · severity ${Array.from(severities)[0]}`;
  return "Open + closed";
}

export function positiveSourceHint(rows: HintRow[]): string {
  const pos = rows.filter((row) => row.polarity === "positive" && row.status !== "retracted");
  if (pos.length === 0) return "None";
  const sources = new Set(pos.map((row) => row.source));
  if (sources.size === 1 && sources.has("patient")) return "Patient source";
  return "All sources";
}

export function shortPhysicianId(id: string): string {
  const compact = id.replace(/-/g, "");
  if (compact.length < 12) return id;
  return `${id.slice(0, 8)}…`;
}
