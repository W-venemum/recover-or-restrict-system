/**
 * Behavioural pattern detectors.
 *
 * Pure functions that inspect a customer's payment + behavioural history and
 * surface named patterns with a severity (0..1) and human-readable evidence.
 * These distinguish genuine trouble (recoverable) from deliberate avoidance /
 * value extraction. No I/O.
 */

import type {
  BehaviouralEvent,
  DetectedPattern,
  Evidence,
  PatternType,
  PaymentEvent,
} from "../domain/types.js";
import { clamp, daysBetween, round } from "./decay.js";

export interface PatternInput {
  paymentEvents: PaymentEvent[];
  behaviouralEvents: BehaviouralEvent[];
  /** ISO anchor timestamp for windowed detection. */
  asOf: string;
  /** Look-back window in days for cycling detection. */
  windowDays?: number;
}

const DEFAULT_WINDOW_DAYS = 180;

/** Run all detectors and return the patterns that matched. */
export function detectPatterns(input: PatternInput): DetectedPattern[] {
  const windowDays = input.windowDays ?? DEFAULT_WINDOW_DAYS;
  const detectors = [
    detectCancellationCycling,
    detectPaymentFailureCycling,
    detectRenewalAvoidance,
    detectGracePeriodValueExtraction,
    detectCancelUseResubscribeLoop,
  ];

  const results: DetectedPattern[] = [];
  for (const detector of detectors) {
    const match = detector(input, windowDays);
    if (match) results.push(match);
  }
  return results;
}

function withinWindow(iso: string, asOf: string, windowDays: number): boolean {
  const age = daysBetween(asOf, iso);
  return age >= 0 && age <= windowDays;
}

function makePattern(
  type: PatternType,
  severity: number,
  evidence: Evidence[],
): DetectedPattern {
  return { type, severity: round(clamp(severity, 0, 1), 2), evidence };
}

/** Repeated subscribe/cancel churn within the window. */
function detectCancellationCycling(
  input: PatternInput,
  windowDays: number,
): DetectedPattern | undefined {
  const cancellations = input.behaviouralEvents.filter(
    (e) =>
      e.type === "subscription_cancelled" &&
      withinWindow(e.timestamp, input.asOf, windowDays),
  );
  if (cancellations.length < 2) return undefined;

  const severity = clamp(cancellations.length / 4, 0, 1);
  return makePattern("cancellation_cycling", severity, [
    {
      code: "cancellation_cycling",
      message: `${cancellations.length} cancellations in the last ${windowDays} days indicate cancellation cycling.`,
      confidence: 0.7,
    },
  ]);
}

/** Repeated payment failures clustered in the window. */
function detectPaymentFailureCycling(
  input: PatternInput,
  windowDays: number,
): DetectedPattern | undefined {
  const failures = input.paymentEvents.filter(
    (e) =>
      e.type === "payment_failed" &&
      withinWindow(e.timestamp, input.asOf, windowDays),
  );
  if (failures.length < 3) return undefined;

  const severity = clamp(failures.length / 6, 0, 1);
  return makePattern("payment_failure_cycling", severity, [
    {
      code: "payment_failure_cycling",
      message: `${failures.length} payment failures in the last ${windowDays} days indicate repeated failure cycling.`,
      confidence: 0.75,
    },
  ]);
}

/**
 * Renewal avoidance: renewals that were due but repeatedly went unpaid, or
 * cancellations timed just before renewal.
 */
function detectRenewalAvoidance(
  input: PatternInput,
  windowDays: number,
): DetectedPattern | undefined {
  const nearRenewalCancels = input.behaviouralEvents.filter(
    (e) =>
      e.type === "subscription_cancelled" &&
      withinWindow(e.timestamp, input.asOf, windowDays) &&
      typeof e.metadata?.daysToRenewal === "number" &&
      e.metadata.daysToRenewal >= 0 &&
      e.metadata.daysToRenewal <= 3,
  );

  const renewalDue = input.behaviouralEvents.filter(
    (e) =>
      e.type === "renewal_due" &&
      withinWindow(e.timestamp, input.asOf, windowDays),
  );
  const succeededRenewals = input.paymentEvents.filter(
    (e) =>
      e.type === "payment_succeeded" &&
      withinWindow(e.timestamp, input.asOf, windowDays),
  );
  const unpaidRenewals = Math.max(renewalDue.length - succeededRenewals.length, 0);

  const signalCount = nearRenewalCancels.length + unpaidRenewals;
  if (signalCount < 2) return undefined;

  const evidence: Evidence[] = [];
  if (nearRenewalCancels.length > 0) {
    evidence.push({
      code: "cancel_before_renewal",
      message: `${nearRenewalCancels.length} cancellation(s) timed within 3 days of a renewal.`,
      confidence: 0.7,
    });
  }
  if (unpaidRenewals > 0) {
    evidence.push({
      code: "unpaid_renewals",
      message: `${unpaidRenewals} renewal(s) fell due without a corresponding successful payment.`,
      confidence: 0.7,
    });
  }

  return makePattern("renewal_avoidance", clamp(signalCount / 4, 0, 1), evidence);
}

/** Extracting value by using the product during grace/unpaid periods. */
function detectGracePeriodValueExtraction(
  input: PatternInput,
  windowDays: number,
): DetectedPattern | undefined {
  const graceUsage = input.behaviouralEvents.filter(
    (e) =>
      withinWindow(e.timestamp, input.asOf, windowDays) &&
      (e.type === "grace_period_usage" ||
        (e.type === "feature_usage" && e.metadata?.duringUnpaidPeriod === true)),
  );
  if (graceUsage.length < 2) return undefined;

  const severity = clamp(graceUsage.length / 5, 0, 1);
  return makePattern("grace_period_value_extraction", severity, [
    {
      code: "grace_period_value_extraction",
      message: `${graceUsage.length} product-usage events occurred during unpaid/grace periods, suggesting value extraction without payment.`,
      confidence: 0.75,
    },
  ]);
}

/**
 * Cancel -> use -> resubscribe loop: cancellation followed by continued usage
 * and a later resubscription, repeated over time.
 */
function detectCancelUseResubscribeLoop(
  input: PatternInput,
  windowDays: number,
): DetectedPattern | undefined {
  const events = input.behaviouralEvents
    .filter((e) => withinWindow(e.timestamp, input.asOf, windowDays))
    .slice()
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  let loops = 0;
  let state: "idle" | "cancelled" | "used_while_cancelled" = "idle";

  for (const e of events) {
    if (e.type === "subscription_cancelled") {
      state = "cancelled";
    } else if (
      state !== "idle" &&
      (e.type === "grace_period_usage" ||
        (e.type === "feature_usage" && e.metadata?.duringUnpaidPeriod === true))
    ) {
      state = "used_while_cancelled";
    } else if (e.type === "subscription_resubscribed") {
      if (state === "used_while_cancelled") loops += 1;
      state = "idle";
    }
  }

  if (loops < 1) return undefined;

  const severity = clamp(loops / 2, 0, 1);
  return makePattern("cancel_use_resubscribe_loop", severity, [
    {
      code: "cancel_use_resubscribe_loop",
      message: `${loops} cancel -> use-while-unpaid -> resubscribe loop(s) detected, a strong value-extraction signal.`,
      confidence: 0.8,
    },
  ]);
}
