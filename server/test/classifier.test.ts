/**
 * Behavioural tests for the payment-failure classifier.
 *
 * These assert the concrete code/reason -> FailureClass mappings and the
 * product-critical principle that a SINGLE transient failure stays recoverable
 * and never becomes abuse on its own.
 */

import { describe, it, expect } from "vitest";
import { classifyFailure } from "../src/engine/classifier.js";
import type { PaymentEvent } from "../src/domain/types.js";

function failure(
  failureCode: string,
  failureReason = "",
  extra: Partial<PaymentEvent> = {},
): PaymentEvent {
  return {
    id: "pe_test",
    customerId: "c1",
    subscriptionId: "s1",
    type: "payment_failed",
    timestamp: new Date().toISOString(),
    failureCode,
    failureReason,
    ...extra,
  };
}

describe("classifyFailure — code/reason mapping", () => {
  const cases: Array<[string, string, string]> = [
    ["GATEWAY_ERROR", "Gateway timeout while processing", "transient_recoverable"],
    ["SERVER_ERROR", "Processor server error", "transient_recoverable"],
    ["", "Network error during processing", "transient_recoverable"],
    ["ISSUER_NOT_AVAILABLE", "Card issuer temporarily unavailable", "transient_recoverable"],
    ["INSUFFICIENT_FUNDS", "Insufficient funds in account", "insufficient_funds"],
    ["LIMIT_EXCEEDED", "Spending limit exceeded", "insufficient_funds"],
    ["CARD_EXPIRED", "The card has expired", "invalid_or_expired_method"],
    ["INVALID_CARD", "Card details invalid", "invalid_or_expired_method"],
    ["INVALID_VPA", "UPI VPA invalid", "invalid_or_expired_method"],
    ["ACCOUNT_CLOSED", "Underlying account closed", "invalid_or_expired_method"],
    ["", "Additional authentication required (3DS)", "authentication_required"],
    ["", "OTP authentication needed", "authentication_required"],
    ["", "Autopay mandate needs re-authorisation", "authentication_required"],
    ["FRAUD_SUSPECTED", "Gateway flagged as fraudulent", "suspicious_behaviour"],
    ["", "Instrument reported lost/stolen", "suspicious_behaviour"],
  ];

  for (const [code, reason, expected] of cases) {
    it(`maps "${code || reason}" -> ${expected}`, () => {
      const result = classifyFailure(failure(code, reason));
      expect(result.failureClass).toBe(expected);
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.evidence.length).toBeGreaterThan(0);
    });
  }

  it("treats an unrecognised failure as recoverable with low confidence", () => {
    const result = classifyFailure(failure("SOMETHING_WEIRD", "no idea"));
    expect(result.failureClass).toBe("transient_recoverable");
    expect(result.confidence).toBeLessThan(0.5);
  });
});

describe("classifyFailure — single transient failure stays recoverable", () => {
  it("a lone transient failure is recoverable and NOT suspicious", () => {
    const result = classifyFailure(
      failure("GATEWAY_ERROR", "Gateway timeout while processing", { attempt: 1 }),
    );
    expect(result.failureClass).toBe("transient_recoverable");
    // No prior repetition context -> must not escalate to abuse.
    expect(result.failureClass).not.toBe("suspicious_behaviour");
    expect(result.failureClass).not.toBe("high_confidence_avoidance");
  });

  it("does not escalate a transient failure that has recurred only once or twice", () => {
    const result = classifyFailure(
      failure("GATEWAY_ERROR", "Gateway timeout"),
      { priorSameFailureCount: 2 },
    );
    expect(result.failureClass).toBe("transient_recoverable");
  });
});

describe("classifyFailure — repetition escalation", () => {
  it("escalates a repeated transient failure (>=3) to suspicious_behaviour", () => {
    const result = classifyFailure(
      failure("GATEWAY_ERROR", "Gateway timeout"),
      { priorSameFailureCount: 3 },
    );
    expect(result.failureClass).toBe("suspicious_behaviour");
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.evidence.some((e) => e.code === "repeated_same_failure")).toBe(true);
  });

  it("does not escalate a genuine invalid-method failure via repetition alone", () => {
    // Repetition escalation only applies to transient_recoverable; an expired
    // card stays classified as an instrument problem (recoverable via update).
    const result = classifyFailure(
      failure("CARD_EXPIRED", "The card has expired"),
      { priorSameFailureCount: 4 },
    );
    expect(result.failureClass).toBe("invalid_or_expired_method");
  });
});
