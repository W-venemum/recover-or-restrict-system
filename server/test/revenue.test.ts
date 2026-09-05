/**
 * Behavioural tests for the revenue-at-risk aggregation.
 *
 * Uses a fixed fixture set to assert revenue bucketing (recovered / at-risk /
 * pending / lost), recovery rate, risk distribution, priority ordering and
 * predicted failures are computed correctly.
 */

import { describe, it, expect } from "vitest";
import { summariseRevenue, type RevenueInput } from "../src/engine/revenue.js";
import type { RevenueDecisionView } from "../src/engine/revenue.js";
import type { Subscription } from "../src/domain/types.js";

const ASOF = "2024-06-01T00:00:00.000Z";

function sub(
  id: string,
  customerId: string,
  amount: number,
  accessState: Subscription["accessState"],
  nextRenewalAt?: string,
): Subscription {
  return {
    id,
    customerId,
    plan: "Pro Monthly",
    amount,
    currency: "INR",
    startedAt: "2024-01-01T00:00:00.000Z",
    ...(nextRenewalAt ? { nextRenewalAt } : {}),
    accessState,
  };
}

function view(
  customerId: string,
  subscriptionId: string,
  outcome: RevenueDecisionView["outcome"],
  extra: Partial<RevenueDecisionView> = {},
): RevenueDecisionView {
  return {
    customerId,
    subscriptionId,
    outcome,
    confidence: 0.8,
    blacklistRecommended: outcome === "SUSPEND",
    ...extra,
  };
}

function fixture(): RevenueInput {
  const subscriptions: Subscription[] = [
    sub("s1", "c1", 49900, "ACTIVE"), // recovered
    sub("s2", "c2", 49900, "RECOVERY"), // intervene -> at risk + pending
    sub("s3", "c3", 99900, "RESTRICTED"), // restrict -> at risk + pending
    sub("s4", "c4", 149900, "SUSPENDED"), // suspend -> lost
  ];
  const decisions: RevenueDecisionView[] = [
    view("c1", "s1", "RECOVER", { riskScore: 10, riskBand: "low" }),
    view("c2", "s2", "INTERVENE", {
      riskScore: 50,
      riskBand: "medium",
      recommendedAction: "retry",
    }),
    view("c3", "s3", "RESTRICT", {
      riskScore: 75,
      riskBand: "high",
      recommendedAction: "update_payment_method",
    }),
    view("c4", "s4", "SUSPEND", { riskScore: 92, riskBand: "high" }),
  ];
  return { subscriptions, decisions, asOf: ASOF };
}

describe("summariseRevenue — bucketing", () => {
  const summary = summariseRevenue(fixture());

  it("sums total subscription revenue", () => {
    expect(summary.totalSubscriptionRevenue).toBe(49900 + 49900 + 99900 + 149900);
  });

  it("counts an ACTIVE + RECOVER subscription as recovered revenue", () => {
    expect(summary.recoveredRevenue).toBe(49900);
  });

  it("counts INTERVENE + RESTRICT as revenue at risk", () => {
    expect(summary.revenueAtRisk).toBe(49900 + 99900);
  });

  it("counts pending recovery where a recommended action exists", () => {
    expect(summary.pendingRecovery).toBe(49900 + 99900);
  });

  it("counts SUSPEND as lost revenue", () => {
    expect(summary.lostRevenue).toBe(149900);
  });

  it("computes recovery rate = recovered / (recovered + atRisk + lost)", () => {
    const denom = 49900 + (49900 + 99900) + 149900;
    expect(summary.recoveryRate).toBeCloseTo(49900 / denom, 2);
  });
});

describe("summariseRevenue — counts & distribution", () => {
  const summary = summariseRevenue(fixture());

  it("tallies access-state counters", () => {
    expect(summary.activeCount).toBe(1);
    expect(summary.restrictedCount).toBe(1);
    expect(summary.suspendedCount).toBe(1);
  });

  it("builds the risk distribution from the decision bands", () => {
    expect(summary.riskDistribution).toEqual({ low: 1, medium: 1, high: 2 });
  });
});

describe("summariseRevenue — priority ordering", () => {
  const summary = summariseRevenue(fixture());

  it("orders the highest-priority customers most-urgent-first (SUSPEND before RESTRICT before INTERVENE)", () => {
    const outcomes = summary.highestPriorityCustomers.map((c) => c.outcome);
    expect(outcomes[0]).toBe("SUSPEND");
    expect(outcomes[1]).toBe("RESTRICT");
    expect(outcomes[2]).toBe("INTERVENE");
    // The recovered/active customer is not a priority row.
    expect(summary.highestPriorityCustomers.every((c) => c.outcome !== "RECOVER")).toBe(true);
  });

  it("priority values are strictly decreasing", () => {
    const priorities = summary.highestPriorityCustomers.map((c) => c.priority);
    for (let i = 1; i < priorities.length; i++) {
      expect(priorities[i - 1]).toBeGreaterThan(priorities[i]!);
    }
  });

  it("passes through the stored recommendedAction for priority rows (no ranking change)", () => {
    const byCustomer = new Map(
      summary.highestPriorityCustomers.map((c) => [c.customerId, c]),
    );
    // c3 (RESTRICT) had recommendedAction update_payment_method in the fixture.
    expect(byCustomer.get("c3")?.recommendedAction).toBe("update_payment_method");
    // c2 (INTERVENE) had recommendedAction retry.
    expect(byCustomer.get("c2")?.recommendedAction).toBe("retry");
    // c4 (SUSPEND) had no recommendedAction, so the field stays absent.
    expect(byCustomer.get("c4")?.recommendedAction).toBeUndefined();
  });
});

describe("summariseRevenue — predicted failures on upcoming renewals", () => {
  it("flags high-probability upcoming renewals within the window", () => {
    const soon = new Date(Date.parse(ASOF) + 5 * 86_400_000).toISOString();
    const input: RevenueInput = {
      subscriptions: [sub("s5", "c5", 49900, "RESTRICTED", soon)],
      decisions: [view("c5", "s5", "RESTRICT", { riskScore: 80, riskBand: "high" })],
      asOf: ASOF,
    };
    const summary = summariseRevenue(input);
    expect(summary.predictedFailures.length).toBe(1);
    expect(summary.predictedFailures[0]!.probability).toBeGreaterThanOrEqual(0.3);
  });

  it("does not flag renewals far in the future", () => {
    const far = new Date(Date.parse(ASOF) + 90 * 86_400_000).toISOString();
    const input: RevenueInput = {
      subscriptions: [sub("s6", "c6", 49900, "RESTRICTED", far)],
      decisions: [view("c6", "s6", "RESTRICT", { riskScore: 80, riskBand: "high" })],
      asOf: ASOF,
    };
    expect(summariseRevenue(input).predictedFailures).toHaveLength(0);
  });
});
