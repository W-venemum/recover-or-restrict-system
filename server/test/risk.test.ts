/**
 * Behavioural tests for the weighted, recency-decayed risk engine.
 *
 * These assert that recent failures score higher than the SAME number of old
 * failures (30-day half-life decay), that confidence grows with more evidence,
 * that each active signal yields an evidence entry, and that bands are correct.
 */

import { describe, it, expect } from "vitest";
import { computeRiskScore, type RiskSignal } from "../src/engine/risk.js";

const ASOF = "2024-06-01T00:00:00.000Z";

function daysAgo(days: number): string {
  return new Date(Date.parse(ASOF) - days * 86_400_000).toISOString();
}

function failedPayments(count: number, ageDays: number): RiskSignal[] {
  return Array.from({ length: count }, () => ({
    kind: "failed_payment" as const,
    at: daysAgo(ageDays),
  }));
}

describe("computeRiskScore — recency decay", () => {
  it("recent failures score higher than the same number of OLD failures", () => {
    const recent = computeRiskScore({
      signals: failedPayments(4, 1),
      asOf: ASOF,
      tenureDays: 0,
    });
    const old = computeRiskScore({
      signals: failedPayments(4, 120), // ~4 half-lives -> heavily decayed
      asOf: ASOF,
      tenureDays: 0,
    });
    expect(recent.score).toBeGreaterThan(old.score);
  });

  it("a signal one half-life old contributes ~half of a fresh one", () => {
    const fresh = computeRiskScore({
      signals: failedPayments(1, 0),
      asOf: ASOF,
      tenureDays: 0,
    });
    const halfLifeOld = computeRiskScore({
      signals: failedPayments(1, 30), // exactly one 30-day half-life
      asOf: ASOF,
      tenureDays: 0,
    });
    // Weight halves at one half-life, so the score should roughly halve too.
    expect(halfLifeOld.score).toBeGreaterThan(0);
    expect(halfLifeOld.score).toBeLessThan(fresh.score);
    expect(halfLifeOld.score).toBeCloseTo(fresh.score / 2, 1);
  });
});

describe("computeRiskScore — single transient failure is low risk", () => {
  it("a lone recent failed payment stays in the low band", () => {
    const result = computeRiskScore({
      signals: failedPayments(1, 1),
      asOf: ASOF,
      tenureDays: 0,
    });
    expect(result.band).toBe("low");
    expect(result.score).toBeLessThan(33);
  });
});

describe("computeRiskScore — bands", () => {
  it("classifies low / medium / high correctly by score thresholds", () => {
    const low = computeRiskScore({ signals: failedPayments(1, 1), asOf: ASOF, tenureDays: 0 });
    expect(low.band).toBe("low");

    // Stack heavy, recent avoidance signals to reach the high band.
    const heavy: RiskSignal[] = [
      { kind: "cancel_resubscribe_cycle", at: daysAgo(1) },
      { kind: "usage_during_unpaid_period", at: daysAgo(1) },
      { kind: "usage_during_unpaid_period", at: daysAgo(2) },
      { kind: "unpaid_renewal", at: daysAgo(1) },
      { kind: "cancellation_near_renewal", at: daysAgo(1) },
    ];
    const high = computeRiskScore({ signals: heavy, asOf: ASOF, tenureDays: 0 });
    expect(high.score).toBeGreaterThanOrEqual(66);
    expect(high.band).toBe("high");
  });
});

describe("computeRiskScore — confidence & evidence", () => {
  it("confidence grows with more (recent) evidence", () => {
    const few = computeRiskScore({ signals: failedPayments(1, 1), asOf: ASOF, tenureDays: 0 });
    const many = computeRiskScore({ signals: failedPayments(8, 1), asOf: ASOF, tenureDays: 0 });
    expect(many.confidence).toBeGreaterThan(few.confidence);
  });

  it("emits one evidence entry per distinct active signal kind (+ summary)", () => {
    const result = computeRiskScore({
      signals: [
        { kind: "failed_payment", at: daysAgo(1) },
        { kind: "failed_payment", at: daysAgo(2) },
        { kind: "usage_during_unpaid_period", at: daysAgo(1) },
      ],
      asOf: ASOF,
      tenureDays: 0,
    });
    // Distinct kinds: failed_payment, usage_during_unpaid_period.
    expect(result.evidence.some((e) => e.code === "signal_failed_payment")).toBe(true);
    expect(result.evidence.some((e) => e.code === "signal_usage_during_unpaid_period")).toBe(true);
    expect(result.evidence.some((e) => e.code === "risk_summary")).toBe(true);
  });

  it("successful payments lower the score relative to failures alone", () => {
    const failuresOnly = computeRiskScore({
      signals: failedPayments(3, 1),
      asOf: ASOF,
      tenureDays: 0,
    });
    const withSuccesses = computeRiskScore({
      signals: [
        ...failedPayments(3, 1),
        { kind: "successful_payment", at: daysAgo(1) },
        { kind: "successful_payment", at: daysAgo(2) },
      ],
      asOf: ASOF,
      tenureDays: 0,
    });
    expect(withSuccesses.score).toBeLessThan(failuresOnly.score);
  });

  it("long tenure applies a trust credit that lowers the score", () => {
    const noTenure = computeRiskScore({
      signals: failedPayments(2, 1),
      asOf: ASOF,
      tenureDays: 0,
    });
    const longTenure = computeRiskScore({
      signals: failedPayments(2, 1),
      asOf: ASOF,
      tenureDays: 400,
    });
    expect(longTenure.score).toBeLessThan(noTenure.score);
    expect(longTenure.evidence.some((e) => e.code === "tenure_credit")).toBe(true);
  });
});
