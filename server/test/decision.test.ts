/**
 * Table-driven behavioural tests for the decision engine.
 *
 * Genuine transient + low risk -> RECOVER; concerning -> INTERVENE; repeated
 * avoidance -> RESTRICT; high-confidence abuse -> SUSPEND (+ blacklist
 * recommendation). Also verifies the next-best recovery action escalates when
 * prior attempts have failed.
 */

import { describe, it, expect } from "vitest";
import { decide, type DecisionInput } from "../src/engine/decision.js";
import type {
  DetectedPattern,
  FailureClassification,
  PatternType,
  RiskBand,
  RiskResult,
} from "../src/domain/types.js";

function risk(score: number, band: RiskBand, confidence = 0.7): RiskResult {
  return { score, band, confidence, evidence: [] };
}

function failure(
  failureClass: FailureClassification["failureClass"],
  confidence = 0.8,
): FailureClassification {
  return { failureClass, confidence, evidence: [] };
}

function pattern(type: PatternType, severity: number): DetectedPattern {
  return { type, severity, evidence: [] };
}

const noHistory = { attemptedActions: [], failedRetries: 0 };

function decideWith(overrides: Partial<DecisionInput>) {
  return decide({
    risk: overrides.risk ?? risk(10, "low"),
    ...(overrides.failureClassification
      ? { failureClassification: overrides.failureClassification }
      : {}),
    patterns: overrides.patterns ?? [],
    accessHistory: overrides.accessHistory ?? noHistory,
  });
}

describe("decision outcomes — table driven", () => {
  it("genuine transient failure + low risk -> RECOVER (no blacklist)", () => {
    const d = decideWith({
      risk: risk(8, "low"),
      failureClassification: failure("transient_recoverable"),
    });
    expect(d.outcome).toBe("RECOVER");
    expect(d.blacklistRecommended).toBe(false);
    expect(d.recommendedAction).toBeDefined();
  });

  it("low risk with no failure/patterns -> RECOVER", () => {
    const d = decideWith({ risk: risk(5, "low") });
    expect(d.outcome).toBe("RECOVER");
  });

  it("medium risk (concerning) -> INTERVENE", () => {
    const d = decideWith({ risk: risk(45, "medium") });
    expect(d.outcome).toBe("INTERVENE");
    expect(d.recommendedAction).toBeDefined();
  });

  it("a mild avoidance signal (concerning but not conclusive) -> INTERVENE", () => {
    const d = decideWith({
      risk: risk(20, "low"),
      patterns: [pattern("renewal_avoidance", 0.4)],
    });
    expect(d.outcome).toBe("INTERVENE");
  });

  it("repeated avoidance (strong pattern) -> RESTRICT", () => {
    const d = decideWith({
      risk: risk(50, "medium"),
      patterns: [pattern("renewal_avoidance", 0.75)],
    });
    expect(d.outcome).toBe("RESTRICT");
    expect(d.blacklistRecommended).toBe(false);
  });

  it("high risk band alone -> RESTRICT", () => {
    const d = decideWith({ risk: risk(70, "high") });
    expect(d.outcome).toBe("RESTRICT");
  });

  it("suspicious_behaviour classification -> RESTRICT", () => {
    const d = decideWith({
      risk: risk(40, "medium"),
      failureClassification: failure("suspicious_behaviour", 0.85),
    });
    expect(d.outcome).toBe("RESTRICT");
  });

  it("high-confidence avoidance classification -> SUSPEND + blacklist recommended", () => {
    const d = decideWith({
      risk: risk(85, "high"),
      failureClassification: failure("high_confidence_avoidance", 0.9),
    });
    expect(d.outcome).toBe("SUSPEND");
    expect(d.blacklistRecommended).toBe(true);
  });

  it("high band + multiple strong avoidance patterns -> SUSPEND + blacklist", () => {
    const d = decideWith({
      risk: risk(80, "high"),
      patterns: [
        pattern("grace_period_value_extraction", 0.8),
        pattern("cancel_use_resubscribe_loop", 0.7),
      ],
    });
    expect(d.outcome).toBe("SUSPEND");
    expect(d.blacklistRecommended).toBe(true);
  });
});

describe("blacklist is only ever a recommendation", () => {
  it("SUSPEND sets blacklistRecommended but the decision never applies it", () => {
    const d = decideWith({
      risk: risk(90, "high"),
      failureClassification: failure("high_confidence_avoidance", 0.95),
    });
    expect(d.outcome).toBe("SUSPEND");
    expect(d.blacklistRecommended).toBe(true);
    // Non-suspend outcomes never recommend blacklist.
    const recover = decideWith({ risk: risk(5, "low") });
    expect(recover.blacklistRecommended).toBe(false);
  });
});

describe("next-best recovery action selection & escalation", () => {
  it("invalid/expired method -> update_payment_method", () => {
    const d = decideWith({
      risk: risk(10, "low"),
      failureClassification: failure("invalid_or_expired_method"),
    });
    expect(d.recommendedAction).toBe("update_payment_method");
  });

  it("authentication required -> upi_payment_link", () => {
    const d = decideWith({
      risk: risk(10, "low"),
      failureClassification: failure("authentication_required"),
    });
    expect(d.recommendedAction).toBe("upi_payment_link");
  });

  it("insufficient funds first attempt -> delayed_retry, then escalates to UPI link", () => {
    const first = decideWith({
      risk: risk(10, "low"),
      failureClassification: failure("insufficient_funds"),
    });
    expect(first.recommendedAction).toBe("delayed_retry");

    const escalated = decideWith({
      risk: risk(10, "low"),
      failureClassification: failure("insufficient_funds"),
      accessHistory: { attemptedActions: ["delayed_retry"], failedRetries: 1 },
    });
    expect(escalated.recommendedAction).toBe("upi_payment_link");
  });

  it("transient failure first tries retry, escalates to alternate method after a failed retry", () => {
    const first = decideWith({
      risk: risk(10, "low"),
      failureClassification: failure("transient_recoverable"),
    });
    expect(first.recommendedAction).toBe("retry");

    const escalated = decideWith({
      risk: risk(10, "low"),
      failureClassification: failure("transient_recoverable"),
      accessHistory: { attemptedActions: ["retry"], failedRetries: 1 },
    });
    expect(escalated.recommendedAction).toBe("alternate_payment_method");
  });

  it("RESTRICT / SUSPEND outcomes carry no recovery action", () => {
    const restrict = decideWith({ risk: risk(72, "high") });
    expect(restrict.recommendedAction).toBeUndefined();
  });

  it("INTERVENE with no active failure -> payment_reminder (low-friction first touch)", () => {
    // Medium risk, no failure classification: the softest nudge is a reminder.
    const d = decideWith({ risk: risk(45, "medium") });
    expect(d.outcome).toBe("INTERVENE");
    expect(d.recommendedAction).toBe("payment_reminder");
  });

  it("does not repeat a payment_reminder that was already sent", () => {
    const d = decideWith({
      risk: risk(45, "medium"),
      accessHistory: { attemptedActions: ["payment_reminder"], failedRetries: 0 },
    });
    expect(d.outcome).toBe("INTERVENE");
    expect(d.recommendedAction).not.toBe("payment_reminder");
  });

  it("insufficient funds -> limited_grace_period after delayed_retry AND an alternate route were both tried", () => {
    const d = decideWith({
      risk: risk(10, "low"),
      failureClassification: failure("insufficient_funds"),
      accessHistory: {
        attemptedActions: ["delayed_retry", "upi_payment_link"],
        failedRetries: 2,
      },
    });
    expect(d.recommendedAction).toBe("limited_grace_period");
  });
});
