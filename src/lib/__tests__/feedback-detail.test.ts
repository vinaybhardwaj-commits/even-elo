import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NO_FEEDBACK_COPY,
  SUMMARY_PANEL_SUBTITLE,
  SUMMARY_PANEL_TITLE,
  negativeActivityHint,
  positiveSourceHint,
  shortPhysicianId,
  timelineCategory,
} from "../feedback-detail";
import { deriveSummaryState, formatSummaryGeneratedIst, summaryChipLabel } from "../physician-summary/state";
import {
  acceptSummaryBody,
  buildPassAPrompt,
  buildPassBPrompt,
  buildSummaryPrompt,
  parseIncidentExtracts,
} from "../physician-summary/prompt";
import {
  aggregateFeedback,
  isThinNarrative,
  MAX_NEGATIVES_FOR_SUMMARY,
  negativesForSummary,
} from "../physician-summary/aggregate";
import { parseSummarySections } from "../physician-summary/sections";
import { resolveSummaryView, type SummaryServerPayload } from "../physician-summary/view";
import { generateRcaCapaSummary } from "../physician-summary/generate";

const FAKE_EMAIL = "vertex-spike@example.test";
const FAKE_KEY_BODY = "FAKEKEYMATERIALNOTREAL12";
const FAKE_KEY = `-----BEGIN PRIVATE KEY-----\n${FAKE_KEY_BODY}\n-----END PRIVATE KEY-----`;

function row(partial: Partial<{
  submitted_at: string;
  polarity: string;
  category: string | null;
  commendation_category: string | null;
  severity: string | null;
  status: string;
  source: string;
  patient_rating: number | null;
  narrative: string | null;
}> = {}) {
  return {
    submitted_at: "2026-05-20T07:21:00.000Z",
    polarity: "negative",
    category: "patient_safety",
    commendation_category: null as string | null,
    severity: "low",
    status: "open",
    source: "patient",
    patient_rating: null as number | null,
    narrative: "Delayed recognition of post-op wound infection after discharge.",
    ...partial,
  };
}

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
    expect(SUMMARY_PANEL_SUBTITLE).toMatch(/RCA/);
    expect(NO_FEEDBACK_COPY).toMatch(/No feedback on file/);
    expect(shortPhysicianId("162799b0-2517-40ad-8b8b-d5b34d6ace42")).toBe("162799b0…");
  });

  it("does not select narrative or PHI fields from the detail timeline route", () => {
    const root = join(__dirname, "..", "..");
    const route = readFileSync(join(root, "app/api/incidents/physician/[id]/route.ts"), "utf8");
    const view = readFileSync(join(root, "components/feedback/PhysicianFeedbackDetail.tsx"), "utf8");
    expect(route).not.toMatch(/\b(narrative|patient_ref|reporter_name|reporter_email|uhid)\b/i);
    expect(view).not.toMatch(/narrative_preview/);
    expect(view).toContain("/summary");
    expect(view).toMatch(/sections/);
  });
});

describe("physician summary RCA/CAPA prompts", () => {
  const rows = [
    row({
      submitted_at: "2026-05-20T07:21:00.000Z",
      polarity: "positive",
      category: null,
      commendation_category: "Patient Experience",
      severity: null,
      patient_rating: 5,
      narrative: "Clear explanations and thoughtful bedside manner throughout admission.",
    }),
    row({
      submitted_at: "2026-05-07T07:21:00.000Z",
      polarity: "negative",
      category: "other",
      severity: "low",
      narrative: "UNSATISFIED rating only, no written comment",
    }),
    row({
      submitted_at: "2026-09-03T07:21:00.000Z",
      polarity: "negative",
      category: "patient_safety",
      severity: "critical",
      source: "governance",
      narrative: "Missed escalation of deteriorating vitals overnight; family raised concern next morning.",
    }),
    row({
      submitted_at: "2026-01-01T00:00:00.000Z",
      polarity: "negative",
      category: "patient_safety",
      severity: "high",
      status: "retracted",
      source: "peer",
      narrative: "Should be ignored because retracted.",
    }),
  ];

  it("aggregates only enum labels and skips retracted rows", () => {
    const agg = aggregateFeedback(rows);
    expect(agg.feedback_count).toBe(3);
    expect(agg.positive).toBe(1);
    expect(agg.negative).toBe(2);
    expect(agg.by_category).toEqual({ other: 1, patient_safety: 1 });
    expect(agg.by_commendation).toEqual({ "Patient Experience": 1 });
    expect(agg.by_severity).toEqual({ critical: 1, low: 1 });
    expect(JSON.stringify(agg)).not.toMatch(/Missed escalation|UNSATISFIED/i);
  });

  it("flags thin narratives and caps newest negatives", () => {
    expect(isThinNarrative("UNSATISFIED rating only, no written comment")).toBe(true);
    expect(isThinNarrative("Missed escalation of deteriorating vitals overnight.")).toBe(false);
    expect(isThinNarrative("")).toBe(true);
    expect(isThinNarrative(null)).toBe(true);

    const many = Array.from({ length: 45 }, (_, i) =>
      row({
        submitted_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
        narrative: `Detailed clinical narrative number ${i} with enough length.`,
      }),
    );
    expect(negativesForSummary(many).length).toBe(MAX_NEGATIVES_FOR_SUMMARY);
  });

  it("builds Pass A/B prompts with narratives and rejects credential leaks", () => {
    const negatives = negativesForSummary(rows);
    const passA = buildPassAPrompt(negatives, "Orthopaedics");
    expect(passA.system).toMatch(/thin_narrative/);
    expect(passA.user).toMatch(/Missed escalation/);
    expect(passA.user).toMatch(/UNSATISFIED rating only/);
    expect(passA.user).toContain('"thin_narrative_hint": true');

    const extracts = parseIncidentExtracts(
      JSON.stringify([
        {
          index: 1,
          issue_theme: "Escalation delay",
          contributing_factors: ["Overnight monitoring gap"],
          thin_narrative: false,
          confidence: "high",
          notes: "Family concern next morning",
        },
        {
          index: 2,
          issue_theme: "Insufficient evidence",
          contributing_factors: [],
          thin_narrative: true,
          confidence: "low",
          notes: "Rating only",
        },
      ]),
      2,
    );
    expect(extracts[0].issue_theme).toMatch(/Escalation/);
    expect(extracts[1].thin_narrative).toBe(true);

    const passB = buildPassBPrompt({
      extracts,
      specialty: "Orthopaedics",
      aggregate: aggregateFeedback(rows),
      positiveThemes: [
        {
          commendation: "Patient Experience",
          submitted_month: "2026-05",
          narrative: "Clear explanations",
          thin_narrative_hint: false,
        },
      ],
    });
    expect(passB.system).toMatch(/CAPA — Corrective/);
    expect(passB.system).toMatch(/Never write CAPA for positives/);
    expect(passB.user).toContain("Escalation delay");

    expect(() => buildSummaryPrompt(aggregateFeedback(rows), "ENT")).toThrow(/THEME_SUMMARY_REMOVED/);

    expect(acceptSummaryBody('Polarity mix with "quoted theme" and enough length to pass the minimum body check for staff summaries.')).toMatch(/quoted theme/);
    expect(acceptSummaryBody("short")).toBeNull();
    expect(acceptSummaryBody(
      "## Pattern\nThemes across negatives.\n\n## Provisional RCA\nInsufficient evidence for thin items.\n\n## CAPA — Corrective\nNone until evidence improves.\n\n## CAPA — Preventive\nNone.\n\n## Positive recognition\nNone noted.\n\n## Open / insufficient evidence\nRating-only row.\n-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----",
    )).toBeNull();
  });

  it("parses Pattern / RCA / CAPA / Open sections for the aside", () => {
    const body = [
      "## Pattern",
      "Two patient-safety negatives in orthopaedics.",
      "",
      "## Provisional RCA",
      "Escalation delay overnight; one thin rating-only row.",
      "",
      "## CAPA — Corrective",
      "Review overnight escalation pathway with the unit.",
      "",
      "## CAPA — Preventive",
      "Add checklist trigger for family-raised concerns.",
      "",
      "## Positive recognition",
      "Patient Experience themes present.",
      "",
      "## Open / insufficient evidence",
      "Rating-only negative — do not invent a root cause.",
    ].join("\n");
    const sections = parseSummarySections(body);
    expect(sections?.map((s) => s.title)).toEqual([
      "Pattern",
      "Provisional RCA",
      "CAPA — Corrective",
      "CAPA — Preventive",
      "Positive recognition",
      "Open / insufficient evidence",
    ]);
    expect(parseSummarySections("Polarity mix across the current feedback set is predominantly positive.")).toBeNull();
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

  it("renders panel states and surfaces structured sections + stored model id", () => {
    const rcaBody = [
      "## Pattern",
      "Patient-safety cluster.",
      "",
      "## Provisional RCA",
      "Escalation delay.",
      "",
      "## CAPA — Corrective",
      "Unit review.",
      "",
      "## CAPA — Preventive",
      "Pathway checklist.",
      "",
      "## Positive recognition",
      "None noted.",
      "",
      "## Open / insufficient evidence",
      "One thin rating-only row.",
    ].join("\n");

    const ready: SummaryServerPayload = {
      ok: true,
      feature_enabled: true,
      state: "ready",
      live_feedback_count: 42,
      newest_feedback_at: "2026-05-20T07:21:00.000Z",
      stale_detail: null,
      summary: {
        body: rcaBody,
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

    const empty = resolveSummaryView({
      server: { ...ready, state: "empty", summary: null },
      phase: "idle",
    });
    expect(empty.actions[0]?.label).toBe("Generate summary");
    expect(empty.gatedBody).toMatch(/RCA/);

    expect(resolveSummaryView({ server: ready, phase: "generating" }).chip).toBe("Generating");
    const readyView = resolveSummaryView({ server: ready, phase: "idle" });
    expect(readyView.chip).toBe("Ready");
    expect(readyView.meta?.model).toBe("gemini-3.8-flash");
    expect(readyView.sections?.[0]?.title).toBe("Pattern");
    expect(readyView.footnote).toMatch(/CAPA/);

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
    expect(stale.sections?.length).toBeGreaterThan(0);

    expect(resolveSummaryView({ server: ready, phase: "error" }).chip).toBe("Error");
    expect(resolveSummaryView({
      server: { ...ready, state: "no_feedback", live_feedback_count: 0, summary: null },
      phase: "idle",
    }).actions[0]?.disabled).toBe(true);
  });

  it("refuses generate when the feature flag is off", async () => {
    const result = await generateRcaCapaSummary(rows, "ENT", {
      FEATURE_VERTEX_SUMMARIES: "false",
      GOOGLE_VERTEX_PROJECT: "clinical-infra",
      GOOGLE_VERTEX_LOCATION: "global",
      GOOGLE_VERTEX_MODEL: "gemini-3.8-flash",
      VERTEX_CLIENT_EMAIL: FAKE_EMAIL,
      VERTEX_PRIVATE_KEY: FAKE_KEY,
    });
    expect(result).toEqual({ ok: false, code: "flag_off" });
  });

  it("keeps summary route authz staff-only and uses narrative RCA path", () => {
    const route = readFileSync(
      join(__dirname, "../../app/api/incidents/physician/[id]/summary/route.ts"),
      "utf8",
    );
    const access = readFileSync(join(__dirname, "../physician-summary/access.ts"), "utf8");
    expect(route).toContain("requireSummaryStaff");
    expect(route).toContain("generateRcaCapaSummary");
    expect(route).toContain("maxDuration = 300");
    expect(access).toContain("is_sgc_member");
    expect(access).toContain("is_super_admin");
    expect(access).toMatch(/B7\.5/);
    expect(access).toMatch(/i\.narrative/);
    expect(route).not.toContain("VERTEX_PRIVATE_KEY");
    expect(route).not.toContain("console.log");
    const generate = readFileSync(join(__dirname, "../physician-summary/generate.ts"), "utf8");
    expect(generate).toContain('import "server-only"');
    expect(generate).toContain("generateRcaCapaSummary");
    expect(generate).not.toMatch(/aggregates only/i);
    const prompt = readFileSync(join(__dirname, "../physician-summary/prompt.ts"), "utf8");
    expect(prompt).toMatch(/Never reproduce private keys/);
    expect(prompt).not.toMatch(/You receive only aggregate counts/);
    expect(prompt).toMatch(/THEME_SUMMARY_REMOVED/);
  });
});
