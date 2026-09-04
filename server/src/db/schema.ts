/**
 * SQLite schema (DDL) for the Recover-or-Restrict system.
 *
 * All tables use TEXT primary keys (domain-generated ids) and store timestamps
 * as ISO-8601 strings for portability. JSON blobs (evidence, metadata, raw
 * payloads) are stored as TEXT and parsed at the repository boundary.
 *
 * The schema is idempotent (CREATE TABLE IF NOT EXISTS) so `migrate()` can run
 * safely on every boot.
 */

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS customers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id              TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  plan            TEXT NOT NULL,
  amount          INTEGER NOT NULL,
  currency        TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  next_renewal_at TEXT,
  access_state    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(customer_id);

CREATE TABLE IF NOT EXISTS payment_events (
  id              TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL,
  type            TEXT NOT NULL,
  timestamp       TEXT NOT NULL,
  amount          INTEGER,
  currency        TEXT,
  failure_code    TEXT,
  failure_reason  TEXT,
  attempt         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_payment_events_customer ON payment_events(customer_id);

CREATE TABLE IF NOT EXISTS behavioural_events (
  id              TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  subscription_id TEXT,
  type            TEXT NOT NULL,
  timestamp       TEXT NOT NULL,
  metadata        TEXT
);
CREATE INDEX IF NOT EXISTS idx_behavioural_events_customer ON behavioural_events(customer_id);

CREATE TABLE IF NOT EXISTS decisions (
  id                   TEXT PRIMARY KEY,
  customer_id          TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  subscription_id      TEXT,
  outcome              TEXT NOT NULL,
  confidence           REAL NOT NULL,
  recommended_action   TEXT,
  expected_outcome     TEXT,
  blacklist_recommended INTEGER NOT NULL DEFAULT 0,
  next_access_state    TEXT NOT NULL,
  risk_score           REAL,
  risk_band            TEXT,
  evidence             TEXT NOT NULL,
  created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_customer ON decisions(customer_id);
CREATE INDEX IF NOT EXISTS idx_decisions_created ON decisions(created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  customer_id TEXT,
  action      TEXT NOT NULL,
  detail      TEXT,
  metadata    TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_customer ON audit_log(customer_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS access_state_history (
  id              TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  subscription_id TEXT,
  from_state      TEXT,
  to_state        TEXT NOT NULL,
  reason          TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_access_history_customer ON access_state_history(customer_id);

-- Idempotency ledger for inbound Razorpay webhooks (keyed by x-razorpay-event-id).
CREATE TABLE IF NOT EXISTS processed_webhooks (
  event_id    TEXT PRIMARY KEY,
  event_type  TEXT,
  received_at TEXT NOT NULL
);
`;
