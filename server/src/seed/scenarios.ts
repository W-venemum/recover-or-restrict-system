/**
 * Demo scenario definitions.
 *
 * Seven named, hand-authored scenarios that exercise the full decision engine
 * and, crucially, demonstrate the product's central claim: genuine payment
 * trouble is RECOVERED without penalising the customer, while deliberate
 * behavioural avoidance / value-extraction is RESTRICTED or SUSPENDED.
 *
 * Each scenario carries an `expected` block describing the outcome the engine
 * is designed to reach. The seed runner evaluates every scenario through the
 * REAL engine (never a shortcut) and asserts the outcome matches, so the demo
 * data can never silently drift from the engine's behaviour.
 *
 * Timestamps are expressed as "days ago" relative to a single anchor computed
 * at seed time, keeping the recency-decayed risk model deterministic for the
 * demo run.
 */

import type {
  BehaviouralEvent,
  BehaviouralEventType,
  Customer,
  DecisionOutcome,
  PaymentEvent,
  PaymentEventType,
  RecoveryAction,
  Subscription,
} from "../domain/types.js";
import type { AccessHistory } from "../engine/decision.js";

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** ISO timestamp `days` ago from `anchor` (ms epoch). */
function daysAgo(anchor: number, days: number): string {
  return new Date(anchor - days * MS_PER_DAY).toISOString();
}

/** ISO timestamp `days` in the future from `anchor`. */
function daysAhead(anchor: number, days: number): string {
  return new Date(anchor + days * MS_PER_DAY).toISOString();
}

export interface ScenarioExpectation {
  outcome: DecisionOutcome;
  /** Access state the subscription should settle in after evaluation. */
  accessState: string;
  blacklistRecommended: boolean;
  /** Optional expected recommended recovery action. */
  recommendedAction?: RecoveryAction;
  /** Human-readable summary of the intended story. */
  summary: string;
}

export interface Scenario {
  key: string;
  customer: Customer;
  subscription: Subscription;
  paymentEvents: PaymentEvent[];
  behaviouralEvents: BehaviouralEvent[];
  /** Prior recovery attempts for this episode (drives next-best-action choice). */
  accessHistory?: AccessHistory;
  expected: ScenarioExpectation;
}

// Small builders to keep the scenario data readable.
interface PaymentSpec {
  id: string;
  type: PaymentEventType;
  daysAgo: number;
  amount?: number;
  failureCode?: string;
  failureReason?: string;
  attempt?: number;
}

interface BehaviouralSpec {
  id: string;
  type: BehaviouralEventType;
  daysAgo: number;
  daysToRenewal?: number;
  duringUnpaidPeriod?: boolean;
  feature?: string;
}

function buildPayments(
  anchor: number,
  customerId: string,
  subscriptionId: string,
  currency: string,
  specs: PaymentSpec[],
): PaymentEvent[] {
  return specs.map((s) => ({
    id: s.id,
    customerId,
    subscriptionId,
    type: s.type,
    timestamp: daysAgo(anchor, s.daysAgo),
    ...(s.amount !== undefined ? { amount: s.amount } : {}),
    ...(s.amount !== undefined ? { currency } : {}),
    ...(s.failureCode ? { failureCode: s.failureCode } : {}),
    ...(s.failureReason ? { failureReason: s.failureReason } : {}),
    ...(s.attempt !== undefined ? { attempt: s.attempt } : {}),
  }));
}

function buildBehaviour(
  anchor: number,
  customerId: string,
  subscriptionId: string,
  specs: BehaviouralSpec[],
): BehaviouralEvent[] {
  return specs.map((s) => {
    const metadata: Record<string, unknown> = {};
    if (s.daysToRenewal !== undefined) metadata.daysToRenewal = s.daysToRenewal;
    if (s.duringUnpaidPeriod !== undefined) {
      metadata.duringUnpaidPeriod = s.duringUnpaidPeriod;
    }
    if (s.feature !== undefined) metadata.feature = s.feature;
    return {
      id: s.id,
      customerId,
      subscriptionId,
      type: s.type,
      timestamp: daysAgo(anchor, s.daysAgo),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    } as BehaviouralEvent;
  });
}

/**
 * Build the seven scenarios anchored at `anchor` (ms epoch, defaults to now).
 */
export function buildScenarios(anchor: number = Date.now()): Scenario[] {
  const scenarios: Scenario[] = [];

  // --- Scenario 1: Normal successful customer --------------------------
  {
    const customerId = "cust_normal";
    const subId = "sub_normal";
    scenarios.push({
      key: "normal_success",
      customer: {
        id: customerId,
        name: "Aarav Sharma",
        email: "aarav@example.com",
        createdAt: daysAgo(anchor, 400),
      },
      subscription: {
        id: subId,
        customerId,
        plan: "Pro Monthly",
        amount: 49900,
        currency: "INR",
        startedAt: daysAgo(anchor, 400),
        nextRenewalAt: daysAhead(anchor, 20),
        accessState: "ACTIVE",
      },
      paymentEvents: buildPayments(anchor, customerId, subId, "INR", [
        { id: "pn1", type: "payment_succeeded", daysAgo: 90, amount: 49900 },
        { id: "pn2", type: "payment_succeeded", daysAgo: 60, amount: 49900 },
        { id: "pn3", type: "payment_succeeded", daysAgo: 30, amount: 49900 },
        { id: "pn4", type: "payment_succeeded", daysAgo: 2, amount: 49900 },
      ]),
      behaviouralEvents: [],
      expected: {
        outcome: "RECOVER",
        accessState: "ACTIVE",
        blacklistRecommended: false,
        summary:
          "A healthy, long-tenured customer paying on time. Low risk, access stays ACTIVE.",
      },
    });
  }

  // --- Scenario 2: Genuine temporary failure, then recovered -----------
  {
    const customerId = "cust_transient";
    const subId = "sub_transient";
    scenarios.push({
      key: "genuine_temporary_failure",
      customer: {
        id: customerId,
        name: "Diya Menon",
        email: "diya@example.com",
        createdAt: daysAgo(anchor, 220),
      },
      subscription: {
        id: subId,
        customerId,
        plan: "Pro Monthly",
        amount: 49900,
        currency: "INR",
        startedAt: daysAgo(anchor, 220),
        nextRenewalAt: daysAhead(anchor, 25),
        accessState: "RECOVERY",
      },
      paymentEvents: buildPayments(anchor, customerId, subId, "INR", [
        { id: "pt1", type: "payment_succeeded", daysAgo: 95, amount: 49900 },
        { id: "pt2", type: "payment_succeeded", daysAgo: 65, amount: 49900 },
        {
          id: "pt3",
          type: "payment_failed",
          daysAgo: 5,
          amount: 49900,
          failureCode: "GATEWAY_ERROR",
          failureReason: "Gateway timeout while processing",
          attempt: 1,
        },
        { id: "pt4", type: "payment_succeeded", daysAgo: 4, amount: 49900, attempt: 2 },
      ]),
      behaviouralEvents: [],
      expected: {
        outcome: "RECOVER",
        accessState: "ACTIVE",
        blacklistRecommended: false,
        summary:
          "A one-off transient gateway failure that cleared on the next attempt. Recovered, access restored to ACTIVE.",
      },
    });
  }

  // --- Scenario 3: Recoverable needing alternate intervention ----------
  // Repeated insufficient-funds failures (a GENUINE, recoverable class) where a
  // prior delayed retry did not clear, so the engine escalates the next-best
  // action to an alternate route (UPI link) WITHOUT penalising the customer.
  {
    const customerId = "cust_insufficient";
    const subId = "sub_insufficient";
    scenarios.push({
      key: "recoverable_alternate_intervention",
      customer: {
        id: customerId,
        name: "Rohan Gupta",
        email: "rohan@example.com",
        createdAt: daysAgo(anchor, 150),
      },
      subscription: {
        id: subId,
        customerId,
        plan: "Pro Monthly",
        amount: 49900,
        currency: "INR",
        startedAt: daysAgo(anchor, 150),
        nextRenewalAt: daysAhead(anchor, 3),
        accessState: "RECOVERY",
      },
      paymentEvents: buildPayments(anchor, customerId, subId, "INR", [
        { id: "pi0", type: "payment_succeeded", daysAgo: 70, amount: 49900 },
        {
          id: "pi1",
          type: "payment_failed",
          daysAgo: 6,
          amount: 49900,
          failureCode: "INSUFFICIENT_FUNDS",
          failureReason: "Insufficient funds in account",
          attempt: 1,
        },
        {
          id: "pi2",
          type: "payment_failed",
          daysAgo: 3,
          amount: 49900,
          failureCode: "INSUFFICIENT_FUNDS",
          failureReason: "Insufficient funds in account",
          attempt: 2,
        },
      ]),
      behaviouralEvents: [],
      // A delayed retry was already tried this episode and did not clear, so the
      // engine should offer an alternate payment route (UPI link).
      accessHistory: { attemptedActions: ["delayed_retry"], failedRetries: 1 },
      expected: {
        outcome: "RECOVER",
        accessState: "RECOVERY",
        blacklistRecommended: false,
        recommendedAction: "upi_payment_link",
        summary:
          "Repeated insufficient-funds failures after a delayed retry. Still genuinely recoverable: offer an alternate UPI payment route, no restriction.",
      },
    });
  }

  // --- Scenario 4: Repeated autopay cancellation near renewal ----------
  {
    const customerId = "cust_autopay_cancel";
    const subId = "sub_autopay_cancel";
    scenarios.push({
      key: "autopay_cancel_near_renewal",
      customer: {
        id: customerId,
        name: "Ishita Rao",
        email: "ishita@example.com",
        createdAt: daysAgo(anchor, 120),
      },
      subscription: {
        id: subId,
        customerId,
        plan: "Pro Monthly",
        amount: 49900,
        currency: "INR",
        startedAt: daysAgo(anchor, 120),
        nextRenewalAt: daysAhead(anchor, 2),
        accessState: "ACTIVE",
      },
      paymentEvents: buildPayments(anchor, customerId, subId, "INR", [
        { id: "pa1", type: "autopay_cancelled", daysAgo: 62 },
        { id: "pa2", type: "autopay_cancelled", daysAgo: 32 },
        { id: "pa3", type: "autopay_cancelled", daysAgo: 3 },
      ]),
      behaviouralEvents: buildBehaviour(anchor, customerId, subId, [
        { id: "ba1", type: "subscription_cancelled", daysAgo: 62, daysToRenewal: 1 },
        { id: "ba2", type: "subscription_cancelled", daysAgo: 32, daysToRenewal: 2 },
        { id: "ba3", type: "subscription_cancelled", daysAgo: 3, daysToRenewal: 1 },
      ]),
      expected: {
        outcome: "RESTRICT",
        accessState: "RESTRICTED",
        blacklistRecommended: false,
        summary:
          "Autopay repeatedly cancelled right before renewal, a renewal-avoidance pattern. Access restricted pending resolution.",
      },
    });
  }

  // --- Scenario 5: Cancellation / resubscription cycling ---------------
  {
    const customerId = "cust_cycling";
    const subId = "sub_cycling";
    scenarios.push({
      key: "cancel_resubscribe_cycling",
      customer: {
        id: customerId,
        name: "Kabir Nair",
        email: "kabir@example.com",
        createdAt: daysAgo(anchor, 200),
      },
      subscription: {
        id: subId,
        customerId,
        plan: "Pro Monthly",
        amount: 49900,
        currency: "INR",
        startedAt: daysAgo(anchor, 200),
        nextRenewalAt: daysAhead(anchor, 6),
        accessState: "ACTIVE",
      },
      paymentEvents: [],
      behaviouralEvents: buildBehaviour(anchor, customerId, subId, [
        // Each cancellation is timed right before a renewal, then the customer
        // resubscribes a few days later: a renewal-avoidance cycling pattern
        // (but NO usage during unpaid periods, so it is not value-extraction).
        { id: "bc1", type: "subscription_cancelled", daysAgo: 50, daysToRenewal: 1 },
        { id: "bc2", type: "subscription_resubscribed", daysAgo: 44 },
        { id: "bc3", type: "subscription_cancelled", daysAgo: 26, daysToRenewal: 2 },
        { id: "bc4", type: "subscription_resubscribed", daysAgo: 20 },
        { id: "bc5", type: "subscription_cancelled", daysAgo: 8, daysToRenewal: 1 },
        { id: "bc6", type: "subscription_resubscribed", daysAgo: 4 },
      ]),
      expected: {
        outcome: "RESTRICT",
        accessState: "RESTRICTED",
        blacklistRecommended: false,
        summary:
          "Serial cancel-before-renewal then resubscribe cycling. A strong renewal-avoidance pattern with no genuine payment trouble: access restricted (but not suspended, since nothing is extracted during unpaid periods).",
      },
    });
  }

  // --- Scenario 6: Grace-period value extraction -> SUSPEND + blacklist -
  {
    const customerId = "cust_extraction";
    const subId = "sub_extraction";
    scenarios.push({
      key: "grace_value_extraction",
      customer: {
        id: customerId,
        name: "Meera Iyer",
        email: "meera@example.com",
        createdAt: daysAgo(anchor, 90),
      },
      subscription: {
        id: subId,
        customerId,
        plan: "Pro Monthly",
        amount: 49900,
        currency: "INR",
        startedAt: daysAgo(anchor, 90),
        nextRenewalAt: daysAhead(anchor, 1),
        accessState: "GRACE",
      },
      paymentEvents: buildPayments(anchor, customerId, subId, "INR", [
        {
          id: "pe1",
          type: "payment_failed",
          daysAgo: 20,
          amount: 49900,
          failureCode: "INSUFFICIENT_FUNDS",
          failureReason: "Insufficient funds",
          attempt: 1,
        },
      ]),
      behaviouralEvents: buildBehaviour(anchor, customerId, subId, [
        { id: "be1", type: "subscription_cancelled", daysAgo: 18, daysToRenewal: 1 },
        { id: "be2", type: "grace_period_usage", daysAgo: 16, duringUnpaidPeriod: true, feature: "export" },
        { id: "be3", type: "grace_period_usage", daysAgo: 12, duringUnpaidPeriod: true, feature: "export" },
        { id: "be4", type: "subscription_resubscribed", daysAgo: 11 },
        { id: "be5", type: "subscription_cancelled", daysAgo: 9, daysToRenewal: 2 },
        { id: "be6", type: "grace_period_usage", daysAgo: 7, duringUnpaidPeriod: true, feature: "export" },
        { id: "be7", type: "grace_period_usage", daysAgo: 4, duringUnpaidPeriod: true, feature: "export" },
        { id: "be8", type: "grace_period_usage", daysAgo: 2, duringUnpaidPeriod: true, feature: "export" },
        { id: "be9", type: "subscription_resubscribed", daysAgo: 1 },
      ]),
      expected: {
        outcome: "SUSPEND",
        accessState: "SUSPENDED",
        blacklistRecommended: true,
        summary:
          "Repeatedly cancels, extracts value during unpaid/grace periods, then resubscribes. High-confidence abuse: SUSPEND and RECOMMEND blacklist for human review.",
      },
    });
  }

  // --- Scenario 7: Legitimate repeated failures -> RECOVER, NOT blacklist
  // Different genuine failure reasons (expired card, bank/issuer outage) with
  // genuine retries, ending in a successful payment. Must NOT be treated as
  // abuse and must NOT be blacklisted.
  {
    const customerId = "cust_legit_failures";
    const subId = "sub_legit_failures";
    scenarios.push({
      key: "legitimate_repeated_failures",
      customer: {
        id: customerId,
        name: "Sara DeuxSous",
        email: "sara@example.com",
        createdAt: daysAgo(anchor, 300),
      },
      subscription: {
        id: subId,
        customerId,
        plan: "Pro Monthly",
        amount: 49900,
        currency: "INR",
        startedAt: daysAgo(anchor, 300),
        nextRenewalAt: daysAhead(anchor, 27),
        accessState: "RECOVERY",
      },
      paymentEvents: buildPayments(anchor, customerId, subId, "INR", [
        { id: "pl1", type: "payment_succeeded", daysAgo: 120, amount: 49900 },
        { id: "pl2", type: "payment_succeeded", daysAgo: 90, amount: 49900 },
        {
          id: "pl3",
          type: "payment_failed",
          daysAgo: 9,
          amount: 49900,
          failureCode: "CARD_EXPIRED",
          failureReason: "The card has expired",
          attempt: 1,
        },
        {
          id: "pl4",
          type: "payment_failed",
          daysAgo: 7,
          amount: 49900,
          failureCode: "ISSUER_NOT_AVAILABLE",
          failureReason: "Card issuer temporarily unavailable",
          attempt: 2,
        },
        { id: "pl5", type: "payment_succeeded", daysAgo: 2, amount: 49900, attempt: 3 },
      ]),
      behaviouralEvents: [],
      expected: {
        outcome: "RECOVER",
        accessState: "ACTIVE",
        blacklistRecommended: false,
        summary:
          "Genuine repeated failures (expired card, then a bank/issuer outage) resolved by the customer updating details and paying. Recovered, explicitly NOT blacklisted.",
      },
    });
  }

  return scenarios;
}
