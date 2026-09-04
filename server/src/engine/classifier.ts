/**
 * Payment-failure classifier.
 *
 * Pure function that maps a raw gateway failure (Razorpay-style code + reason)
 * into a {@link FailureClass} with a confidence and human-readable evidence.
 *
 * PRODUCT PRINCIPLE: a single transient/genuine failure must classify as
 * recoverable, never as abuse. Behavioural escalation is applied elsewhere
 * (patterns + decision engine); the classifier only interprets the failure
 * signal itself, optionally nudged by lightweight context.
 */

import type {
  Evidence,
  FailureClass,
  FailureClassification,
  PaymentEvent,
} from "../domain/types.js";

/** Optional context that can sharpen (but never manufacture) a classification. */
export interface ClassifierContext {
  /**
   * How many times this same failure code has already occurred recently for
   * the customer. Repetition can escalate an otherwise-recoverable failure.
   */
  priorSameFailureCount?: number;
  /** Attempt number for the current billing cycle (from the event if absent). */
  attempt?: number;
}

interface Mapping {
  failureClass: FailureClass;
  confidence: number;
  rationale: string;
}

/**
 * Mapping table from Razorpay-style failure codes/reasons to a base
 * classification. Keys are matched case-insensitively as substrings against
 * both the failure code and reason, so realistic gateway strings are handled.
 */
const CODE_MAPPINGS: Array<{ match: string; mapping: Mapping }> = [
  // Transient / retry-friendly gateway conditions.
  { match: "gateway_error", mapping: { failureClass: "transient_recoverable", confidence: 0.85, rationale: "Gateway-side error; typically resolves on retry." } },
  { match: "server_error", mapping: { failureClass: "transient_recoverable", confidence: 0.85, rationale: "Transient processor server error; retryable." } },
  { match: "timeout", mapping: { failureClass: "transient_recoverable", confidence: 0.8, rationale: "Network/processor timeout; retryable." } },
  { match: "issuer_not_available", mapping: { failureClass: "transient_recoverable", confidence: 0.8, rationale: "Card issuer temporarily unavailable; retryable." } },
  { match: "network_error", mapping: { failureClass: "transient_recoverable", confidence: 0.8, rationale: "Network error during processing; retryable." } },

  // Insufficient funds: recoverable but customer action / timing dependent.
  { match: "insufficient_funds", mapping: { failureClass: "insufficient_funds", confidence: 0.9, rationale: "Bank reported insufficient funds." } },
  { match: "payment_declined_by_bank", mapping: { failureClass: "insufficient_funds", confidence: 0.7, rationale: "Bank declined; commonly funds/limit related." } },
  { match: "limit_exceeded", mapping: { failureClass: "insufficient_funds", confidence: 0.75, rationale: "Card/account spending limit exceeded." } },

  // Invalid or expired instrument: needs a method update.
  { match: "card_expired", mapping: { failureClass: "invalid_or_expired_method", confidence: 0.92, rationale: "Payment card has expired." } },
  { match: "invalid_card", mapping: { failureClass: "invalid_or_expired_method", confidence: 0.9, rationale: "Card details invalid." } },
  { match: "card_declined", mapping: { failureClass: "invalid_or_expired_method", confidence: 0.65, rationale: "Card declined; may require an updated method." } },
  { match: "invalid_vpa", mapping: { failureClass: "invalid_or_expired_method", confidence: 0.85, rationale: "UPI VPA invalid or no longer active." } },
  { match: "account_closed", mapping: { failureClass: "invalid_or_expired_method", confidence: 0.9, rationale: "Underlying account closed." } },

  // Authentication required: recoverable with customer authentication.
  { match: "authentication", mapping: { failureClass: "authentication_required", confidence: 0.88, rationale: "Payment requires additional authentication (e.g. 3DS/OTP)." } },
  { match: "3ds", mapping: { failureClass: "authentication_required", confidence: 0.88, rationale: "3-D Secure authentication needed." } },
  { match: "otp", mapping: { failureClass: "authentication_required", confidence: 0.85, rationale: "One-time-password authentication needed." } },
  { match: "mandate", mapping: { failureClass: "authentication_required", confidence: 0.75, rationale: "Autopay mandate needs re-authorisation." } },

  // Explicitly suspicious signals from the gateway.
  { match: "fraud", mapping: { failureClass: "suspicious_behaviour", confidence: 0.9, rationale: "Gateway flagged the transaction as potentially fraudulent." } },
  { match: "suspicious", mapping: { failureClass: "suspicious_behaviour", confidence: 0.85, rationale: "Gateway flagged suspicious activity." } },
  { match: "stolen", mapping: { failureClass: "suspicious_behaviour", confidence: 0.9, rationale: "Instrument reported lost/stolen." } },
];

/** Default when we cannot recognise the failure: assume recoverable, low confidence. */
const UNKNOWN_MAPPING: Mapping = {
  failureClass: "transient_recoverable",
  confidence: 0.4,
  rationale: "Unrecognised failure reason; treated as recoverable pending more signal.",
};

function findMapping(code: string, reason: string): Mapping {
  const haystack = `${code} ${reason}`.toLowerCase();
  for (const entry of CODE_MAPPINGS) {
    if (haystack.includes(entry.match)) return entry.mapping;
  }
  return UNKNOWN_MAPPING;
}

/**
 * Classify a single payment failure event.
 *
 * @param event   the payment event (should be a `payment_failed` event)
 * @param context optional light context used only to sharpen the result
 */
export function classifyFailure(
  event: PaymentEvent,
  context: ClassifierContext = {},
): FailureClassification {
  const code = event.failureCode ?? "";
  const reason = event.failureReason ?? "";
  const base = findMapping(code, reason);

  const evidence: Evidence[] = [];
  let { failureClass, confidence } = base;

  evidence.push({
    code: "gateway_reason_mapping",
    message: `Failure code "${code || "n/a"}" / reason "${reason || "n/a"}" -> ${failureClass}. ${base.rationale}`,
    confidence: base.confidence,
  });

  // Repetition escalation: a genuinely transient failure that recurs many times
  // for the same reason starts to look like avoidance rather than bad luck.
  const priorSame = context.priorSameFailureCount ?? 0;
  const attempt = context.attempt ?? event.attempt ?? 1;

  if (priorSame >= 3 && failureClass === "transient_recoverable") {
    failureClass = "suspicious_behaviour";
    confidence = Math.max(confidence, 0.7);
    evidence.push({
      code: "repeated_same_failure",
      message: `The same "transient" failure has occurred ${priorSame} times; escalated to suspicious_behaviour.`,
      confidence: 0.7,
    });
  } else if (priorSame >= 5) {
    failureClass = "high_confidence_avoidance";
    confidence = Math.max(confidence, 0.8);
    evidence.push({
      code: "persistent_repeated_failure",
      message: `Failure has recurred ${priorSame} times despite prior attempts; strong avoidance signal.`,
      confidence: 0.8,
    });
  } else if (priorSame >= 1) {
    evidence.push({
      code: "prior_same_failure",
      message: `This failure reason has occurred ${priorSame} time(s) before; still treated as recoverable.`,
      confidence: 0.5,
    });
  }

  if (attempt > 1) {
    evidence.push({
      code: "retry_attempt",
      message: `This is attempt #${attempt} in the current billing cycle.`,
    });
  }

  return { failureClass, confidence, evidence };
}
