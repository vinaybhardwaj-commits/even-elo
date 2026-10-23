// Pure statistics for the CDMSS exhibits. Display-side only: the agent supplies counts, this derives intervals and
// the funnel limits so a chart never draws a number the tool did not return.

export const Z95 = 1.959964;
export const Z998 = 3.090232;

/** Wilson score interval for k of n. n = 0 gives null (no interval is honest). */
export function wilson(k: number, n: number, z = Z95): { lo: number; hi: number } | null {
  if (!(n > 0) || k < 0 || k > n) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/** Funnel limits around a reference proportion p0 at sample size n (plain binomial; `phi` widens by sqrt(phi)). */
export function funnelLimits(p0: number, n: number, z: number, phi = 1): { lo: number; hi: number } {
  const se = Math.sqrt((phi * p0 * (1 - p0)) / n);
  return { lo: Math.max(0, p0 - z * se), hi: Math.min(1, p0 + z * se) };
}

/** Two-sided p for a two-proportion z test (early vs late window). */
export function twoProportionP(k1: number, n1: number, k2: number, n2: number): number | null {
  if (!(n1 > 0) || !(n2 > 0)) return null;
  const p = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return 1;
  const z = Math.abs(k1 / n1 - k2 / n2) / se;
  return 2 * (1 - normalCdf(z));
}

function normalCdf(x: number): number {
  // Abramowitz-Stegun 7.1.26 on erf.
  const t = 1 / (1 + 0.3275911 * (x / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return 0.5 * (1 + y);
}

export type Change = "rising" | "falling" | "no clear change";

/** Spec rule 6: a direction only if p < 0.05 AND relative change >= 10%. */
export function changeVerdict(early: { k: number; n: number }, late: { k: number; n: number }): Change {
  const p = twoProportionP(early.k, early.n, late.k, late.n);
  if (p === null || early.k === 0) return "no clear change";
  const rel = (late.k / late.n - early.k / early.n) / (early.k / early.n);
  if (p < 0.05 && Math.abs(rel) >= 0.1) return rel > 0 ? "rising" : "falling";
  return "no clear change";
}

// Minimum-n rules (spec rule 4).
export const MIN_N = { doctor: 10, group: 15, funnel: 50 } as const;
export const meetsMinN = (kind: keyof typeof MIN_N, n: number) => n >= MIN_N[kind];

export const pct = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? "–" : `${(v * 100).toFixed(digits)}%`);

/** "about 3 in 10" */
export function plainFraction(p: number): string {
  if (!(p > 0)) return "none";
  if (p >= 0.95) return "nearly all";
  const x = Math.round(p * 10);
  return x === 0 ? "fewer than 1 in 10" : `about ${x} in 10`;
}
