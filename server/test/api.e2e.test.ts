/**
 * End-to-end API tests (supertest) against an isolated in-memory database.
 *
 * Seeds the seven demo scenarios through the REAL engine, then exercises the
 * dashboard / customers / customer-detail read paths, the Razorpay webhook path
 * (invalid signature -> 401, valid -> 200, replay -> idempotent duplicate), and
 * the merchant review flow (updates access + writes an audit_log entry).
 *
 * The DB is ":memory:" so tests never touch the demo DB at server/data.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { openDatabase, type DB } from "../src/db/migrate.js";
import { Repository } from "../src/db/repo.js";
import { createApp } from "../src/api/app.js";
import { seedDatabase } from "../src/seed/seed.js";
import {
  SimulationRazorpayAdapter,
  computeWebhookSignature,
} from "../src/adapters/razorpay.js";
import { DeterministicExplainer } from "../src/adapters/openrouter.js";
import type { RazorpayConfig } from "../src/config.js";

const WEBHOOK_SECRET = "whsec_e2e_secret";
const RZP_CONFIG: RazorpayConfig = {
  webhookSecret: WEBHOOK_SECRET,
  mode: "simulation",
};

let db: DB;
let repo: Repository;
let app: Express;
let paymentAdapter: SimulationRazorpayAdapter;

beforeAll(() => {
  // Isolated in-memory DB — never clobbers server/data.
  db = openDatabase(":memory:");
  repo = new Repository(db);
  seedDatabase(repo, db);
  paymentAdapter = new SimulationRazorpayAdapter(RZP_CONFIG);
  app = createApp({
    repo,
    paymentAdapter,
    llmAdapter: new DeterministicExplainer(),
  });
});

afterAll(() => {
  db.close();
});

/** The intended outcome per seeded scenario (mirrors scenarios.ts expectations). */
const EXPECTED: Record<
  string,
  { decision: string; accessState: string; blacklistRecommended: boolean }
> = {
  cust_normal: { decision: "RECOVER", accessState: "ACTIVE", blacklistRecommended: false },
  cust_transient: { decision: "RECOVER", accessState: "ACTIVE", blacklistRecommended: false },
  cust_insufficient: { decision: "RECOVER", accessState: "RECOVERY", blacklistRecommended: false },
  cust_autopay_cancel: { decision: "RESTRICT", accessState: "RESTRICTED", blacklistRecommended: false },
  cust_cycling: { decision: "RESTRICT", accessState: "RESTRICTED", blacklistRecommended: false },
  cust_extraction: { decision: "SUSPEND", accessState: "SUSPENDED", blacklistRecommended: true },
  cust_legit_failures: { decision: "RECOVER", accessState: "ACTIVE", blacklistRecommended: false },
};

describe("GET /api/health", () => {
  it("reports the simulation payment mode and deterministic llm", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.paymentMode).toBe("simulation");
    expect(res.body.llm).toBe("deterministic");
  });
});

describe("GET /api/customers — all 7 seeded scenarios resolve to intended outcomes", () => {
  it("returns 7 customers", async () => {
    const res = await request(app).get("/api/customers");
    expect(res.status).toBe(200);
    expect(res.body.customers).toHaveLength(7);
  });

  it("each scenario has the intended decision + access state + blacklist flag", async () => {
    const res = await request(app).get("/api/customers");
    const byId = new Map<string, any>(
      res.body.customers.map((c: any) => [c.id, c]),
    );
    for (const [id, want] of Object.entries(EXPECTED)) {
      const got = byId.get(id);
      expect(got, `missing customer ${id}`).toBeDefined();
      expect(got.decision, `decision for ${id}`).toBe(want.decision);
      expect(got.accessState, `accessState for ${id}`).toBe(want.accessState);
      expect(got.blacklistRecommended, `blacklist for ${id}`).toBe(
        want.blacklistRecommended,
      );
    }
  });

  it("scenario 6 SUSPENDs with a blacklist recommendation, scenario 7 RECOVERs without one", async () => {
    const res = await request(app).get("/api/customers");
    const byId = new Map<string, any>(
      res.body.customers.map((c: any) => [c.id, c]),
    );
    const extraction = byId.get("cust_extraction");
    const legit = byId.get("cust_legit_failures");
    expect(extraction.decision).toBe("SUSPEND");
    expect(extraction.blacklistRecommended).toBe(true);
    // Scenario 7: genuine repeated failures must be recovered, never blacklisted.
    expect(legit.decision).toBe("RECOVER");
    expect(legit.blacklistRecommended).toBe(false);
    expect(legit.accessState).toBe("ACTIVE");
  });
});

describe("GET /api/customers/:id", () => {
  it("returns detail with evidence for a seeded customer", async () => {
    const res = await request(app).get("/api/customers/cust_extraction");
    expect(res.status).toBe(200);
    expect(res.body.customer.id).toBe("cust_extraction");
    expect(res.body.decision).toBe("SUSPEND");
    expect(res.body.blacklistRecommended).toBe(true);
    expect(Array.isArray(res.body.evidence)).toBe(true);
    expect(res.body.evidence.length).toBeGreaterThan(0);
    expect(res.body.timeline.length).toBeGreaterThan(0);
  });

  it("404s for an unknown customer", async () => {
    const res = await request(app).get("/api/customers/nope");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/dashboard", () => {
  it("returns a revenue summary with a risk distribution and recovery rate", async () => {
    const res = await request(app).get("/api/dashboard");
    expect(res.status).toBe(200);
    expect(res.body.revenue).toBeDefined();
    expect(res.body.revenue.totalSubscriptionRevenue).toBeGreaterThan(0);
    expect(res.body.riskDistribution).toBeDefined();
    const dist = res.body.riskDistribution;
    expect(dist.low + dist.medium + dist.high).toBe(7);
    expect(res.body.revenue.recoveryRate).toBeGreaterThanOrEqual(0);
    expect(res.body.revenue.recoveryRate).toBeLessThanOrEqual(1);
  });
});

describe("POST /api/webhooks/razorpay — signature verification & idempotency", () => {
  function signedEvent(customerId: string) {
    const eventId = `evt_e2e_${customerId}_${Date.now()}`;
    const payload = {
      entity: "event",
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: "pay_e2e_1",
            amount: 49900,
            currency: "INR",
            notes: { customer_id: customerId },
          },
        },
      },
    };
    const body = JSON.stringify(payload);
    const signature = computeWebhookSignature(body, WEBHOOK_SECRET);
    return { eventId, body, signature };
  }

  /**
   * Send a raw body through supertest so the EXACT bytes reach `express.raw`
   * (superagent must not re-serialise them, or the HMAC would not match). We
   * set an octet-stream content type and write the raw string.
   */
  function postWebhook(body: string, signature: string, eventId?: string) {
    const req = request(app)
      .post("/api/webhooks/razorpay")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", signature);
    if (eventId) req.set("x-razorpay-event-id", eventId);
    return req.send(body);
  }

  it("rejects an invalid signature with 401", async () => {
    const { body } = signedEvent("cust_transient");
    const res = await postWebhook(body, "not-a-valid-signature");
    expect(res.status).toBe(401);
  });

  it("accepts a valid signature with 200 and processes the event", async () => {
    const { eventId, body, signature } = signedEvent("cust_transient");
    const res = await postWebhook(body, signature, eventId);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("processed");
    expect(res.body.event).toBe("payment.captured");
  });

  it("is idempotent: replaying the same event id returns a duplicate ack", async () => {
    const { eventId, body, signature } = signedEvent("cust_transient");
    const first = await postWebhook(body, signature, eventId);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("processed");

    const replay = await postWebhook(body, signature, eventId);
    expect(replay.status).toBe(200);
    expect(replay.body.status).toBe("duplicate");
    expect(replay.body.eventId).toBe(eventId);
  });
});

describe("POST /api/customers/:id/review — updates access + writes audit_log", () => {
  it("restore_access moves the subscription to ACTIVE and audits it", async () => {
    const before = await request(app).get("/api/customers/cust_autopay_cancel");
    expect(before.body.accessState).toBe("RESTRICTED");

    const res = await request(app)
      .post("/api/customers/cust_autopay_cancel/review")
      .send({ action: "restore_access", note: "Customer resolved payment." });
    expect(res.status).toBe(200);
    expect(res.body.accessState).toBe("ACTIVE");
    expect(res.body.fromState).toBe("RESTRICTED");
    expect(res.body.audit).toBeDefined();

    // Verify the access state actually changed in the DB.
    const after = await request(app).get("/api/customers/cust_autopay_cancel");
    expect(after.body.accessState).toBe("ACTIVE");

    // Verify an audit_log row was written for the review.
    const audits = repo.listAuditEntries("cust_autopay_cancel");
    expect(audits.some((a) => a.action === "review_restore_access")).toBe(true);
  });

  it("approve_blacklist only ever moves to BLACKLIST_RECOMMENDED via explicit merchant review", async () => {
    // The engine never auto-applies blacklist; it requires this merchant action.
    const res = await request(app)
      .post("/api/customers/cust_extraction/review")
      .send({ action: "approve_blacklist" });
    expect(res.status).toBe(200);
    expect(res.body.accessState).toBe("BLACKLIST_RECOMMENDED");

    const audits = repo.listAuditEntries("cust_extraction");
    expect(audits.some((a) => a.action === "review_approve_blacklist")).toBe(true);
  });

  it("reinstate_access moves to a limited GRACE window", async () => {
    const res = await request(app)
      .post("/api/customers/cust_cycling/review")
      .send({ action: "reinstate_access" });
    expect(res.status).toBe(200);
    expect(res.body.accessState).toBe("GRACE");
  });

  it("rejects an unknown review action with 400", async () => {
    const res = await request(app)
      .post("/api/customers/cust_cycling/review")
      .send({ action: "delete_everything" });
    expect(res.status).toBe(400);
  });
});
