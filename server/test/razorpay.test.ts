/**
 * Behavioural tests for the Razorpay payment adapter.
 *
 * Verifies real HMAC-SHA256 webhook signing/verification (matching Razorpay's
 * documented scheme), rejection of tampered bodies/signatures, and that only
 * REAL Razorpay event names are accepted.
 */

import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  RAZORPAY_EVENTS,
  computeWebhookSignature,
  createPaymentAdapter,
  isKnownRazorpayEvent,
  SimulationRazorpayAdapter,
  RazorpayAdapter,
} from "../src/adapters/razorpay.js";
import type { RazorpayConfig } from "../src/config.js";

const SECRET = "whsec_test_secret_123";

function adapter(overrides: Partial<RazorpayConfig> = {}) {
  return createPaymentAdapter({
    webhookSecret: SECRET,
    mode: "simulation",
    ...overrides,
  });
}

describe("verifyWebhookSignature — HMAC-SHA256 over the raw body", () => {
  it("accepts a signature computed as HMAC-SHA256(rawBody, secret)", () => {
    const a = adapter();
    const body = JSON.stringify({ event: "payment.captured", payload: {} });
    // Compute the signature the exact way Razorpay documents.
    const signature = createHmac("sha256", SECRET).update(body).digest("hex");
    expect(a.verifyWebhookSignature(body, signature)).toBe(true);
  });

  it("the helper matches an independent HMAC computation", () => {
    const body = "raw-body-bytes";
    const expected = createHmac("sha256", SECRET).update(body).digest("hex");
    expect(computeWebhookSignature(body, SECRET)).toBe(expected);
  });

  it("rejects a tampered body", () => {
    const a = adapter();
    const body = JSON.stringify({ event: "payment.captured", payload: {} });
    const signature = computeWebhookSignature(body, SECRET);
    const tamperedBody = JSON.stringify({ event: "payment.failed", payload: {} });
    expect(a.verifyWebhookSignature(tamperedBody, signature)).toBe(false);
  });

  it("rejects a tampered / wrong signature", () => {
    const a = adapter();
    const body = JSON.stringify({ event: "payment.captured", payload: {} });
    expect(a.verifyWebhookSignature(body, "deadbeef")).toBe(false);
    // A signature made with a different secret must also fail.
    const wrong = computeWebhookSignature(body, "other-secret");
    expect(a.verifyWebhookSignature(body, wrong)).toBe(false);
  });

  it("fails closed with no signature or no secret", () => {
    const a = adapter();
    const body = "{}";
    expect(a.verifyWebhookSignature(body, "")).toBe(false);

    const noSecret = adapter({ webhookSecret: undefined });
    const sig = computeWebhookSignature(body, SECRET);
    expect(noSecret.verifyWebhookSignature(body, sig)).toBe(false);
  });

  it("verifies a raw Buffer body identically to the string form", () => {
    const a = adapter();
    const body = JSON.stringify({ event: "subscription.charged", payload: {} });
    const sig = computeWebhookSignature(body, SECRET);
    expect(a.verifyWebhookSignature(Buffer.from(body, "utf8"), sig)).toBe(true);
  });
});

describe("parseEvent — only real Razorpay event names", () => {
  const a = adapter() as SimulationRazorpayAdapter;

  it("accepts and normalises every real event name", () => {
    for (const event of RAZORPAY_EVENTS) {
      const payload = { event, payload: { payment: { entity: {} } } };
      const normalised = a.parseEvent(payload, `evt_${event}`);
      expect(normalised.event).toBe(event);
      expect(["success", "failure", "lifecycle"]).toContain(normalised.kind);
    }
  });

  it("throws on an invented / unknown event name", () => {
    expect(() =>
      a.parseEvent({ event: "payment.definitely_not_real", payload: {} }),
    ).toThrow();
    expect(() => a.parseEvent({ event: "subscription.exploded", payload: {} })).toThrow();
  });

  it("isKnownRazorpayEvent only accepts documented names", () => {
    expect(isKnownRazorpayEvent("payment.failed")).toBe(true);
    expect(isKnownRazorpayEvent("subscription.charged")).toBe(true);
    expect(isKnownRazorpayEvent("payment.fake")).toBe(false);
    expect(isKnownRazorpayEvent("")).toBe(false);
  });

  it("classifies failure events and extracts error details", () => {
    const payload = {
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            amount: 49900,
            currency: "INR",
            error_code: "BAD_REQUEST_ERROR",
            error_description: "Card declined",
          },
        },
      },
    };
    const normalised = a.parseEvent(payload, "evt_1");
    expect(normalised.kind).toBe("failure");
    expect(normalised.amount).toBe(49900);
    expect(normalised.errorCode).toBe("BAD_REQUEST_ERROR");
  });
});

describe("adapter factory & simulated signing round-trip", () => {
  it("defaults to the simulation adapter and uses real HMAC when signing demo events", () => {
    const a = adapter();
    expect(a).toBeInstanceOf(SimulationRazorpayAdapter);
    const sim = a as SimulationRazorpayAdapter;
    const generated = sim.generateEvent("payment.failed", { errorCode: "GATEWAY_ERROR" });
    expect(generated.signature).toBeDefined();
    // The signed demo event must verify against the same adapter.
    expect(a.verifyWebhookSignature(generated.body, generated.signature!)).toBe(true);
  });

  it("selects the live adapter when mode is 'live'", () => {
    const live = createPaymentAdapter({ webhookSecret: SECRET, mode: "live" });
    expect(live).toBeInstanceOf(RazorpayAdapter);
    expect(live.mode).toBe("live");
  });
});
