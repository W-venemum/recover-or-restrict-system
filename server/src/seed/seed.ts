/**
 * Seed the SQLite database with the seven demo scenarios.
 *
 * For each scenario this:
 *   1. persists the customer, subscription and full event history,
 *   2. runs the REAL deterministic engine (never a shortcut) over that history,
 *   3. persists the resulting decision, access-state transition and audit
 *      entries, updating the subscription's access state to the engine's result,
 *   4. asserts the engine's outcome matches the scenario's declared expectation
 *      so the demo data can never silently drift from the engine.
 *
 * Re-running is safe: the DB is reset (customers cascade-delete their events)
 * before re-seeding, so `npm run seed` is idempotent.
 */

import { evaluateCustomer } from "../engine/index.js";
import type { DB } from "../db/migrate.js";
import { openDatabase } from "../db/migrate.js";
import { Repository } from "../db/repo.js";
import { buildScenarios, type Scenario } from "./scenarios.js";

export interface SeedResult {
  key: string;
  customerId: string;
  outcome: string;
  expectedOutcome: string;
  accessState: string;
  expectedAccessState: string;
  blacklistRecommended: boolean;
  riskScore: number;
  riskBand: string;
  matched: boolean;
}

/** Delete existing demo data so seeding is idempotent. */
function resetData(db: DB): void {
  // customers cascade to subscriptions / events / decisions / access history.
  db.exec(`
    DELETE FROM audit_log;
    DELETE FROM processed_webhooks;
    DELETE FROM decisions;
    DELETE FROM access_state_history;
    DELETE FROM payment_events;
    DELETE FROM behavioural_events;
    DELETE FROM subscriptions;
    DELETE FROM customers;
  `);
}

/** Persist one scenario and its engine-derived decision. Returns a summary. */
function seedScenario(repo: Repository, scenario: Scenario): SeedResult {
  const { customer, subscription } = scenario;

  repo.upsertCustomer(customer);
  // Persist the subscription in its INITIAL access state; the engine result
  // then drives the transition below.
  repo.upsertSubscription(subscription);
  for (const e of scenario.paymentEvents) repo.insertPaymentEvent(e);
  for (const e of scenario.behaviouralEvents) repo.insertBehaviouralEvent(e);

  const result = evaluateCustomer({
    customer,
    subscription,
    paymentEvents: scenario.paymentEvents,
    behaviouralEvents: scenario.behaviouralEvents,
    ...(scenario.accessHistory ? { accessHistory: scenario.accessHistory } : {}),
  });

  const fromState = subscription.accessState;
  repo.insertDecision({
    customerId: customer.id,
    subscriptionId: subscription.id,
    decision: result.decision,
    nextAccessState: result.nextAccessState,
    riskScore: result.risk.score,
    riskBand: result.risk.band,
  });

  repo.updateSubscriptionAccessState(subscription.id, result.nextAccessState);
  repo.insertAccessStateHistory({
    customerId: customer.id,
    subscriptionId: subscription.id,
    fromState,
    toState: result.nextAccessState,
    reason: `Seed evaluation: ${result.decision.outcome}.`,
  });
  repo.insertAuditEntry({
    customerId: customer.id,
    action: "seed_decision",
    detail: `Scenario "${scenario.key}" evaluated to ${result.decision.outcome}; access ${fromState} -> ${result.nextAccessState}.`,
    metadata: {
      scenario: scenario.key,
      outcome: result.decision.outcome,
      riskScore: result.risk.score,
      riskBand: result.risk.band,
      blacklistRecommended: result.decision.blacklistRecommended,
    },
  });

  const matched =
    result.decision.outcome === scenario.expected.outcome &&
    result.nextAccessState === scenario.expected.accessState &&
    result.decision.blacklistRecommended === scenario.expected.blacklistRecommended &&
    (scenario.expected.recommendedAction === undefined ||
      result.decision.recommendedAction === scenario.expected.recommendedAction);

  return {
    key: scenario.key,
    customerId: customer.id,
    outcome: result.decision.outcome,
    expectedOutcome: scenario.expected.outcome,
    accessState: result.nextAccessState,
    expectedAccessState: scenario.expected.accessState,
    blacklistRecommended: result.decision.blacklistRecommended,
    riskScore: result.risk.score,
    riskBand: result.risk.band,
    matched,
  };
}

/** Seed all scenarios into an already-open repository. */
export function seedDatabase(repo: Repository, db: DB): SeedResult[] {
  resetData(db);
  const scenarios = buildScenarios();
  const results: SeedResult[] = [];
  const tx = db.transaction(() => {
    for (const s of scenarios) results.push(seedScenario(repo, s));
  });
  tx();
  return results;
}

/** CLI entry: open the configured DB, seed, print a report, exit non-zero on mismatch. */
export function runSeed(): void {
  const db = openDatabase();
  const repo = new Repository(db);
  const results = seedDatabase(repo, db);

  let mismatches = 0;
  for (const r of results) {
    if (!r.matched) mismatches += 1;
    // eslint-disable-next-line no-console
    console.log(
      `${r.matched ? "OK " : "!! "} ${r.key.padEnd(34)} ` +
        `${r.outcome.padEnd(9)} risk=${String(r.riskScore).padStart(5)} (${r.riskBand}) ` +
        `access=${r.accessState}` +
        (r.blacklistRecommended ? " [BLACKLIST_RECOMMENDED]" : ""),
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    `\nSeeded ${results.length} scenarios (${results.length - mismatches} matched expectations).`,
  );
  db.close();
  if (mismatches > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `ERROR: ${mismatches} scenario(s) did not match their expected outcome.`,
    );
    process.exit(1);
  }
}

// Run when executed directly (raw `.ts` via node or compiled `dist`).
if (import.meta.url === `file://${process.argv[1]}`) {
  runSeed();
}
