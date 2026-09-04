/**
 * Pure recency-decay helpers shared by the risk engine.
 *
 * We use exponential decay so that recent events dominate the score while older
 * events fade but never vanish abruptly. This keeps scoring smooth, transparent
 * and deterministic. No I/O.
 */

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** Number of days between two ISO timestamps (a >= b yields a positive value). */
export function daysBetween(laterIso: string, earlierIso: string): number {
  const later = Date.parse(laterIso);
  const earlier = Date.parse(earlierIso);
  return (later - earlier) / MS_PER_DAY;
}

/**
 * Exponential recency weight in (0, 1]. An event `ageDays` old is weighted
 * `0.5 ^ (ageDays / halfLifeDays)`. At age 0 the weight is 1; at one half-life
 * it is 0.5, and so on. Negative ages (future) are clamped to weight 1.
 */
export function recencyWeight(ageDays: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 1;
  if (ageDays <= 0) return 1;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/** Clamp a number into an inclusive range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Round to a fixed number of decimals for stable, readable output. */
export function round(value: number, decimals = 2): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
