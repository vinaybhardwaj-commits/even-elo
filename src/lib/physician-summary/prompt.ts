import { sanitizeSpecialty, type FeedbackAggregate } from "./aggregate";

const SYSTEM = [
  "You are writing a short internal governance summary for hospital staff.",
  "You receive only aggregate counts. You do not receive narratives, names, or contact details.",
  "",
  "Write 2 to 4 short paragraphs of theme-level governance language:",
  "- polarity mix",
  "- negative themes by category and severity, only when those counts are non-zero",
  "- positive themes by commendation label, only when those counts are non-zero",
  "- source mix and the rough month pattern, only from the counts provided",
  "",
  "Hard rules:",
  "- Use only the numbers and labels in the aggregate. If a label is absent, do not invent it.",
  "- Do not fabricate quotes, complaints, or stories.",
  "- Do not name any patient. Do not invent names.",
  "- Do not include phone numbers, email addresses, UHID, MRN, or other identifiers.",
  "- Do not use quotation marks.",
  "- Do not give medical advice.",
  "- Plain prose only. No markdown, no bullets, no headings.",
].join("\n");

/** Backstop: the user payload must stay counts and enum labels. */
const PAYLOAD_PHI = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\d{8,}|\b(uhid|mrn|narrative|patient_ref|reporter_name|reporter_email)\b/i;

export function buildSummaryPrompt(
  aggregate: FeedbackAggregate,
  specialty: string | null | undefined,
): { system: string; user: string } {
  const safeSpecialty = sanitizeSpecialty(specialty);
  const user = [
    `Specialty: ${safeSpecialty ?? "unknown"}`,
    "",
    "Aggregate:",
    JSON.stringify(aggregate),
  ].join("\n");
  if (PAYLOAD_PHI.test(user)) {
    throw new Error("REFUSED_PHI");
  }
  return { system: SYSTEM, user };
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const LONG_DIGITS = /\d{8,}/;
const IDENTIFIER = /\b(uhid|mrn)\b/i;
const QUOTES = /["“”«»]/;
const FABRICATED = /\bpatient\s+(said|named|called)\b/i;

/**
 * Accepts theme-level prose. Returns null when the text is empty, too long,
 * or contains identifiers, quotation marks, or a fabricated patient utterance.
 */
export function acceptSummaryBody(raw: string): string | null {
  let text = raw.replace(/\r\n/g, "\n").trim();
  text = text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
  if (text.length < 40 || text.length > 4000) return null;
  if (EMAIL.test(text) || LONG_DIGITS.test(text) || IDENTIFIER.test(text)) return null;
  if (QUOTES.test(text) || FABRICATED.test(text)) return null;
  return text;
}
