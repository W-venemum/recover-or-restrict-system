/**
 * Behavioural tests for the five pattern detectors.
 *
 * For each detector we feed a sequence that DOES exhibit the pattern (asserting
 * it fires with evidence) and a benign sequence that does NOT (asserting it
 * stays silent). This guards the recover-vs-restrict distinction.
 */

import { describe, it, expect } from "vitest";
import { detectPatterns, type PatternInput } from "../src/engine/patterns.js";
import type {
  BehaviouralEvent,
  BehaviouralEventType,
  PatternType,
  PaymentEvent,
  PaymentEventType,
} from "../src/domain/types.js";

const ASOF = "2024-06-01T00:00:00.000Z";

function daysAgo(days: number): string {
  return new Date(Date.parse(ASOF) - days * 86_400_000).toISOString();
}

let idc = 0;
function bev(
  type: BehaviouralEventType,
  days: number,
  metadata?: BehaviouralEvent["metadata"],
): BehaviouralEvent {
  return {
    id: `b${idc++}`,
    customerId: "c1",
    subscriptionId: "s1",
    type,
    timestamp: daysAgo(days),
    ...(metadata ? { metadata } : {}),
  };
}

function pev(type: PaymentEventType, days: number): PaymentEvent {
  return {
    id: `p${idc++}`,
    customerId: "c1",
    subscriptionId: "s1",
    type,
    timestamp: daysAgo(days),
  };
}

function run(input: Partial<PatternInput>): PatternType[] {
  return detectPatterns({
    paymentEvents: input.paymentEvents ?? [],
    behaviouralEvents: input.behaviouralEvents ?? [],
    asOf: ASOF,
  }).map((p) => p.type);
}

function detected(input: Partial<PatternInput>, type: PatternType) {
  const patterns = detectPatterns({
    paymentEvents: input.paymentEvents ?? [],
    behaviouralEvents: input.behaviouralEvents ?? [],
    asOf: ASOF,
  });
  return patterns.find((p) => p.type === type);
}

describe("cancellation_cycling", () => {
  it("fires on >=2 cancellations with evidence", () => {
    const match = detected(
      {
        behaviouralEvents: [
          bev("subscription_cancelled", 40),
          bev("subscription_cancelled", 10),
        ],
      },
      "cancellation_cycling",
    );
    expect(match).toBeDefined();
    expect(match!.severity).toBeGreaterThan(0);
    expect(match!.evidence.length).toBeGreaterThan(0);
  });

  it("does NOT fire on a single cancellation", () => {
    expect(run({ behaviouralEvents: [bev("subscription_cancelled", 10)] })).not.toContain(
      "cancellation_cycling",
    );
  });
});

describe("payment_failure_cycling", () => {
  it("fires on >=3 payment failures in-window", () => {
    const match = detected(
      {
        paymentEvents: [
          pev("payment_failed", 30),
          pev("payment_failed", 20),
          pev("payment_failed", 5),
        ],
      },
      "payment_failure_cycling",
    );
    expect(match).toBeDefined();
    expect(match!.evidence.length).toBeGreaterThan(0);
  });

  it("does NOT fire on one or two failures (a genuine hiccup)", () => {
    expect(
      run({ paymentEvents: [pev("payment_failed", 5), pev("payment_failed", 3)] }),
    ).not.toContain("payment_failure_cycling");
  });
});

describe("renewal_avoidance", () => {
  it("fires on repeated cancellations timed within 3 days of renewal", () => {
    const match = detected(
      {
        behaviouralEvents: [
          bev("subscription_cancelled", 40, { daysToRenewal: 1 }),
          bev("subscription_cancelled", 10, { daysToRenewal: 2 }),
        ],
      },
      "renewal_avoidance",
    );
    expect(match).toBeDefined();
    expect(match!.evidence.some((e) => e.code === "cancel_before_renewal")).toBe(true);
  });

  it("does NOT fire when cancellations are well away from renewal", () => {
    expect(
      run({
        behaviouralEvents: [
          bev("subscription_cancelled", 40, { daysToRenewal: 20 }),
          bev("subscription_cancelled", 10, { daysToRenewal: 25 }),
        ],
      }),
    ).not.toContain("renewal_avoidance");
  });
});

describe("grace_period_value_extraction", () => {
  it("fires on >=2 usage events during unpaid/grace periods", () => {
    const match = detected(
      {
        behaviouralEvents: [
          bev("grace_period_usage", 10, { duringUnpaidPeriod: true }),
          bev("feature_usage", 5, { duringUnpaidPeriod: true }),
        ],
      },
      "grace_period_value_extraction",
    );
    expect(match).toBeDefined();
    expect(match!.evidence.length).toBeGreaterThan(0);
  });

  it("does NOT fire on ordinary paid-period feature usage", () => {
    expect(
      run({
        behaviouralEvents: [
          bev("feature_usage", 10, { duringUnpaidPeriod: false }),
          bev("feature_usage", 5, { duringUnpaidPeriod: false }),
        ],
      }),
    ).not.toContain("grace_period_value_extraction");
  });
});

describe("cancel_use_resubscribe_loop", () => {
  it("fires on cancel -> use-while-unpaid -> resubscribe", () => {
    const match = detected(
      {
        behaviouralEvents: [
          bev("subscription_cancelled", 30),
          bev("grace_period_usage", 25, { duringUnpaidPeriod: true }),
          bev("subscription_resubscribed", 20),
        ],
      },
      "cancel_use_resubscribe_loop",
    );
    expect(match).toBeDefined();
    expect(match!.severity).toBeGreaterThan(0);
  });

  it("does NOT fire when a cancel is followed by resubscribe with no unpaid usage", () => {
    expect(
      run({
        behaviouralEvents: [
          bev("subscription_cancelled", 30),
          bev("subscription_resubscribed", 20),
        ],
      }),
    ).not.toContain("cancel_use_resubscribe_loop");
  });
});

describe("benign history overall", () => {
  it("a healthy paying customer triggers no patterns", () => {
    expect(
      run({
        paymentEvents: [pev("payment_succeeded", 60), pev("payment_succeeded", 30)],
        behaviouralEvents: [bev("feature_usage", 10, { duringUnpaidPeriod: false })],
      }),
    ).toHaveLength(0);
  });
});
