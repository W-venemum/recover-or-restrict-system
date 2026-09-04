/**
 * Tests for the pure engine orchestrator's signal wiring (engine/index.ts).
 *
 * These specifically cover the signals that buildRiskSignals derives from raw
 * events and feeds into the risk model: recovery_failure (a repeated failed
 * attempt on an open episode), recovery_success (a success that clears a
 * preceding failure, earning a trust credit) and unpaid_renewal (a renewal_due
 * with no corresponding successful payment). Each produces a `signal_<kind>`
 * evidence entry from the risk stage, which is how we assert the signal reached
 * the score rather than being dead weight.
 */

import { describe, it, expect } from "vitest";
import { evaluateCustomer } from "../src/engine/index.js";
import type {
  BehaviouralEvent,
  Customer,
  PaymentEvent,
  Subscription,
} from "../src/domain/types.js";

const ASOF = "2024-06-01T00:00:00.000Z";

function daysAgo(days: number): string {
  return new Date(Date.parse(ASOF) - days * 86_400_000).toISOString();
}

const customer: Customer = {
  id: "cust_test",
  name: "Test Customer",
  createdAt: daysAgo(200),
};

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "sub_test",
    customerId: customer.id,
    plan: "Pro Monthly",
    amount: 49900,
    currency: "INR",
    startedAt: daysAgo(200),
    accessState: "ACTIVE",
    ...overrides,
  };
}

function evidenceCodes(result: ReturnType<typeof evaluateCustomer>): string[] {
  return result.risk.evidence.map((e) => e.code);
}

describe("buildRiskSignals — recovery_failure", () => {
  it("emits a recovery_failure signal when a repeated attempt fails again on an open episode", () => {
    const paymentEvents: PaymentEvent[] = [
      {
        id: "f1",
        customerId: customer.id,
        subscriptionId: "sub_test",
        type: "payment_failed",
        timestamp: daysAgo(5),
        failureCode: "INSUFFICIENT_FUNDS",
        attempt: 1,
      },
      {
        id: "f2",
        customerId: customer.id,
        subscriptionId: "sub_test",
        type: "payment_failed",
        timestamp: daysAgo(3),
        failureCode: "INSUFFICIENT_FUNDS",
        attempt: 2,
      },
    ];
    const result = evaluateCustomer({
      customer,
      subscription: subscription({ accessState: "RECOVERY" }),
      paymentEvents,
      asOf: ASOF,
    });
    expect(evidenceCodes(result)).toContain("signal_recovery_failure");
  });

  it("a single first-attempt failure produces NO recovery_failure signal", () => {
    const paymentEvents: PaymentEvent[] = [
      {
        id: "f1",
        customerId: customer.id,
        subscriptionId: "sub_test",
        type: "payment_failed",
        timestamp: daysAgo(3),
        failureCode: "GATEWAY_ERROR",
        attempt: 1,
      },
    ];
    const result = evaluateCustomer({
      customer,
      subscription: subscription({ accessState: "RECOVERY" }),
      paymentEvents,
      asOf: ASOF,
    });
    expect(evidenceCodes(result)).not.toContain("signal_recovery_failure");
  });
});

describe("buildRiskSignals — recovery_success", () => {
  it("emits a recovery_success signal (trust credit) when a success clears a prior failure", () => {
    const paymentEvents: PaymentEvent[] = [
      {
        id: "f1",
        customerId: customer.id,
        subscriptionId: "sub_test",
        type: "payment_failed",
        timestamp: daysAgo(5),
        failureCode: "GATEWAY_ERROR",
        attempt: 1,
      },
      {
        id: "s1",
        customerId: customer.id,
        subscriptionId: "sub_test",
        type: "payment_succeeded",
        timestamp: daysAgo(4),
        amount: 49900,
        attempt: 2,
      },
    ];
    const result = evaluateCustomer({
      customer,
      subscription: subscription({ accessState: "RECOVERY" }),
      paymentEvents,
      asOf: ASOF,
    });
    const recoverySuccess = result.risk.evidence.find(
      (e) => e.code === "signal_recovery_success",
    );
    expect(recoverySuccess).toBeDefined();
    // recovery_success has a NEGATIVE base weight (a trust credit).
    expect(recoverySuccess?.weight ?? 0).toBeLessThan(0);
  });

  it("a lone success (no preceding failure) produces NO recovery_success signal", () => {
    const paymentEvents: PaymentEvent[] = [
      {
        id: "s1",
        customerId: customer.id,
        subscriptionId: "sub_test",
        type: "payment_succeeded",
        timestamp: daysAgo(4),
        amount: 49900,
      },
    ];
    const result = evaluateCustomer({
      customer,
      subscription: subscription(),
      paymentEvents,
      asOf: ASOF,
    });
    expect(evidenceCodes(result)).not.toContain("signal_recovery_success");
  });
});

describe("buildRiskSignals — unpaid_renewal", () => {
  it("emits unpaid_renewal signals for renewals due without a matching successful payment", () => {
    const behaviouralEvents: BehaviouralEvent[] = [
      {
        id: "r1",
        customerId: customer.id,
        subscriptionId: "sub_test",
        type: "renewal_due",
        timestamp: daysAgo(40),
      },
      {
        id: "r2",
        customerId: customer.id,
        subscriptionId: "sub_test",
        type: "renewal_due",
        timestamp: daysAgo(10),
      },
    ];
    const result = evaluateCustomer({
      customer,
      subscription: subscription(),
      paymentEvents: [],
      behaviouralEvents,
      asOf: ASOF,
    });
    const unpaid = result.risk.evidence.find((e) => e.code === "signal_unpaid_renewal");
    expect(unpaid).toBeDefined();
    // Two unpaid renewals raise risk (positive weight).
    expect(unpaid?.weight ?? 0).toBeGreaterThan(0);
  });

  it("renewals matched by successful payments produce NO unpaid_renewal signal", () => {
    const behaviouralEvents: BehaviouralEvent[] = [
      {
        id: "r1",
        customerId: customer.id,
        subscriptionId: "sub_test",
        type: "renewal_due",
        timestamp: daysAgo(40),
      },
    ];
    const paymentEvents: PaymentEvent[] = [
      {
        id: "s1",
        customerId: customer.id,
        subscriptionId: "sub_test",
        type: "payment_succeeded",
        timestamp: daysAgo(39),
        amount: 49900,
      },
    ];
    const result = evaluateCustomer({
      customer,
      subscription: subscription(),
      paymentEvents,
      behaviouralEvents,
      asOf: ASOF,
    });
    expect(evidenceCodes(result)).not.toContain("signal_unpaid_renewal");
  });
});
