import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HEADLINE_SUMMARY_LABEL, SUMMARY_STATE_NONE } from "../feedback-home";
import {
  NO_FEEDBACK_COPY,
  REGENERATE_HINT,
  SUMMARY_EMPTY_COPY,
  SUMMARY_EMPTY_TITLE,
  negativeActivityHint,
  positiveSourceHint,
  shortPhysicianId,
  timelineCategory,
} from "../feedback-detail";

describe("physician feedback detail", () => {
  it("labels positive rows by commendation and negatives by category", () => {
    expect(timelineCategory({
      polarity: "positive",
      category: null,
      commendation_category: "Patient Experience",
    })).toBe("Patient Experience");
    expect(timelineCategory({
      polarity: "negative",
      category: "patient_safety",
      commendation_category: null,
    })).toBe("Patient safety");
    expect(timelineCategory({
      polarity: "negative",
      category: "other",
      commendation_category: null,
    })).toBe("Other");
  });

  it("builds the physician headline hints from live row shape", () => {
    const rows = [
      { polarity: "negative", status: "open", severity: "low", source: "patient" },
      { polarity: "negative", status: "open", severity: "low", source: "patient" },
      { polarity: "positive", status: "open", severity: null, source: "patient" },
      { polarity: "negative", status: "retracted", severity: "critical", source: "peer" },
    ];
    expect(negativeActivityHint(rows)).toBe("All open · severity low");
    expect(positiveSourceHint(rows)).toBe("Patient source");
    expect(negativeActivityHint([
      { polarity: "negative", status: "closed", severity: "high", source: "peer" },
      { polarity: "negative", status: "open", severity: "low", source: "patient" },
    ])).toBe("Open + closed");
    expect(positiveSourceHint([
      { polarity: "positive", status: "open", severity: null, source: "governance" },
    ])).toBe("All sources");
  });

  it("keeps summary copy empty and the regenerate hint gated", () => {
    expect(SUMMARY_EMPTY_TITLE).toBe("No summary yet");
    expect(SUMMARY_EMPTY_COPY.toLowerCase()).toContain("not wired");
    expect(SUMMARY_EMPTY_COPY).not.toMatch(/excellent|compassionate|the patient said/i);
    expect(REGENERATE_HINT).toMatch(/Stage 3/);
    expect(NO_FEEDBACK_COPY).toMatch(/No feedback on file/);
    expect(SUMMARY_STATE_NONE).toBe("none");
    expect(HEADLINE_SUMMARY_LABEL).toBe("None yet");
    expect(shortPhysicianId("162799b0-2517-40ad-8b8b-d5b34d6ace42")).toBe("162799b0…");
  });

  it("does not select narrative or call a model from the detail route", () => {
    const root = join(__dirname, "..", "..");
    const route = readFileSync(join(root, "app/api/incidents/physician/[id]/route.ts"), "utf8");
    const view = readFileSync(join(root, "components/feedback/PhysicianFeedbackDetail.tsx"), "utf8");
    expect(route).not.toMatch(/\b(narrative|patient_ref|reporter_name|reporter_email|uhid)\b/i);
    expect(route + view).not.toMatch(/generateContent|vertexai|@google-cloud|physician_feedback_summaries/);
    expect(view).toContain("disabled");
    expect(view).not.toMatch(/narrative_preview/);
  });
});
