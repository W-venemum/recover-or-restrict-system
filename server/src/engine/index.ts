/**
 * Pure engine orchestrator.
 *
 * `evaluateCustomer` runs the full deterministic pipeline:
 *   classify -> risk -> patterns -> decision -> access
 * and returns a single explainable {@link EvaluationResult} with audit-ready
 * evidence aggregated from every stage. No I/O whatsoever.
 */

import type {
  BehaviouralEvent,
  Customer,
  Evidence,
  EvaluationResult,
  FailureClassification,
  PaymentEvent,
  Subscription,
} from "../domain/types.js";
import { classifyFailure } from "./classifier.js";
import { daysBetween } from "./decay.js";
import { decide, type AccessHistory } from "./decision.js";
import { detectPatterns } from "./patterns.js";
import { computeRiskScore, type RiskSignal } from "./risk.js";
import { transition } from "./accessState.js";

// Re-export the public engine surface for convenient consumption by later
// features (persistence, API) without reaching into individual modules.
export * from "./classifier.js";
export * from "./risk.js";
export * from "./patterns.js";
export * from "./decision.js";
export * from "./accessState.js";
export * from "./revenue.js";

export interface EvaluateInput {
  customer: Customer;
  subscription: Subscription;
  paymentEvents: PaymentEvent[];
  behaviouralEvents?: BehaviouralEvent[];
  /** Recovery actions already attempted this episode + retry history. */
  accessHistory?: AccessHistory;
  /** ISO anchor timestamp; defaults to now. */
  asOf?: string;
}

/**
 * Evaluate a customer end to end and return a full explainable result.
 */
export function evaluateCustomer(input: EvaluateInput): EvaluationResult {
  const asOf = input.asOf ?? new Date().toISOString();
  const behaviouralEvents = input.behaviouralEvents ?? [];
  const accessHistory: AccessHistory = input.accessHistory ?? {
    attemptedActions: [],
    failedRetries: 0,
  };

  const sortedPayments = input.paymentEvents
    .slice()
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  // ---- 1. Classify the most recent failure (if any) --------------------
  let failureClassification: FailureClassification | undefined;
  const failures = sortedPayments.filter((e) => e.type === "payment_failed");
  const latestFailure = failures[failures.length - 1];
  if (latestFailure) {
    const priorSameFailureCount = failures.filter(
      (e) =>
        e !== latestFailure &&
        (e.failureCode ?? "") === (latestFailure.failureCode ?? ""),
    ).length;
    failureClassification = classifyFailure(latestFailure, {
      priorSameFailureCount,
      ...(latestFailure.attempt !== undefined ? { attempt: latestFailure.attempt } : {}),
    });
  }

  // ---- 2. Build risk signals from raw events --------------------------
  const signals = buildRiskSignals(sortedPayments, behaviouralEvents);
  const tenureDays = Math.max(daysBetween(asOf, input.subscription.startedAt), 0);
  const risk = computeRiskScore({ signals, asOf, tenureDays });

  // ---- 3. Behavioural patterns ----------------------------------------
  const patterns = detectPatterns({
    paymentEvents: sortedPayments,
    behaviouralEvents,
    asOf,
  });

  // ---- 4. Decision -----------------------------------------------------
  const decision = decide({
    risk,
    ...(failureClassification ? { failureClassification } : {}),
    patterns,
    accessHistory,
  });

  // ---- 5. Access state transition -------------------------------------
  const paymentSucceeded =
    sortedPayments.length > 0 &&
    sortedPayments[sortedPayments.length - 1]!.type === "payment_succeeded";
  const trans = transition(
    input.subscription.accessState,
    decision,
    paymentSucceeded,
  );

  // ---- Aggregate audit-ready evidence ---------------------------------
  const auditEvidence: Evidence[] = [
    ...(failureClassification?.evidence ?? []),
    ...risk.evidence,
    ...patterns.flatMap((p) => p.evidence),
    ...decision.evidence,
    {
      code: "access_transition",
      message: trans.reason,
      confidence: decision.confidence,
    },
  ];

  return {
    customerId: input.customer.id,
    ...(failureClassification ? { failureClassification } : {}),
    risk,
    patterns,
    decision,
    nextAccessState: trans.nextState,
    auditEvidence,
  };
}

/**
 * Derive dated risk signals from raw payment + behavioural events. Kept here
 * (not in risk.ts) so the risk model stays free of event-parsing concerns.
 */
function buildRiskSignals(
  paymentEvents: PaymentEvent[],
  behaviouralEvents: BehaviouralEvent[],
): RiskSignal[] {
  const signals: RiskSignal[] = [];

  for (const e of paymentEvents) {
    switch (e.type) {
      case "payment_failed":
        signals.push({ kind: "failed_payment", at: e.timestamp });
        break;
      case "payment_succeeded":
        signals.push({ kind: "successful_payment", at: e.timestamp });
        break;
      case "autopay_cancelled":
        signals.push({ kind: "autopay_cancelled", at: e.timestamp });
        break;
      default:
        break;
    }
  }

  for (const e of behaviouralEvents) {
    switch (e.type) {
      case "subscription_cancelled":
        if (
          typeof e.metadata?.daysToRenewal === "number" &&
          e.metadata.daysToRenewal >= 0 &&
          e.metadata.daysToRenewal <= 3
        ) {
          signals.push({ kind: "cancellation_near_renewal", at: e.timestamp });
        }
        break;
      case "grace_period_usage":
        signals.push({ kind: "usage_during_unpaid_period", at: e.timestamp });
        break;
      case "feature_usage":
        if (e.metadata?.duringUnpaidPeriod === true) {
          signals.push({ kind: "usage_during_unpaid_period", at: e.timestamp });
        }
        break;
      case "subscription_resubscribed":
        signals.push({ kind: "cancel_resubscribe_cycle", at: e.timestamp });
        break;
      default:
        break;
    }
  }

  return signals;
}
