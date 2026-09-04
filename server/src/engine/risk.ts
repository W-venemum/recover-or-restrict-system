/**
 * Weighted, recency-decayed risk / trust scoring.
 *
 * Pure function. Produces a 0..100 risk score, a band, a confidence and a set
 * of human-readable {@link Evidence} entries. This is NOT a raw event counter:
 * each signal contributes a weighted amount that decays exponentially with age,
 * so recent behaviour dominates and a single old/transient failure barely
 * moves the score.
 */

import type { Evidence, RiskBand, RiskResult } from "../domain/types.js";
import { clamp, recencyWeight, round } from "./decay.js";

/**
 * A single dated signal fed into the risk model. `at` is an ISO timestamp; the
 * engine decays each signal relative to `asOf`. Callers derive these from raw
 * payment/behavioural events (done in engine/index.ts), keeping this function
 * pure and free of event-parsing concerns.
 */
export interface RiskSignal {
  kind: RiskSignalKind;
  at: string;
  /**
   * Optional magnitude multiplier for the signal (default 1). E.g. a large
   * unpaid renewal amount could weigh slightly more.
   */
  magnitude?: number;
}

export type RiskSignalKind =
  | "failed_payment"
  | "successful_payment"
  | "autopay_cancelled"
  | "cancellation_near_renewal"
  | "unpaid_renewal"
  | "usage_during_unpaid_period"
  | "cancel_resubscribe_cycle"
  | "recovery_success"
  | "recovery_failure";

export interface RiskInput {
  signals: RiskSignal[];
  /** ISO timestamp the evaluation is anchored to (usually "now"). */
  asOf: string;
  /** Subscription tenure in days; longer tenure lowers risk (trust credit). */
  tenureDays: number;
}

/** Half-life (days) controlling how quickly a signal's weight decays. */
const HALF_LIFE_DAYS = 30;

/**
 * Base weights per signal kind. Positive raises risk, negative lowers it.
 * Chosen so that a single transient failure (small positive) cannot alone push
 * a customer past the low band, while repeated avoidance stacks quickly.
 */
const BASE_WEIGHTS: Record<RiskSignalKind, number> = {
  failed_payment: 6,
  successful_payment: -5,
  autopay_cancelled: 8,
  cancellation_near_renewal: 12,
  unpaid_renewal: 14,
  usage_during_unpaid_period: 16,
  cancel_resubscribe_cycle: 18,
  recovery_success: -8,
  recovery_failure: 10,
};

const SIGNAL_LABELS: Record<RiskSignalKind, string> = {
  failed_payment: "failed payment",
  successful_payment: "successful payment",
  autopay_cancelled: "autopay cancellation",
  cancellation_near_renewal: "cancellation close to renewal",
  unpaid_renewal: "unpaid renewal",
  usage_during_unpaid_period: "usage during an unpaid/grace period",
  cancel_resubscribe_cycle: "cancel-then-resubscribe cycle",
  recovery_success: "successful recovery",
  recovery_failure: "failed recovery attempt",
};

function bandFor(score: number): RiskBand {
  if (score >= 66) return "high";
  if (score >= 33) return "medium";
  return "low";
}

/**
 * Compute a weighted, recency-decayed risk score with confidence + evidence.
 */
export function computeRiskScore(input: RiskInput): RiskResult {
  const evidence: Evidence[] = [];

  // Aggregate weighted, decayed contributions grouped by signal kind so the
  // evidence stays compact and readable.
  const grouped = new Map<
    RiskSignalKind,
    { count: number; weighted: number; mostRecentAgeDays: number }
  >();

  let totalWeighted = 0;
  let effectiveObservations = 0;

  for (const signal of input.signals) {
    const ageDays = daysAgo(input.asOf, signal.at);
    const recency = recencyWeight(ageDays, HALF_LIFE_DAYS);
    const magnitude = signal.magnitude ?? 1;
    const contribution = BASE_WEIGHTS[signal.kind] * recency * magnitude;

    totalWeighted += contribution;
    effectiveObservations += recency;

    const g = grouped.get(signal.kind) ?? {
      count: 0,
      weighted: 0,
      mostRecentAgeDays: Number.POSITIVE_INFINITY,
    };
    g.count += 1;
    g.weighted += contribution;
    g.mostRecentAgeDays = Math.min(g.mostRecentAgeDays, Math.max(ageDays, 0));
    grouped.set(signal.kind, g);
  }

  // Tenure credit: long-standing customers get a small negative (trust) offset,
  // capped so it can never fully mask serious recent avoidance.
  const tenureCredit = -clamp(input.tenureDays / 365, 0, 1) * 6;
  if (input.tenureDays > 0) {
    totalWeighted += tenureCredit;
    evidence.push({
      code: "tenure_credit",
      message: `Subscription tenure of ${Math.round(input.tenureDays)} day(s) applies a trust credit.`,
      weight: round(tenureCredit),
      confidence: 0.6,
    });
  }

  // Emit one evidence entry per contributing signal group.
  for (const [kind, g] of grouped) {
    evidence.push({
      code: `signal_${kind}`,
      message: `${g.count}x ${SIGNAL_LABELS[kind]} (most recent ~${Math.round(g.mostRecentAgeDays)}d ago) contributed ${round(g.weighted)} points after recency decay.`,
      weight: round(g.weighted),
      confidence: 0.7,
    });
  }

  // Map the raw weighted total onto 0..100. We normalise with a soft cap so the
  // score is bounded and interpretable rather than unbounded arithmetic.
  const rawScore = clamp(totalWeighted, 0, 100);
  const score = round(rawScore, 1);
  const band = bandFor(score);

  // Confidence grows with the amount of (recency-weighted) evidence available
  // and saturates; sparse data => low confidence.
  const confidence = round(clamp(effectiveObservations / 5, 0.2, 0.95), 2);

  evidence.push({
    code: "risk_summary",
    message: `Weighted risk score ${score}/100 (${band} band) with ${confidence} confidence from ${input.signals.length} signal(s).`,
    confidence,
  });

  return { score, band, confidence, evidence };
}

/** Days from an earlier ISO time to `asOf` (>= 0 for past events). */
function daysAgo(asOfIso: string, atIso: string): number {
  const asOf = Date.parse(asOfIso);
  const at = Date.parse(atIso);
  return (asOf - at) / (1000 * 60 * 60 * 24);
}
