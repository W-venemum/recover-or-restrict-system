/**
 * Revenue-at-risk aggregation.
 *
 * A PURE function that summarises portfolio revenue health from subscriptions
 * and their latest decisions. No I/O and no dependency on the LLM. All amounts
 * are in the smallest currency unit (e.g. paise) to match the domain model.
 *
 * Bucketing rules (deterministic):
 *  - recovered:  latest outcome RECOVER, or subscription back to ACTIVE
 *  - atRisk:     latest outcome INTERVENE (or RESTRICT while still recoverable)
 *  - pending:    a recovery action is recommended and not yet resolved
 *  - lost:       latest outcome SUSPEND (access effectively lost)
 */

import type {
  AccessState,
  DecisionOutcome,
  RecoveryAction,
  RiskBand,
  Subscription,
} from "../domain/types.js";

/** Minimal decision view the revenue engine needs (subset of a stored decision). */
export interface RevenueDecisionView {
  customerId: string;
  subscriptionId?: string;
  outcome: DecisionOutcome;
  confidence: number;
  recommendedAction?: RecoveryAction;
  blacklistRecommended: boolean;
  riskScore?: number;
  riskBand?: RiskBand;
  nextAccessState?: AccessState;
}

export interface HighPriorityCustomer {
  customerId: string;
  subscriptionId: string;
  amount: number;
  outcome: DecisionOutcome;
  riskScore: number;
  /** Composite urgency used for ranking (higher = more urgent). */
  priority: number;
}

export interface PredictedFailure {
  customerId: string;
  subscriptionId: string;
  nextRenewalAt: string;
  amount: number;
  /** Estimated probability of failure at the upcoming renewal, 0..1. */
  probability: number;
  riskBand: RiskBand;
}

export interface RevenueSummary {
  currency: string;
  totalSubscriptionRevenue: number;
  recoveredRevenue: number;
  revenueAtRisk: number;
  pendingRecovery: number;
  lostRevenue: number;
  /** recoveredRevenue / (recoveredRevenue + revenueAtRisk + lostRevenue), 0..1. */
  recoveryRate: number;
  riskDistribution: Record<RiskBand, number>;
  restrictedCount: number;
  suspendedCount: number;
  activeCount: number;
  highestPriorityCustomers: HighPriorityCustomer[];
  predictedFailures: PredictedFailure[];
}

export interface RevenueInput {
  subscriptions: Subscription[];
  /** Latest decision per subscription (or per customer). */
  decisions: RevenueDecisionView[];
  /** ISO anchor timestamp for "upcoming" renewal detection; defaults to now. */
  asOf?: string;
  /** Window (days) treated as an "upcoming" renewal. Default 14. */
  upcomingRenewalDays?: number;
  /** Max customers to return in highestPriorityCustomers. Default 5. */
  topN?: number;
}

const OUTCOME_PRIORITY: Record<DecisionOutcome, number> = {
  RECOVER: 1,
  INTERVENE: 2,
  RESTRICT: 3,
  SUSPEND: 4,
};

function bandFromScore(score: number): RiskBand {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

/** Map a decision to the probability weight used for predicted failures. */
function failureProbability(view: RevenueDecisionView | undefined): number {
  if (!view) return 0.05;
  const base =
    view.outcome === "SUSPEND"
      ? 0.9
      : view.outcome === "RESTRICT"
        ? 0.7
        : view.outcome === "INTERVENE"
          ? 0.45
          : 0.15;
  // Blend with the risk score when available.
  if (typeof view.riskScore === "number") {
    return round2((base + view.riskScore / 100) / 2);
  }
  return base;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Aggregate revenue-at-risk metrics. Deterministic and pure.
 */
export function summariseRevenue(input: RevenueInput): RevenueSummary {
  const asOf = input.asOf ? Date.parse(input.asOf) : Date.now();
  const upcomingDays = input.upcomingRenewalDays ?? 14;
  const topN = input.topN ?? 5;

  // Index the latest decision by subscription id, falling back to customer id.
  const bySubscription = new Map<string, RevenueDecisionView>();
  const byCustomer = new Map<string, RevenueDecisionView>();
  for (const d of input.decisions) {
    if (d.subscriptionId) bySubscription.set(d.subscriptionId, d);
    byCustomer.set(d.customerId, d);
  }
  const decisionFor = (s: Subscription): RevenueDecisionView | undefined =>
    bySubscription.get(s.id) ?? byCustomer.get(s.customerId);

  let totalSubscriptionRevenue = 0;
  let recoveredRevenue = 0;
  let revenueAtRisk = 0;
  let pendingRecovery = 0;
  let lostRevenue = 0;
  let restrictedCount = 0;
  let suspendedCount = 0;
  let activeCount = 0;
  const riskDistribution: Record<RiskBand, number> = { low: 0, medium: 0, high: 0 };
  const currency = input.subscriptions[0]?.currency ?? "INR";

  const priorityRows: HighPriorityCustomer[] = [];
  const predicted: PredictedFailure[] = [];

  for (const s of input.subscriptions) {
    totalSubscriptionRevenue += s.amount;
    const view = decisionFor(s);
    const outcome = view?.outcome ?? "RECOVER";
    const riskScore =
      view?.riskScore ??
      (outcome === "SUSPEND"
        ? 90
        : outcome === "RESTRICT"
          ? 75
          : outcome === "INTERVENE"
            ? 50
            : 15);
    const band = view?.riskBand ?? bandFromScore(riskScore);
    riskDistribution[band] += 1;

    // Access-state counters.
    if (s.accessState === "RESTRICTED") restrictedCount += 1;
    else if (
      s.accessState === "SUSPENDED" ||
      s.accessState === "BLACKLIST_RECOMMENDED"
    ) {
      suspendedCount += 1;
    } else if (s.accessState === "ACTIVE") activeCount += 1;

    // Revenue bucketing.
    switch (outcome) {
      case "RECOVER":
        if (s.accessState === "ACTIVE") recoveredRevenue += s.amount;
        else {
          pendingRecovery += s.amount;
          revenueAtRisk += s.amount;
        }
        break;
      case "INTERVENE":
        revenueAtRisk += s.amount;
        if (view?.recommendedAction) pendingRecovery += s.amount;
        break;
      case "RESTRICT":
        revenueAtRisk += s.amount;
        if (view?.recommendedAction) pendingRecovery += s.amount;
        break;
      case "SUSPEND":
        lostRevenue += s.amount;
        break;
      default:
        break;
    }

    // Priority ranking (only for non-recovered, revenue-bearing subs).
    if (outcome !== "RECOVER" || s.accessState !== "ACTIVE") {
      const priority =
        OUTCOME_PRIORITY[outcome] * 1_000_000 +
        s.amount +
        riskScore * 1_000;
      priorityRows.push({
        customerId: s.customerId,
        subscriptionId: s.id,
        amount: s.amount,
        outcome,
        riskScore,
        priority,
      });
    }

    // Predicted failures on upcoming renewals.
    if (s.nextRenewalAt) {
      const renewalTime = Date.parse(s.nextRenewalAt);
      if (Number.isFinite(renewalTime)) {
        const daysAway = (renewalTime - asOf) / (1000 * 60 * 60 * 24);
        if (daysAway >= 0 && daysAway <= upcomingDays) {
          const probability = failureProbability(view);
          if (probability >= 0.3) {
            predicted.push({
              customerId: s.customerId,
              subscriptionId: s.id,
              nextRenewalAt: s.nextRenewalAt,
              amount: s.amount,
              probability,
              riskBand: band,
            });
          }
        }
      }
    }
  }

  const denom = recoveredRevenue + revenueAtRisk + lostRevenue;
  const recoveryRate = denom > 0 ? round2(recoveredRevenue / denom) : 0;

  priorityRows.sort((a, b) => b.priority - a.priority);
  predicted.sort((a, b) => b.probability - a.probability || b.amount - a.amount);

  return {
    currency,
    totalSubscriptionRevenue,
    recoveredRevenue,
    revenueAtRisk,
    pendingRecovery,
    lostRevenue,
    recoveryRate,
    riskDistribution,
    restrictedCount,
    suspendedCount,
    activeCount,
    highestPriorityCustomers: priorityRows.slice(0, topN),
    predictedFailures: predicted,
  };
}
