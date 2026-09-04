/**
 * Core domain types for the Recover-or-Restrict decision engine.
 *
 * These types are intentionally free of any I/O concerns (no DB rows, no HTTP
 * shapes). They describe the pure domain model consumed by the deterministic
 * engine. Persistence and API layers (later features) map to/from these types.
 */

// ---------------------------------------------------------------------------
// Payment + behavioural events
// ---------------------------------------------------------------------------

/** High-level category of a payment lifecycle event. */
export type PaymentEventType =
  | "payment_succeeded"
  | "payment_failed"
  | "payment_retried"
  | "refund_issued"
  | "chargeback"
  | "renewal_attempt"
  | "autopay_registered"
  | "autopay_cancelled";

/**
 * Classification of WHY a payment failed. This drives the recover-vs-restrict
 * distinction: transient/genuine failures must never be treated as abuse.
 */
export type FailureClass =
  | "transient_recoverable"
  | "insufficient_funds"
  | "invalid_or_expired_method"
  | "authentication_required"
  | "suspicious_behaviour"
  | "high_confidence_avoidance";

/** Categories of behavioural (non-payment) events used by pattern detectors. */
export type BehaviouralEventType =
  | "subscription_started"
  | "subscription_cancelled"
  | "subscription_resubscribed"
  | "feature_usage"
  | "grace_period_entered"
  | "grace_period_usage"
  | "renewal_due";

// ---------------------------------------------------------------------------
// Access state machine
// ---------------------------------------------------------------------------

/**
 * The adaptive access state for a subscription. The machine flows
 * ACTIVE -> RECOVERY -> GRACE -> RESTRICTED -> SUSPENDED and may surface a
 * BLACKLIST_RECOMMENDED flag. Blacklist is ALWAYS only a recommendation and is
 * never applied automatically by the engine.
 */
export type AccessState =
  | "ACTIVE"
  | "RECOVERY"
  | "GRACE"
  | "RESTRICTED"
  | "SUSPENDED"
  | "BLACKLIST_RECOMMENDED";

// ---------------------------------------------------------------------------
// Decision outcomes + recovery actions
// ---------------------------------------------------------------------------

/** The top-level decision the engine reaches for a customer. */
export type DecisionOutcome = "RECOVER" | "INTERVENE" | "RESTRICT" | "SUSPEND";

/** Concrete next-best recovery actions the engine can recommend. */
export type RecoveryAction =
  | "retry"
  | "delayed_retry"
  | "payment_reminder"
  | "alternate_payment_method"
  | "upi_payment_link"
  | "update_payment_method"
  | "limited_grace_period";

/** Coarse risk band derived from the numeric risk score. */
export type RiskBand = "low" | "medium" | "high";

// ---------------------------------------------------------------------------
// Explainability
// ---------------------------------------------------------------------------

/**
 * A single human-readable piece of evidence contributing to a score or a
 * decision. Every non-trivial engine output carries evidence so decisions are
 * transparent and audit-ready.
 */
export interface Evidence {
  /** Stable machine code for the evidence, e.g. "recency_weighted_failures". */
  code: string;
  /** Human-readable explanation shown to operators / in audit trails. */
  message: string;
  /**
   * Signed contribution this evidence made to the score (positive = raises
   * risk, negative = lowers risk). Omitted for purely informational evidence.
   */
  weight?: number;
  /** How confident the engine is in this evidence, 0..1. */
  confidence?: number;
}

// ---------------------------------------------------------------------------
// Core entities
// ---------------------------------------------------------------------------

export interface Customer {
  id: string;
  /** Display name or email; used only for presentation. */
  name: string;
  email?: string;
  /** ISO timestamp when the customer first signed up. */
  createdAt: string;
}

export interface Subscription {
  id: string;
  customerId: string;
  /** Plan identifier (informational for the core engine). */
  plan: string;
  /** Recurring amount in the smallest currency unit (e.g. paise). */
  amount: number;
  currency: string;
  /** ISO timestamp when the subscription began. */
  startedAt: string;
  /** ISO timestamp of the next renewal, if known. */
  nextRenewalAt?: string;
  /** Current access state; ACTIVE for a healthy subscription. */
  accessState: AccessState;
}

export interface PaymentEvent {
  id: string;
  customerId: string;
  subscriptionId: string;
  type: PaymentEventType;
  /** ISO timestamp of the event. */
  timestamp: string;
  /** Amount in smallest currency unit, if applicable. */
  amount?: number;
  currency?: string;
  /**
   * Raw gateway failure reason code (Razorpay-style), present on failures.
   * e.g. "BAD_REQUEST_ERROR", "GATEWAY_ERROR".
   */
  failureCode?: string;
  /** Raw gateway failure reason string, present on failures. */
  failureReason?: string;
  /** Which attempt number this was for the current billing cycle. */
  attempt?: number;
}

export interface BehaviouralEvent {
  id: string;
  customerId: string;
  subscriptionId?: string;
  type: BehaviouralEventType;
  /** ISO timestamp of the event. */
  timestamp: string;
  /**
   * Free-form details for pattern detectors, e.g. days-before-renewal for a
   * cancellation. Kept narrow and typed to preserve determinism.
   */
  metadata?: BehaviouralEventMetadata;
}

export interface BehaviouralEventMetadata {
  /** Days between this event and the related renewal (negative = after). */
  daysToRenewal?: number;
  /** True if usage happened while unpaid / in grace. */
  duringUnpaidPeriod?: boolean;
  /** Related feature name for usage events. */
  feature?: string;
}

// ---------------------------------------------------------------------------
// Engine result types
// ---------------------------------------------------------------------------

/** Result of classifying a single payment failure. */
export interface FailureClassification {
  failureClass: FailureClass;
  /** Confidence in the classification, 0..1. */
  confidence: number;
  evidence: Evidence[];
}

/** Result of the weighted, recency-decayed risk computation. */
export interface RiskResult {
  /** Normalised risk score, 0..100. */
  score: number;
  band: RiskBand;
  /** Confidence in the score, 0..1, driven by signal volume/consistency. */
  confidence: number;
  evidence: Evidence[];
}

/** A behavioural pattern the detectors matched. */
export type PatternType =
  | "cancellation_cycling"
  | "payment_failure_cycling"
  | "renewal_avoidance"
  | "grace_period_value_extraction"
  | "cancel_use_resubscribe_loop";

export interface DetectedPattern {
  type: PatternType;
  /** Strength of the match, 0..1. */
  severity: number;
  evidence: Evidence[];
}

/** The final explainable decision produced by the engine. */
export interface Decision {
  outcome: DecisionOutcome;
  /** Confidence in the decision, 0..1. */
  confidence: number;
  evidence: Evidence[];
  /** Next-best recovery action, present for recoverable/intervene outcomes. */
  recommendedAction?: RecoveryAction;
  /** Human-readable expectation of what the recommended action should achieve. */
  expectedRecoveryOutcome?: string;
  /**
   * True only when the engine recommends (never applies) blacklisting. Always a
   * recommendation flag surfaced for human review.
   */
  blacklistRecommended: boolean;
}

/** Full explainable result of evaluating a customer end to end. */
export interface EvaluationResult {
  customerId: string;
  failureClassification?: FailureClassification;
  risk: RiskResult;
  patterns: DetectedPattern[];
  decision: Decision;
  /** Access state the customer should transition to given this decision. */
  nextAccessState: AccessState;
  /** Aggregated, audit-ready evidence across all stages. */
  auditEvidence: Evidence[];
}
