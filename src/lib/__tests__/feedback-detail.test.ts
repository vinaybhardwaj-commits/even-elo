import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NO_FEEDBACK_COPY,
  SUMMARY_PANEL_TITLE,
  negativeActivityHint,
  positiveSourceHint,
  shortPhysicianId,
  timelineCategory,
} from "../feedback-detail";
import { deriveSummaryState, formatSummaryGeneratedIst, summaryChipLabel } from "../physician-summary/state";
import { acceptSummaryBody, buildSummaryPrompt } from "../physician-summary/prompt";
import { aggregateFeedback } from "../physician-summary/aggregate";
import { resolveSummaryView, type SummaryServerPayload } from "../physician-summary/view";
import { generateThemeSummary } from "../physician-summary/generate";

const FAKE_EMAIL = "vertex-spike@example.test";
const FAKE_KEY_BODY = "FAKEKEYMATERIALNOTREAL12";
const FAKE_KEY = `-----BEGIN PRIVATE KEY-----\n${FAKE_KEY_BODY}\n-----END PRIVATE KEY-----`;

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

  it("keeps the timeline free of narrative columns and shortens physician ids", () => {
    expect(SUMMARY_PANEL_TITLE).toBe("Summary");
    expect(NO_FEEDBACK_COPY).toMatch(/No feedback on file/);
    expect(shortPhysicianId("162799b0-2517-40ad-8b8b-d5b34d6ace42")).toBe("162799b0…");
  });

  it("does not select narrative or PHI fields from the detail route", () => {
    const root = join(__dirname, "..", "..");
    const route = readFileSync(join(root, "app/api/incidents/physician/[id]/route.ts"), "utf8");
    const view = readFileSync(join(root, "components/feedback/PhysicianFeedbackDetail.tsx"), "utf8");
    expect(route).not.toMatch(/\b(narrative|patient_ref|reporter_name|reporter_email|uhid)\b/i);
    expect(view).not.toMatch(/narrative_preview/);
    expect(view).toContain("/summary");
  });
});

describe("physician summary aggregates and prompts", () => {
  const rows = [
    {
      submitted_at: "2026-05-20T07:21:00.000Z",
      polarity: "positive",
      category: null,
      commendation_category: "Patient Experience",
      severity: null,
      status: "open",
      source: "patient",
      patient_rating: 5,
    },
    {
      submitted_at: "2026-05-07T07:21:00.000Z",
      polarity: "negative",
      category: "other",
      commendation_category: null,
      severity: "low",
      status: "open",
      source: "patient",
      patient_rating: null,
    },
    {
      submitted_at: "2026-01-01T00:00:00.000Z",
      polarity: "negative",
      category: "patient_safety",
      commendation_category: null,
      severity: "high",
      status: "retracted",
      source: "peer",
      patient_rating: null,
    },
  ];

  it("aggregates only enum labels and skips retracted rows", () => {
    const agg = aggregateFeedback(rows);
    expect(agg.feedback_count).toBe(2);
    expect(agg.positive).toBe(1);
    expect(agg.negative).toBe(1);
    expect(agg.by_category).toEqual({ other: 1 });
    expect(agg.by_commendation).toEqual({ "Patient Experience": 1 });
    expect(agg.by_severity).toEqual({ low: 1 });
    expect(JSON.stringify(agg)).not.toMatch(/narrative|uhid|@|patient said/i);
  });

  it("builds a prompt without PHI fields and rejects unsafe model text", () => {
    const prompt = buildSummaryPrompt(aggregateFeedback(rows), "ENT");
    expect(prompt.system).toMatch(/Do not name any patient/);
    expect(prompt.user).toContain('"feedback_count":2');
    expect(prompt.user).not.toMatch(/\b(narrative|patient_ref|uhid|reporter_email)\b/i);
    expect(acceptSummaryBody('Polarity mix is mostly positive across the current set.\n\nNegative themes cluster around low-severity "other" items.')).toBeNull();
    expect(acceptSummaryBody("The patient said they were unhappy and UHID 12345678 was involved.")).toBeNull();
    expect(acceptSummaryBody(
      "Polarity mix across the current feedback set is predominantly positive, with a smaller share of low-severity negative items.\n\nNegative themes cluster around teleconsult dissatisfaction signals. No high or critical severity items appear in the current roll-up.",
    )).toMatch(/Polarity mix/);
  });

  it("maps chip labels and stale detection from live counts", () => {
    expect(summaryChipLabel("flag_off")).toBe("Off");
    expect(summaryChipLabel("empty")).toBe("None yet");
    expect(summaryChipLabel("generating")).toBe("Generating");
    expect(summaryChipLabel("ready")).toBe("Ready");
    expect(summaryChipLabel("stale")).toBe("Stale");
    expect(summaryChipLabel("error")).toBe("Error");
    expect(summaryChipLabel("no_feedback")).toBe("None yet");

    expect(deriveSummaryState({
      featureEnabled: false,
      liveCount: 42,
      summary: null,
      newestFeedbackAt: null,
    }).state).toBe("flag_off");

    expect(deriveSummaryState({
      featureEnabled: true,
      liveCount: 0,
      summary: null,
      newestFeedbackAt: null,
    }).state).toBe("no_feedback");

    expect(deriveSummaryState({
      featureEnabled: true,
      liveCount: 42,
      summary: null,
      newestFeedbackAt: null,
    }).state).toBe("empty");

    expect(deriveSummaryState({
      featureEnabled: true,
      liveCount: 42,
      summary: { generated_at: "2026-09-12T11:10:00.000Z", feedback_count_at_gen: 42 },
      newestFeedbackAt: "2026-09-10T11:10:00.000Z",
    }).state).toBe("ready");

    expect(deriveSummaryState({
      featureEnabled: true,
      liveCount: 43,
      summary: { generated_at: "2026-09-12T11:10:00.000Z", feedback_count_at_gen: 42 },
      newestFeedbackAt: "2026-09-22T03:42:00.000Z",
    }).state).toBe("stale");

    expect(formatSummaryGeneratedIst("2026-09-12T11:10:00.000Z")).toMatch(/Sep 2026/);
    expect(formatSummaryGeneratedIst("2026-09-12T11:10:00.000Z")).toMatch(/IST/);
  });

  it("renders the seven panel states from the ratified mock contract", () => {
    const ready: SummaryServerPayload = {
      ok: true,
      feature_enabled: true,
      state: "ready",
      live_feedback_count: 42,
      newest_feedback_at: "2026-05-20T07:21:00.000Z",
      stale_detail: null,
      summary: {
        body: "Polarity mix across the current feedback set is predominantly positive.",
        generated_at: "2026-09-12T11:10:00.000Z",
        generated_ist: "12 Sep 2026, 16:40 IST",
        model_id: "gemini-3.8-flash",
        vertex_location: "global",
        vertex_project: "clinical-infra",
        feedback_count_at_gen: 42,
      },
    };

    expect(resolveSummaryView({
      server: { ...ready, feature_enabled: false, state: "flag_off", summary: null },
      phase: "idle",
    }).chip).toBe("Off");

    expect(resolveSummaryView({
      server: { ...ready, state: "empty", summary: null },
      phase: "idle",
    }).actions[0]?.label).toBe("Generate summary");

    expect(resolveSummaryView({ server: ready, phase: "generating" }).chip).toBe("Generating");
    expect(resolveSummaryView({ server: ready, phase: "idle" }).chip).toBe("Ready");

    const stale = resolveSummaryView({
      server: {
        ...ready,
        state: "stale",
        live_feedback_count: 43,
        stale_detail: { newer: true, count_increased: true },
      },
      phase: "idle",
    });
    expect(stale.chip).toBe("Stale");
    expect(stale.actions[0]?.variant).toBe("primary");
    expect(stale.showBody).toBe(true);

    expect(resolveSummaryView({ server: ready, phase: "error" }).chip).toBe("Error");
    expect(resolveSummaryView({
      server: { ...ready, state: "no_feedback", live_feedback_count: 0, summary: null },
      phase: "idle",
    }).actions[0]?.disabled).toBe(true);
  });

  it("refuses generate when the feature flag is off", async () => {
    const result = await generateThemeSummary(rows, "ENT", {
      FEATURE_VERTEX_SUMMARIES: "false",
      GOOGLE_VERTEX_PROJECT: "clinical-infra",
      GOOGLE_VERTEX_LOCATION: "global",
      GOOGLE_VERTEX_MODEL: "gemini-3.8-flash",
      VERTEX_CLIENT_EMAIL: FAKE_EMAIL,
      VERTEX_PRIVATE_KEY: FAKE_KEY,
    });
    expect(result).toEqual({ ok: false, code: "flag_off" });
  });

  it("keeps summary route authz staff-only and free of secrets in source", () => {
    const route = readFileSync(
      join(__dirname, "../../app/api/incidents/physician/[id]/summary/route.ts"),
      "utf8",
    );
    const access = readFileSync(join(__dirname, "../physician-summary/access.ts"), "utf8");
    expect(route).toContain("requireSummaryStaff");
    expect(access).toContain("is_sgc_member");
    expect(access).toContain("is_super_admin");
    expect(access).toMatch(/B7\.5/);
    expect(route).not.toContain("VERTEX_PRIVATE_KEY");
    expect(route).not.toContain("console.log");
    const generate = readFileSync(join(__dirname, "../physician-summary/generate.ts"), "utf8");
    expect(generate).toContain('import "server-only"');
    const prompt = readFileSync(join(__dirname, "../physician-summary/prompt.ts"), "utf8");
    expect(prompt).toMatch(/Do not include phone numbers, email addresses, UHID/);
    expect(prompt).not.toMatch(/SELECT .*narrative/i);
  });
});
