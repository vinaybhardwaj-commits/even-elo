import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADHERENCE_LABEL,
  LAB_EHRC_COHORT,
  OPD_STALE_AFTER_DAYS,
  adherencePresentation,
  buildOverviewModel,
  documentAuditVolume,
  eloIsProductionEmpty,
  opdIsStale,
  outcomesLabContext,
  shellBadgeModel,
  type Stage2DbCounts,
} from "../overview-modules";

function db(partial: Partial<Stage2DbCounts> = {}): Stage2DbCounts {
  return {
    physiciansActive: 265,
    physiciansRoster: 266,
    engagementsActive: 271,
    positionsActive: 14,
    feedbackTotal: 207,
    feedbackPositive: 134,
    feedbackOpenNegative: 73,
    physiciansWithFeedback: 35,
    elo: { vcs: 0, cases: 0, snapshots: 0, observationCases: 0 },
    opdLastDay: "2026-07-02",
    opdAgeDays: 82,
    ...partial,
  };
}

describe("overview honesty", () => {
  it("never assigns a Document Audits or RMO volume", () => {
    expect(documentAuditVolume()).toBeNull();
    const model = buildOverviewModel(db(), { open: 5, total: 5, highSev: 4, withRca: 2, overdue: 3 });
    const audits = model.tiles.find((t) => t.id === "document-audits");
    const rmo = model.tiles.find((t) => t.id === "rmo");
    expect(audits?.volume).toBeNull();
    expect(audits?.href).toBeNull();
    expect(audits?.chip).toBe("proposed");
    expect(audits?.body.toLowerCase()).not.toMatch(/\d+\s+audits/);
    expect(rmo?.volume).toBeNull();
    expect(rmo?.href).toBeNull();
    expect(rmo?.chip).toBe("proposed");
    expect(model.headline.map((h) => h.label).join(" ")).not.toMatch(/document audit/i);
  });

  it("labels an old OPD snapshot Stale and a fresh one Live", () => {
    expect(opdIsStale(82)).toBe(true);
    expect(opdIsStale(OPD_STALE_AFTER_DAYS)).toBe(false);
    expect(opdIsStale(OPD_STALE_AFTER_DAYS + 1)).toBe(true);
    expect(opdIsStale(null)).toBe(true);

    const stale = buildOverviewModel(db({ opdLastDay: "2026-07-02", opdAgeDays: 82 }));
    expect(stale.tiles.find((t) => t.id === "opd")?.chip).toBe("stale");
    expect(stale.tiles.find((t) => t.id === "opd")?.body).toContain("2026-07-02");

    const fresh = buildOverviewModel(db({ opdLastDay: "2026-09-21", opdAgeDays: 1 }));
    expect(fresh.tiles.find((t) => t.id === "opd")?.chip).toBe("live");
    expect(fresh.opd.stale).toBe(false);
  });

  it("sends Patient Feedback to /incidents and keeps e-IRIS separate", () => {
    const model = buildOverviewModel(
      db(),
      { open: 5, total: 5, highSev: 4, withRca: 2, overdue: null },
      { canOpenElo: true, canOpenSafety: true },
    );
    const feedback = model.tiles.find((t) => t.id === "feedback");
    const iris = model.tiles.find((t) => t.id === "e-iris");
    expect(feedback?.href).toBe("/incidents");
    expect(feedback?.body).toContain("207");
    expect(feedback?.body).toContain("73");
    expect(feedback?.body).toContain("35");
    expect(iris?.href).toBe("/safety");
    expect(iris?.id).not.toBe(feedback?.id);
    expect(iris?.body).toContain("Separate from physician feedback");
    expect(iris?.body).toContain("5 open");
    expect(iris?.body).not.toContain("207");
    expect(model.tiles.find((t) => t.id === "safety-report")?.href).toBe("/safety/report");
  });

  it("uses queried ELO zeros and switches the chip when a real count appears", () => {
    const empty = buildOverviewModel(db(), undefined, { canOpenElo: true, canOpenSafety: false });
    const elo = empty.tiles.find((t) => t.id === "surgical-elo");
    expect(eloIsProductionEmpty({ vcs: 0, cases: 0, snapshots: 0 })).toBe(true);
    expect(elo?.chip).toBe("empty");
    expect(elo?.body).toContain("0 VCs");
    expect(elo?.body).toContain("0 surgical cases");
    expect(elo?.body).toContain("0 score snapshots");
    expect(elo?.href).toBe("/surgical-governance");
    expect(empty.headline.find((h) => h.label.startsWith("Surgical ELO"))?.value).toBe("0");

    const live = buildOverviewModel(
      db({ elo: { vcs: 2, cases: 4, snapshots: 1, observationCases: 3 } }),
      undefined,
      { canOpenElo: false, canOpenSafety: false },
    );
    const liveTile = live.tiles.find((t) => t.id === "surgical-elo");
    expect(liveTile?.chip).toBe("live");
    expect(liveTile?.volume).toBe(2);
    expect(liveTile?.href).toBeNull();
    expect(live.headline.find((h) => h.label.startsWith("Surgical ELO"))?.value).toBe("2");
    expect(live.headline.find((h) => h.label.startsWith("Surgical ELO"))?.hint).toBe("4 cases · 1 snapshots");
  });

  it("omits volumes when the database counts are unavailable", () => {
    const model = buildOverviewModel(null, { open: null, total: null, highSev: null, withRca: null, overdue: null });
    expect(model.countsAvailable).toBe(false);
    expect(model.headline.find((h) => h.label.startsWith("Surgical ELO"))?.value).toBe("—");
    expect(model.tiles.find((t) => t.id === "document-audits")?.volume).toBeNull();
    expect(model.tiles.find((t) => t.id === "feedback")?.body).toContain("could not be read");
    expect(model.banner).toContain("not shown");
  });

  it("does not query M&M into a volume", () => {
    const tile = buildOverviewModel(db()).tiles.find((t) => t.id === "mm");
    expect(tile?.chip).toBe("not_loaded");
    expect(tile?.volume).toBeNull();
    expect(tile?.body).toContain("not queried");
  });
});

describe("shell badges", () => {
  it("keeps proposed surfaces volumeless and reflects live OPD / ELO", () => {
    const badges = shellBadgeModel(db());
    expect(badges.documentAudits).toEqual({ chip: "proposed", volume: null });
    expect(badges.rmo.volume).toBeNull();
    expect(badges.opd).toEqual({ stale: true, lastDay: "2026-07-02" });
    expect(badges.elo).toEqual({ empty: true, vcs: 0, cases: 0, snapshots: 0 });

    const fresh = shellBadgeModel(db({ opdAgeDays: 0, opdLastDay: "2026-09-22", elo: { vcs: 1, cases: 0, snapshots: 0, observationCases: 0 } }));
    expect(fresh.opd?.stale).toBe(false);
    expect(fresh.elo?.empty).toBe(false);
    expect(shellBadgeModel(null).elo).toBeNull();
    expect(shellBadgeModel(null).opd).toBeNull();
  });
});

describe("surgical elo honesty", () => {
  it("keeps adherence as awaiting inputs with no percent", () => {
    const adherence = adherencePresentation();
    expect(adherence.state).toBe("awaiting_inputs");
    expect(adherence.label).toBe(ADHERENCE_LABEL);
    expect(adherence.percent).toBeNull();
    expect(adherence.label).not.toContain("%");
  });

  it("surfaces the Lab cohort as context and not an ELO score", () => {
    const outcomes = outcomesLabContext();
    expect(outcomes.kind).toBe("lab_context");
    expect(outcomes.stays).toBe(LAB_EHRC_COHORT.stays);
    expect(outcomes.eloScore).toBeNull();
    expect(outcomes.label).toMatch(/Lab/);
  });

  it("does not mount score charts on the empty surface", () => {
    const src = readFileSync(join(__dirname, "../../components/surgical/SurgicalEloEmpty.tsx"), "utf8");
    expect(src).not.toContain("ScoreBar");
    expect(src).not.toContain("TierDistributionBar");
    expect(src).toContain("adherencePresentation");
    expect(src).toContain("awaiting inputs");
    expect(src).toContain("not a Surgical ELO score");
    expect(src).not.toContain("patient_name");
  });

  it("treats any real VC, case, or snapshot as no longer production-empty", () => {
    expect(eloIsProductionEmpty({ vcs: 0, cases: 0, snapshots: 0 })).toBe(true);
    expect(eloIsProductionEmpty({ vcs: 1, cases: 0, snapshots: 0 })).toBe(false);
    expect(eloIsProductionEmpty({ vcs: 0, cases: 1, snapshots: 0 })).toBe(false);
    expect(eloIsProductionEmpty({ vcs: 0, cases: 0, snapshots: 1 })).toBe(false);
  });
});
