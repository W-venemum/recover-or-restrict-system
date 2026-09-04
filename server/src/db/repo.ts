/**
 * Typed repository over the SQLite database.
 *
 * Maps between snake_case DB rows and the camelCase domain types from
 * `../domain/types.ts`. All methods are synchronous (better-sqlite3). JSON
 * columns (evidence, metadata) are parsed/serialised at this boundary so the
 * rest of the app only ever sees domain objects.
 */

import { randomUUID } from "node:crypto";
import type {
  AccessState,
  BehaviouralEvent,
  BehaviouralEventMetadata,
  BehaviouralEventType,
  Customer,
  Decision,
  DecisionOutcome,
  Evidence,
  PaymentEvent,
  PaymentEventType,
  RecoveryAction,
  RiskBand,
  Subscription,
} from "../domain/types.js";
import type { DB } from "./migrate.js";

// ---------------------------------------------------------------------------
// Persisted-decision shape (domain Decision + persistence-only fields)
// ---------------------------------------------------------------------------

/** A decision as stored/returned by the repository. */
export interface StoredDecision {
  id: string;
  customerId: string;
  subscriptionId?: string;
  outcome: DecisionOutcome;
  confidence: number;
  recommendedAction?: RecoveryAction;
  expectedRecoveryOutcome?: string;
  blacklistRecommended: boolean;
  nextAccessState: AccessState;
  riskScore?: number;
  riskBand?: RiskBand;
  evidence: Evidence[];
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  customerId?: string;
  action: string;
  detail?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface AccessStateHistoryEntry {
  id: string;
  customerId: string;
  subscriptionId?: string;
  fromState?: AccessState;
  toState: AccessState;
  reason?: string;
  createdAt: string;
}

/** A customer joined with its subscriptions and all events. */
export interface CustomerWithEvents {
  customer: Customer;
  subscriptions: Subscription[];
  paymentEvents: PaymentEvent[];
  behaviouralEvents: BehaviouralEvent[];
}

/** A customer list row with its most recent decision (if any). */
export interface CustomerWithLatestDecision {
  customer: Customer;
  subscriptions: Subscription[];
  latestDecision?: StoredDecision;
}

// ---------------------------------------------------------------------------
// Row types (snake_case, as stored)
// ---------------------------------------------------------------------------

interface CustomerRow {
  id: string;
  name: string;
  email: string | null;
  created_at: string;
}

interface SubscriptionRow {
  id: string;
  customer_id: string;
  plan: string;
  amount: number;
  currency: string;
  started_at: string;
  next_renewal_at: string | null;
  access_state: string;
}

interface PaymentEventRow {
  id: string;
  customer_id: string;
  subscription_id: string;
  type: string;
  timestamp: string;
  amount: number | null;
  currency: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  attempt: number | null;
}

interface BehaviouralEventRow {
  id: string;
  customer_id: string;
  subscription_id: string | null;
  type: string;
  timestamp: string;
  metadata: string | null;
}

interface DecisionRow {
  id: string;
  customer_id: string;
  subscription_id: string | null;
  outcome: string;
  confidence: number;
  recommended_action: string | null;
  expected_outcome: string | null;
  blacklist_recommended: number;
  next_access_state: string;
  risk_score: number | null;
  risk_band: string | null;
  evidence: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Row -> domain mappers
// ---------------------------------------------------------------------------

function toCustomer(r: CustomerRow): Customer {
  return {
    id: r.id,
    name: r.name,
    ...(r.email !== null ? { email: r.email } : {}),
    createdAt: r.created_at,
  };
}

function toSubscription(r: SubscriptionRow): Subscription {
  return {
    id: r.id,
    customerId: r.customer_id,
    plan: r.plan,
    amount: r.amount,
    currency: r.currency,
    startedAt: r.started_at,
    ...(r.next_renewal_at !== null ? { nextRenewalAt: r.next_renewal_at } : {}),
    accessState: r.access_state as AccessState,
  };
}

function toPaymentEvent(r: PaymentEventRow): PaymentEvent {
  return {
    id: r.id,
    customerId: r.customer_id,
    subscriptionId: r.subscription_id,
    type: r.type as PaymentEventType,
    timestamp: r.timestamp,
    ...(r.amount !== null ? { amount: r.amount } : {}),
    ...(r.currency !== null ? { currency: r.currency } : {}),
    ...(r.failure_code !== null ? { failureCode: r.failure_code } : {}),
    ...(r.failure_reason !== null ? { failureReason: r.failure_reason } : {}),
    ...(r.attempt !== null ? { attempt: r.attempt } : {}),
  };
}

function toBehaviouralEvent(r: BehaviouralEventRow): BehaviouralEvent {
  const metadata = r.metadata
    ? (JSON.parse(r.metadata) as BehaviouralEventMetadata)
    : undefined;
  return {
    id: r.id,
    customerId: r.customer_id,
    ...(r.subscription_id !== null ? { subscriptionId: r.subscription_id } : {}),
    type: r.type as BehaviouralEventType,
    timestamp: r.timestamp,
    ...(metadata ? { metadata } : {}),
  };
}

function toStoredDecision(r: DecisionRow): StoredDecision {
  return {
    id: r.id,
    customerId: r.customer_id,
    ...(r.subscription_id !== null ? { subscriptionId: r.subscription_id } : {}),
    outcome: r.outcome as DecisionOutcome,
    confidence: r.confidence,
    ...(r.recommended_action !== null
      ? { recommendedAction: r.recommended_action as RecoveryAction }
      : {}),
    ...(r.expected_outcome !== null
      ? { expectedRecoveryOutcome: r.expected_outcome }
      : {}),
    blacklistRecommended: r.blacklist_recommended === 1,
    nextAccessState: r.next_access_state as AccessState,
    ...(r.risk_score !== null ? { riskScore: r.risk_score } : {}),
    ...(r.risk_band !== null ? { riskBand: r.risk_band as RiskBand } : {}),
    evidence: JSON.parse(r.evidence) as Evidence[],
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class Repository {
  private readonly db: DB;

  constructor(db: DB) {
    this.db = db;
  }

  // --- Customers ----------------------------------------------------------

  upsertCustomer(c: Customer): void {
    this.db
      .prepare(
        `INSERT INTO customers (id, name, email, created_at)
         VALUES (@id, @name, @email, @created_at)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = excluded.email`,
      )
      .run({
        id: c.id,
        name: c.name,
        email: c.email ?? null,
        created_at: c.createdAt,
      });
  }

  getCustomer(id: string): Customer | undefined {
    const row = this.db
      .prepare(`SELECT * FROM customers WHERE id = ?`)
      .get(id) as CustomerRow | undefined;
    return row ? toCustomer(row) : undefined;
  }

  listCustomerRows(): Customer[] {
    const rows = this.db
      .prepare(`SELECT * FROM customers ORDER BY created_at ASC`)
      .all() as CustomerRow[];
    return rows.map(toCustomer);
  }

  // --- Subscriptions ------------------------------------------------------

  upsertSubscription(s: Subscription): void {
    this.db
      .prepare(
        `INSERT INTO subscriptions
           (id, customer_id, plan, amount, currency, started_at, next_renewal_at, access_state)
         VALUES
           (@id, @customer_id, @plan, @amount, @currency, @started_at, @next_renewal_at, @access_state)
         ON CONFLICT(id) DO UPDATE SET
           plan = excluded.plan,
           amount = excluded.amount,
           currency = excluded.currency,
           next_renewal_at = excluded.next_renewal_at,
           access_state = excluded.access_state`,
      )
      .run({
        id: s.id,
        customer_id: s.customerId,
        plan: s.plan,
        amount: s.amount,
        currency: s.currency,
        started_at: s.startedAt,
        next_renewal_at: s.nextRenewalAt ?? null,
        access_state: s.accessState,
      });
  }

  updateSubscriptionAccessState(id: string, state: AccessState): void {
    this.db
      .prepare(`UPDATE subscriptions SET access_state = ? WHERE id = ?`)
      .run(state, id);
  }

  getSubscriptionsForCustomer(customerId: string): Subscription[] {
    const rows = this.db
      .prepare(`SELECT * FROM subscriptions WHERE customer_id = ? ORDER BY started_at ASC`)
      .all(customerId) as SubscriptionRow[];
    return rows.map(toSubscription);
  }

  listSubscriptions(): Subscription[] {
    const rows = this.db
      .prepare(`SELECT * FROM subscriptions`)
      .all() as SubscriptionRow[];
    return rows.map(toSubscription);
  }

  // --- Payment events -----------------------------------------------------

  insertPaymentEvent(e: PaymentEvent): void {
    this.db
      .prepare(
        `INSERT INTO payment_events
           (id, customer_id, subscription_id, type, timestamp, amount, currency, failure_code, failure_reason, attempt)
         VALUES
           (@id, @customer_id, @subscription_id, @type, @timestamp, @amount, @currency, @failure_code, @failure_reason, @attempt)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run({
        id: e.id,
        customer_id: e.customerId,
        subscription_id: e.subscriptionId,
        type: e.type,
        timestamp: e.timestamp,
        amount: e.amount ?? null,
        currency: e.currency ?? null,
        failure_code: e.failureCode ?? null,
        failure_reason: e.failureReason ?? null,
        attempt: e.attempt ?? null,
      });
  }

  getPaymentEventsForCustomer(customerId: string): PaymentEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM payment_events WHERE customer_id = ? ORDER BY timestamp ASC`)
      .all(customerId) as PaymentEventRow[];
    return rows.map(toPaymentEvent);
  }

  // --- Behavioural events -------------------------------------------------

  insertBehaviouralEvent(e: BehaviouralEvent): void {
    this.db
      .prepare(
        `INSERT INTO behavioural_events
           (id, customer_id, subscription_id, type, timestamp, metadata)
         VALUES
           (@id, @customer_id, @subscription_id, @type, @timestamp, @metadata)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run({
        id: e.id,
        customer_id: e.customerId,
        subscription_id: e.subscriptionId ?? null,
        type: e.type,
        timestamp: e.timestamp,
        metadata: e.metadata ? JSON.stringify(e.metadata) : null,
      });
  }

  getBehaviouralEventsForCustomer(customerId: string): BehaviouralEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM behavioural_events WHERE customer_id = ? ORDER BY timestamp ASC`)
      .all(customerId) as BehaviouralEventRow[];
    return rows.map(toBehaviouralEvent);
  }

  // --- Decisions ----------------------------------------------------------

  /**
   * Persist a decision. Accepts the pure {@link Decision} plus persistence
   * context (customer/subscription, next access state, risk snapshot).
   */
  insertDecision(input: {
    customerId: string;
    subscriptionId?: string;
    decision: Decision;
    nextAccessState: AccessState;
    riskScore?: number;
    riskBand?: RiskBand;
    createdAt?: string;
  }): StoredDecision {
    const id = randomUUID();
    const createdAt = input.createdAt ?? new Date().toISOString();
    const { decision } = input;
    this.db
      .prepare(
        `INSERT INTO decisions
           (id, customer_id, subscription_id, outcome, confidence, recommended_action,
            expected_outcome, blacklist_recommended, next_access_state, risk_score, risk_band,
            evidence, created_at)
         VALUES
           (@id, @customer_id, @subscription_id, @outcome, @confidence, @recommended_action,
            @expected_outcome, @blacklist_recommended, @next_access_state, @risk_score, @risk_band,
            @evidence, @created_at)`,
      )
      .run({
        id,
        customer_id: input.customerId,
        subscription_id: input.subscriptionId ?? null,
        outcome: decision.outcome,
        confidence: decision.confidence,
        recommended_action: decision.recommendedAction ?? null,
        expected_outcome: decision.expectedRecoveryOutcome ?? null,
        blacklist_recommended: decision.blacklistRecommended ? 1 : 0,
        next_access_state: input.nextAccessState,
        risk_score: input.riskScore ?? null,
        risk_band: input.riskBand ?? null,
        evidence: JSON.stringify(decision.evidence),
        created_at: createdAt,
      });
    return this.getDecision(id)!;
  }

  getDecision(id: string): StoredDecision | undefined {
    const row = this.db
      .prepare(`SELECT * FROM decisions WHERE id = ?`)
      .get(id) as DecisionRow | undefined;
    return row ? toStoredDecision(row) : undefined;
  }

  getLatestDecisionForCustomer(customerId: string): StoredDecision | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM decisions WHERE customer_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(customerId) as DecisionRow | undefined;
    return row ? toStoredDecision(row) : undefined;
  }

  listDecisions(): StoredDecision[] {
    const rows = this.db
      .prepare(`SELECT * FROM decisions ORDER BY created_at DESC`)
      .all() as DecisionRow[];
    return rows.map(toStoredDecision);
  }

  // --- Audit log ----------------------------------------------------------

  insertAuditEntry(entry: {
    customerId?: string;
    action: string;
    detail?: string;
    metadata?: Record<string, unknown>;
    createdAt?: string;
  }): AuditEntry {
    const id = randomUUID();
    const createdAt = entry.createdAt ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO audit_log (id, customer_id, action, detail, metadata, created_at)
         VALUES (@id, @customer_id, @action, @detail, @metadata, @created_at)`,
      )
      .run({
        id,
        customer_id: entry.customerId ?? null,
        action: entry.action,
        detail: entry.detail ?? null,
        metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
        created_at: createdAt,
      });
    return {
      id,
      ...(entry.customerId ? { customerId: entry.customerId } : {}),
      action: entry.action,
      ...(entry.detail ? { detail: entry.detail } : {}),
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
      createdAt,
    };
  }

  listAuditEntries(customerId?: string): AuditEntry[] {
    const rows = (
      customerId
        ? this.db
            .prepare(
              `SELECT * FROM audit_log WHERE customer_id = ? ORDER BY created_at DESC`,
            )
            .all(customerId)
        : this.db.prepare(`SELECT * FROM audit_log ORDER BY created_at DESC`).all()
    ) as {
      id: string;
      customer_id: string | null;
      action: string;
      detail: string | null;
      metadata: string | null;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      ...(r.customer_id !== null ? { customerId: r.customer_id } : {}),
      action: r.action,
      ...(r.detail !== null ? { detail: r.detail } : {}),
      ...(r.metadata !== null
        ? { metadata: JSON.parse(r.metadata) as Record<string, unknown> }
        : {}),
      createdAt: r.created_at,
    }));
  }

  // --- Access state history ----------------------------------------------

  insertAccessStateHistory(entry: {
    customerId: string;
    subscriptionId?: string;
    fromState?: AccessState;
    toState: AccessState;
    reason?: string;
    createdAt?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO access_state_history
           (id, customer_id, subscription_id, from_state, to_state, reason, created_at)
         VALUES (@id, @customer_id, @subscription_id, @from_state, @to_state, @reason, @created_at)`,
      )
      .run({
        id: randomUUID(),
        customer_id: entry.customerId,
        subscription_id: entry.subscriptionId ?? null,
        from_state: entry.fromState ?? null,
        to_state: entry.toState,
        reason: entry.reason ?? null,
        created_at: entry.createdAt ?? new Date().toISOString(),
      });
  }

  // --- Webhook idempotency ------------------------------------------------

  /**
   * Record a webhook event id. Returns true if this is the first time we have
   * seen it (i.e. it should be processed), false if it was already processed.
   */
  markWebhookProcessed(eventId: string, eventType?: string): boolean {
    const info = this.db
      .prepare(
        `INSERT INTO processed_webhooks (event_id, event_type, received_at)
         VALUES (?, ?, ?)
         ON CONFLICT(event_id) DO NOTHING`,
      )
      .run(eventId, eventType ?? null, new Date().toISOString());
    return info.changes === 1;
  }

  hasProcessedWebhook(eventId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM processed_webhooks WHERE event_id = ?`)
      .get(eventId);
    return row !== undefined;
  }

  // --- Composite query helpers -------------------------------------------

  /** Get a customer together with all subscriptions and events. */
  getCustomerWithEvents(customerId: string): CustomerWithEvents | undefined {
    const customer = this.getCustomer(customerId);
    if (!customer) return undefined;
    return {
      customer,
      subscriptions: this.getSubscriptionsForCustomer(customerId),
      paymentEvents: this.getPaymentEventsForCustomer(customerId),
      behaviouralEvents: this.getBehaviouralEventsForCustomer(customerId),
    };
  }

  /** List all customers with their subscriptions and latest decision. */
  listCustomersWithLatestDecision(): CustomerWithLatestDecision[] {
    return this.listCustomerRows().map((customer) => {
      const latest = this.getLatestDecisionForCustomer(customer.id);
      return {
        customer,
        subscriptions: this.getSubscriptionsForCustomer(customer.id),
        ...(latest ? { latestDecision: latest } : {}),
      };
    });
  }
}
