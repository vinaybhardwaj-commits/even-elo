/**
 * Sprint 2.1 / 2.2 — Overview tiles and Surgical ELO honesty.
 *
 * Pure shaping only. Callers pass queried counts. This module never invents
 * Document Audits volumes or Surgical ELO scores.
 */

/** Last OPD snapshot older than this (calendar days) is labeled Stale. */
export const OPD_STALE_AFTER_DAYS = 14;

/**
 * Lab / warehouse context from the ratified Sprint 2.2 mock (EHRC cohort,
 * locked ~1 Sep 2026). This is not a Surgical ELO score and is not read
 * from score_snapshots.
 */
export const LAB_EHRC_COHORT = {
  kind: "lab_context" as const,
  label: "Lab Bot EHRC cohort",
  stays: 129,
  lockedNote: "locked ~1 Sep 2026",
};

export const ADHERENCE_STATE = "awaiting_inputs" as const;
export const ADHERENCE_LABEL = "Awaiting inputs";

export interface EloCounts {
  vcs: number;
  cases: number;
  snapshots: number;
  observationCases: number;
}

export interface IrisCounts {
  open: number | null;
  total: number | null;
  highSev: number | null;
  withRca: number | null;
  overdue: number | null;
}

export interface Stage2DbCounts {
  physiciansActive: number;
  physiciansRoster: number;
  engagementsActive: number;
  positionsActive: number;
  feedbackTotal: number;
  feedbackPositive: number;
  feedbackOpenNegative: number;
  physiciansWithFeedback: number;
  elo: EloCounts;
  opdLastDay: string | null;
  opdAgeDays: number | null;
}

export type TileChip = "live" | "proposed" | "stale" | "empty" | "partial" | "not_loaded" | "live_route";

export interface ModuleTile {
  id: string;
  group: "people" | "clinical" | "safety";
  title: string;
  chip: TileChip;
  chipLabel: string;
  body: string;
  meta: string;
  href: string | null;
  /** Set only for live queried modules. Document Audits and RMO stay null. */
  volume: number | null;
}

export interface HeadlineItem {
  label: string;
  value: string;
  hint: string;
  tone: "default" | "danger" | "muted";
}

export interface OverviewViewModel {
  countsAvailable: boolean;
  headline: HeadlineItem[];
  tiles: ModuleTile[];
  banner: string;
  opd: { stale: boolean; lastDay: string | null };
  eloEmpty: boolean;
}

export interface OverviewAccess {
  canOpenElo: boolean;
  canOpenSafety: boolean;
}

const EMPTY_IRIS: IrisCounts = {
  open: null,
  total: null,
  highSev: null,
  withRca: null,
  overdue: null,
};

/** Document Audits has no ingest. The volume is structurally absent. */
export function documentAuditVolume(): null {
  return null;
}

export function eloIsProductionEmpty(counts: Pick<EloCounts, "vcs" | "cases" | "snapshots">): boolean {
  return counts.vcs === 0 && counts.cases === 0 && counts.snapshots === 0;
}

export function opdIsStale(ageDays: number | null, staleAfterDays = OPD_STALE_AFTER_DAYS): boolean {
  if (ageDays === null || !Number.isFinite(ageDays)) return true;
  return ageDays > staleAfterDays;
}

export function adherencePresentation(): { state: typeof ADHERENCE_STATE; label: string; percent: null } {
  return { state: ADHERENCE_STATE, label: ADHERENCE_LABEL, percent: null };
}

/** Outcomes copy for the empty ELO surface. Never an ELO score. */
export function outcomesLabContext(): {
  kind: "lab_context";
  stays: number;
  label: string;
  lockedNote: string;
  eloScore: null;
} {
  return {
    kind: LAB_EHRC_COHORT.kind,
    stays: LAB_EHRC_COHORT.stays,
    label: LAB_EHRC_COHORT.label,
    lockedNote: LAB_EHRC_COHORT.lockedNote,
    eloScore: null,
  };
}

function n(value: number): string {
  return String(value);
}

function irisHint(iris: IrisCounts): string {
  const parts: string[] = [];
  if (iris.total !== null) parts.push(`${iris.total} total`);
  if (iris.highSev !== null) parts.push(`${iris.highSev} high-sev`);
  if (iris.withRca !== null) parts.push(`${iris.withRca} with RCA`);
  if (iris.overdue !== null) parts.push(`${iris.overdue} overdue`);
  parts.push("LIVE");
  return parts.join(" · ");
}

function irisBody(iris: IrisCounts): string {
  if (iris.open === null && iris.total === null) {
    return "Hospital incident module. Separate from physician feedback. Live e-IRIS totals were not returned.";
  }
  const bits: string[] = [];
  if (iris.open !== null) bits.push(`${iris.open} open`);
  if (iris.highSev !== null) bits.push(`${iris.highSev} high severity`);
  if (iris.overdue !== null) bits.push(`${iris.overdue} overdue`);
  if (iris.withRca !== null) bits.push(`${iris.withRca} with RCA`);
  return `${bits.join(" · ")}. Separate from physician feedback.`;
}

function eloBody(elo: EloCounts): string {
  return `${elo.vcs} VCs · ${elo.cases} surgical cases · ${elo.snapshots} score snapshots. Adherence awaiting inputs.`;
}

export function buildOverviewModel(
  db: Stage2DbCounts | null,
  iris: IrisCounts = EMPTY_IRIS,
  access: OverviewAccess = { canOpenElo: false, canOpenSafety: false },
): OverviewViewModel {
  const auditVolume = documentAuditVolume();
  const opdStale = db ? opdIsStale(db.opdAgeDays) : true;
  const eloEmpty = db ? eloIsProductionEmpty(db.elo) : false;

  const headline: HeadlineItem[] = db
    ? [
        {
          label: "Physicians active",
          value: n(db.physiciansActive),
          hint: `LIVE · EPI · of ${db.physiciansRoster} roster`,
          tone: "default",
        },
        {
          label: "Engagements active",
          value: n(db.engagementsActive),
          hint: "LIVE · EPI",
          tone: "default",
        },
        {
          label: "Open negative feedback",
          value: n(db.feedbackOpenNegative),
          hint: `of ${db.feedbackTotal} total · LIVE`,
          tone: db.feedbackOpenNegative > 0 ? "danger" : "default",
        },
        {
          label: "e-IRIS open",
          value: iris.open === null ? "—" : n(iris.open),
          hint: iris.open === null ? "Not returned · separate from feedback" : irisHint(iris),
          tone: (iris.open ?? 0) > 0 ? "danger" : "default",
        },
        {
          label: "Surgical ELO · VCs",
          value: n(db.elo.vcs),
          hint: `${db.elo.cases} cases · ${db.elo.snapshots} snapshots`,
          tone: eloEmpty ? "muted" : "default",
        },
        {
          label: "Positions active",
          value: n(db.positionsActive),
          hint: "LIVE · EPI",
          tone: "default",
        },
      ]
    : [
        { label: "Physicians active", value: "—", hint: "Counts unavailable", tone: "muted" },
        { label: "Engagements active", value: "—", hint: "Counts unavailable", tone: "muted" },
        { label: "Open negative feedback", value: "—", hint: "Counts unavailable", tone: "muted" },
        { label: "e-IRIS open", value: iris.open === null ? "—" : n(iris.open), hint: iris.open === null ? "Not returned" : irisHint(iris), tone: "muted" },
        { label: "Surgical ELO · VCs", value: "—", hint: "Volumes not shown", tone: "muted" },
        { label: "Positions active", value: "—", hint: "Counts unavailable", tone: "muted" },
      ];

  const opdBody = !db
    ? "OPD snapshot day could not be read. No act-now volume is shown."
    : db.opdLastDay
      ? `Last gov_signal_snapshots day: ${db.opdLastDay} (source cdmss_opd). ${opdStale ? "Stale vs today." : "Within the freshness window."}`
      : "No OPD snapshot is stored. Labeled Stale — no act-now volume is invented.";

  const feedbackBody = db
    ? `${db.feedbackTotal} total · ${db.feedbackOpenNegative} open negative · ${db.feedbackPositive} positive · ${db.physiciansWithFeedback} physicians with feedback (grouped home).`
    : "Live feedback counts could not be read. Open the grouped home — volumes are not invented here.";

  const tiles: ModuleTile[] = [
    {
      id: "physicians",
      group: "people",
      title: "Physicians",
      chip: "live",
      chipLabel: "Live",
      body: db
        ? `${db.physiciansActive} active · ${db.physiciansRoster} roster · specialty mix across the network.`
        : "Roster counts unavailable.",
      meta: "Open roster →",
      href: "/physicians",
      volume: db ? db.physiciansActive : null,
    },
    {
      id: "credentialing",
      group: "people",
      title: "Credentialing",
      chip: "partial",
      chipLabel: "Partial",
      body: "Qualifications are live. Pending and expiry workqueues are not spotlighted on this Overview.",
      meta: "Open credentialing →",
      href: "/onboarding",
      volume: null,
    },
    {
      id: "document-audits",
      group: "clinical",
      title: "Document Audits",
      chip: "proposed",
      chipLabel: "Proposed",
      body: "Progress / OT / Discharge shell. CDMSS ingest is not live — no audit volumes are shown.",
      meta: "Awaiting Stage 4 ingest",
      href: null,
      volume: auditVolume,
    },
    {
      id: "opd",
      group: "clinical",
      title: "OPD Governance",
      chip: opdStale ? "stale" : "live",
      chipLabel: opdStale ? "Stale" : "Live",
      body: opdBody,
      meta: "View last snapshot →",
      href: "/opd-governance",
      volume: null,
    },
    {
      id: "rmo",
      group: "clinical",
      title: "RMO Inbox",
      chip: "proposed",
      chipLabel: "Proposed",
      body: "RMO workqueue for document-audit follow-ups. Empty until Stage 4 assignments exist.",
      meta: "Proposed — no assignments yet",
      href: null,
      volume: null,
    },
    {
      id: "surgical-elo",
      group: "clinical",
      title: "Surgical ELO",
      chip: !db ? "empty" : eloEmpty ? "empty" : "live",
      chipLabel: !db ? "Unavailable" : eloEmpty ? "Empty" : "Live",
      body: db ? eloBody(db.elo) : "Counts unavailable — VC, case, and snapshot volumes are not shown.",
      meta: access.canOpenElo ? "View Surgical ELO →" : "Super admin",
      href: access.canOpenElo ? "/surgical-governance" : null,
      volume: db ? db.elo.vcs : null,
    },
    {
      id: "mm",
      group: "clinical",
      title: "M&M",
      chip: "not_loaded",
      chipLabel: "Not loaded",
      body: "SGC / super module — counts are not queried for this Overview.",
      meta: access.canOpenSafety ? "Open M&M →" : "SGC / super",
      href: access.canOpenSafety ? "/mm" : null,
      volume: null,
    },
    {
      id: "feedback",
      group: "safety",
      title: "Patient Feedback",
      chip: "live",
      chipLabel: "Live",
      body: feedbackBody,
      meta: "Open grouped Feedback →",
      href: "/incidents",
      volume: db ? db.feedbackTotal : null,
    },
    {
      id: "e-iris",
      group: "safety",
      title: "Incidents (e-IRIS)",
      chip: "live",
      chipLabel: "Live",
      body: irisBody(iris),
      meta: access.canOpenSafety ? "Open e-IRIS →" : "SGC / super",
      href: access.canOpenSafety ? "/safety" : null,
      volume: iris.open,
    },
    {
      id: "safety-report",
      group: "safety",
      title: "Safety Report",
      chip: "live_route",
      chipLabel: "Live route",
      body: "Report an incident (SGC). Separate from physician feedback.",
      meta: access.canOpenSafety ? "Open report →" : "SGC / super",
      href: access.canOpenSafety ? "/safety/report" : null,
      volume: null,
    },
  ];

  const banner = db
    ? `Document Audits and RMO Inbox stay Proposed (no invented volumes). Surgical ELO is ${db.elo.vcs} / ${db.elo.cases} / ${db.elo.snapshots}. OPD last snapshot day ${db.opdLastDay ?? "none"} — ${opdStale ? "labeled Stale" : "current"}. Patient Feedback uses live ${db.feedbackTotal} / ${db.feedbackOpenNegative} open negative / ${db.feedbackPositive} positive / ${db.physiciansWithFeedback} physicians with feedback.`
    : "Live database counts could not be read. Document Audits, RMO, and Surgical ELO volumes are not shown.";

  return {
    countsAvailable: db !== null,
    headline,
    tiles,
    banner,
    opd: { stale: opdStale, lastDay: db?.opdLastDay ?? null },
    eloEmpty,
  };
}

export function shellBadgeModel(db: Stage2DbCounts | null): {
  opd: { stale: boolean; lastDay: string | null } | null;
  elo: { empty: boolean; vcs: number; cases: number; snapshots: number } | null;
  documentAudits: { chip: "proposed"; volume: null };
  rmo: { chip: "proposed"; volume: null };
} {
  return {
    documentAudits: { chip: "proposed", volume: documentAuditVolume() },
    rmo: { chip: "proposed", volume: null },
    opd: db ? { stale: opdIsStale(db.opdAgeDays), lastDay: db.opdLastDay } : null,
    elo: db
      ? {
          empty: eloIsProductionEmpty(db.elo),
          vcs: db.elo.vcs,
          cases: db.elo.cases,
          snapshots: db.elo.snapshots,
        }
      : null,
  };
}
