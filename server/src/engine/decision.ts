/**
 * Decision engine.
 *
 * Pure function mapping (risk, failure classification, patterns, access
 * history) onto a transparent {@link Decision}. Deterministic, rules-based, and
 * explainable; never depends on an LLM.
 *
 * Guiding rules:
 *  - Genuine/transient failure with low risk           -> RECOVER
 *  - Medium risk / concerning but not conclusive signals -> INTERVENE
 *  - Repeated avoidance / value leakage                 -> RESTRICT
 *  - High-confidence repeated abuse                     -> SUSPEND (+ blacklist RECOMMENDATION)
 *
 * Blacklist is only ever a recommendation flag; the engine never auto-applies it.
 */

import type {
  Decision,
  DetectedPattern,
  Evidence,
  FailureClassification,
  RecoveryAction,
  RiskResult,
} from "../domain/types.js";
import { clamp, round } from "./decay.js";

export interface AccessHistory {
  /** Recovery actions already attempted, in order, for the current episode. */
  attemptedActions: RecoveryAction[];
  /** How many prior retries have failed. */
  failedRetries: number;
  /** Whether the customer previously updated their payment method. */
  updatedMethodBefore?: boolean;
}

export interface DecisionInput {
  risk: RiskResult;
  /** Present when the current episode involves a payment failure. */
  failureClassification?: FailureClassification;
  patterns: DetectedPattern[];
  accessHistory: AccessHistory;
}

/** Patterns that indicate deliberate avoidance / value extraction. */
const AVOIDANCE_PATTERNS = new Set([
  "renewal_avoidance",
  "grace_period_value_extraction",
  "cancel_use_resubscribe_loop",
]);

export function decide(input: DecisionInput): Decision {
  const { risk, failureClassification, patterns, accessHistory } = input;
  const evidence: Evidence[] = [];

  const avoidance = patterns.filter((p) => AVOIDANCE_PATTERNS.has(p.type));
  const maxAvoidanceSeverity = avoidance.reduce(
    (max, p) => Math.max(max, p.severity),
    0,
  );
  const strongAvoidance = avoidance.filter((p) => p.severity >= 0.6);

  const failureClass = failureClassification?.failureClass;
  const isGenuineFailure =
    failureClass === "transient_recoverable" ||
    failureClass === "insufficient_funds" ||
    failureClass === "invalid_or_expired_method" ||
    failureClass === "authentication_required";

  if (failureClassification) {
    evidence.push({
      code: "failure_class",
      message: `Current failure classified as ${failureClass} (confidence ${failureClassification.confidence}).`,
      confidence: failureClassification.confidence,
    });
  }
  evidence.push({
    code: "risk_band",
    message: `Risk score ${risk.score}/100 in the ${risk.band} band (confidence ${risk.confidence}).`,
    confidence: risk.confidence,
  });
  for (const p of patterns) {
    evidence.push({
      code: `pattern_${p.type}`,
      message: `Pattern ${p.type} matched with severity ${p.severity}.`,
      confidence: 0.7,
    });
  }

  // ---- Decision rules, most severe first -------------------------------
  let outcome: Decision["outcome"];
  let blacklistRecommended = false;

  const highConfidenceAbuse =
    failureClass === "high_confidence_avoidance" ||
    (risk.band === "high" && strongAvoidance.length >= 2) ||
    (risk.score >= 80 && maxAvoidanceSeverity >= 0.8);

  if (highConfidenceAbuse) {
    outcome = "SUSPEND";
    blacklistRecommended = true;
    evidence.push({
      code: "suspend_rule",
      message:
        "High-confidence, repeated abuse detected: suspending access and RECOMMENDING blacklist for human review (never auto-applied).",
      confidence: 0.85,
    });
  } else if (
    risk.band === "high" ||
    strongAvoidance.length >= 1 ||
    failureClass === "suspicious_behaviour"
  ) {
    outcome = "RESTRICT";
    evidence.push({
      code: "restrict_rule",
      message:
        "Repeated avoidance / value-leakage signals with elevated risk: restricting access pending resolution.",
      confidence: 0.75,
    });
  } else if (
    risk.band === "medium" ||
    maxAvoidanceSeverity > 0 ||
    (failureClassification && !isGenuineFailure)
  ) {
    outcome = "INTERVENE";
    evidence.push({
      code: "intervene_rule",
      message:
        "Concerning but non-conclusive signals: intervening with an assisted recovery step before any restriction.",
      confidence: 0.7,
    });
  } else {
    outcome = "RECOVER";
    evidence.push({
      code: "recover_rule",
      message: isGenuineFailure
        ? "Genuine/transient failure with low risk: attempting straightforward recovery. A single normal failure does not damage trust."
        : "Low risk with no concerning patterns: standard recovery.",
      confidence: 0.8,
    });
  }

  // ---- Next-best recovery action (for RECOVER / INTERVENE) --------------
  let recommendedAction: RecoveryAction | undefined;
  let expectedRecoveryOutcome: string | undefined;

  if (outcome === "RECOVER" || outcome === "INTERVENE") {
    const chosen = chooseRecoveryAction(failureClass, accessHistory, outcome);
    recommendedAction = chosen.action;
    expectedRecoveryOutcome = chosen.expectation;
    evidence.push({
      code: "recovery_action",
      message: `Next-best recovery action: ${chosen.action}. ${chosen.expectation}`,
      confidence: chosen.confidence,
    });
  }

  const confidence = deriveConfidence(
    risk,
    failureClassification,
    maxAvoidanceSeverity,
  );

  return {
    outcome,
    confidence,
    evidence,
    ...(recommendedAction ? { recommendedAction } : {}),
    ...(expectedRecoveryOutcome ? { expectedRecoveryOutcome } : {}),
    blacklistRecommended,
  };
}

interface ChosenAction {
  action: RecoveryAction;
  expectation: string;
  confidence: number;
}

/**
 * Choose the next-best recovery action given the failure class and what has
 * already been tried. Escalates sensibly: a failed prior retry moves us to an
 * alternate method / UPI link rather than retrying the same thing.
 */
function chooseRecoveryAction(
  failureClass: FailureClassification["failureClass"] | undefined,
  history: AccessHistory,
  outcome: Decision["outcome"],
): ChosenAction {
  const tried = new Set(history.attemptedActions);
  const escalate = history.failedRetries >= 1;

  // INTERVENE with no specific failure to remedy (concerning risk/pattern but
  // no active payment failure this episode): a low-friction payment reminder is
  // the right first touch before any technical retry or restriction.
  if (outcome === "INTERVENE" && !failureClass && !tried.has("payment_reminder")) {
    return {
      action: "payment_reminder",
      expectation:
        "Send a friendly payment reminder as a low-friction first nudge before any retry or restriction.",
      confidence: 0.65,
    };
  }

  switch (failureClass) {
    case "invalid_or_expired_method":
      return {
        action: "update_payment_method",
        expectation:
          "Prompt the customer to update their card/method; expected to resolve invalid/expired instrument failures.",
        confidence: 0.8,
      };

    case "authentication_required":
      return {
        action: "upi_payment_link",
        expectation:
          "Send an authenticated UPI payment link so the customer can complete the required authentication.",
        confidence: 0.75,
      };

    case "insufficient_funds":
      // Genuine payer who has already tried a delayed retry AND an alternate
      // route without clearing: extend a short grace period rather than cut a
      // genuine customer off while they arrange funds.
      if (
        (tried.has("delayed_retry") || escalate) &&
        (tried.has("upi_payment_link") || tried.has("alternate_payment_method"))
      ) {
        return {
          action: "limited_grace_period",
          expectation:
            "A delayed retry and an alternate route have both been tried; extend a short grace period so a genuine payer keeps access while arranging funds.",
          confidence: 0.65,
        };
      }
      if (tried.has("delayed_retry") || escalate) {
        return {
          action: "upi_payment_link",
          expectation:
            "Offer a UPI payment link as an alternate route after a delayed retry did not clear.",
          confidence: 0.7,
        };
      }
      return {
        action: "delayed_retry",
        expectation:
          "Retry after a short delay so the customer can top up funds; common resolution for insufficient-funds failures.",
        confidence: 0.7,
      };

    case "suspicious_behaviour":
      return {
        action: "update_payment_method",
        expectation:
          "Require a fresh, verified payment method before proceeding, given suspicious signals.",
        confidence: 0.65,
      };

    case "transient_recoverable":
    default:
      if (escalate || tried.has("retry")) {
        return {
          action: "alternate_payment_method",
          expectation:
            "A plain retry already failed; escalate to an alternate payment method / UPI link.",
          confidence: 0.7,
        };
      }
      return {
        action: "retry",
        expectation:
          "Automatically retry the charge; transient gateway failures usually clear on retry.",
        confidence: 0.8,
      };
  }
}

function deriveConfidence(
  risk: RiskResult,
  failure: FailureClassification | undefined,
  maxAvoidanceSeverity: number,
): number {
  const parts = [risk.confidence];
  if (failure) parts.push(failure.confidence);
  if (maxAvoidanceSeverity > 0) parts.push(clamp(0.5 + maxAvoidanceSeverity / 2, 0, 1));
  const avg = parts.reduce((s, v) => s + v, 0) / parts.length;
  return round(clamp(avg, 0.2, 0.98), 2);
}
