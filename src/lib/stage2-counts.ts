import { sql } from "@/lib/db";
import type { EloCounts, Stage2DbCounts } from "@/lib/overview-modules";

interface CountRow {
  physicians_active: number;
  physicians_roster: number;
  engagements_active: number;
  positions_active: number;
  feedback_total: number;
  feedback_positive: number;
  feedback_open_negative: number;
  physicians_with_feedback: number;
  elo_vcs: number;
  elo_cases: number;
  elo_snapshots: number;
  elo_observation_cases: number;
  opd_last_day: string | null;
  opd_age_days: number | null;
}

function asElo(row: CountRow): EloCounts {
  return {
    vcs: row.elo_vcs,
    cases: row.elo_cases,
    snapshots: row.elo_snapshots,
    observationCases: row.elo_observation_cases,
  };
}

/**
 * Live Overview / Surgical ELO counts. Returns null when the database cannot
 * be read so callers omit volumes instead of substituting zeros.
 */
export async function loadStage2Counts(): Promise<Stage2DbCounts | null> {
  try {
    const rows = (await sql`
      SELECT
        (SELECT count(*)::int FROM physicians WHERE current_status = 'active') AS physicians_active,
        (SELECT count(*)::int FROM physicians) AS physicians_roster,
        (SELECT count(*)::int FROM physician_engagements WHERE status = 'active') AS engagements_active,
        (SELECT count(*)::int FROM positions WHERE active = true) AS positions_active,
        (SELECT count(*)::int FROM incidents) AS feedback_total,
        (SELECT count(*)::int FROM incidents WHERE polarity = 'positive') AS feedback_positive,
        (SELECT count(*)::int FROM incidents WHERE status = 'open' AND polarity = 'negative') AS feedback_open_negative,
        (SELECT count(DISTINCT target_physician_id)::int FROM incidents) AS physicians_with_feedback,
        (SELECT count(*)::int FROM vcs) AS elo_vcs,
        (SELECT count(*)::int FROM surgical_cases) AS elo_cases,
        (SELECT count(*)::int FROM score_snapshots) AS elo_snapshots,
        (SELECT count(*)::int FROM vc_observation_cases) AS elo_observation_cases,
        (SELECT max(day)::text FROM gov_signal_snapshots WHERE source = 'cdmss_opd') AS opd_last_day,
        (SELECT (current_date - max(day))::int FROM gov_signal_snapshots WHERE source = 'cdmss_opd') AS opd_age_days
    `) as unknown as CountRow[];
    const row = rows[0];
    if (!row) return null;
    return {
      physiciansActive: row.physicians_active,
      physiciansRoster: row.physicians_roster,
      engagementsActive: row.engagements_active,
      positionsActive: row.positions_active,
      feedbackTotal: row.feedback_total,
      feedbackPositive: row.feedback_positive,
      feedbackOpenNegative: row.feedback_open_negative,
      physiciansWithFeedback: row.physicians_with_feedback,
      elo: asElo(row),
      opdLastDay: row.opd_last_day,
      opdAgeDays: row.opd_age_days,
    };
  } catch {
    return null;
  }
}

export async function loadEloCounts(): Promise<EloCounts | null> {
  const all = await loadStage2Counts();
  return all ? all.elo : null;
}
