/**
 * Payment adapter (Razorpay).
 *
 * IMPORTANT — no invented / unsupported Razorpay APIs are used here. This
 * adapter only relies on documented Razorpay behaviour:
 *
 *  - Webhook signature verification: Razorpay signs the webhook by computing an
 *    HMAC-SHA256 of the RAW request body using your configured webhook secret
 *    as the key, and sends the hex digest in the `X-Razorpay-Signature` header.
 *    We recompute the same HMAC and compare it timing-safely. (Ref: Razorpay
 *    "Validate Webhooks" docs.)
 *  - Idempotency: Razorpay sends a unique `x-razorpay-event-id` header per
 *    webhook delivery; we expose it so callers can de-duplicate retries.
 *  - Event names: we map ONLY real Razorpay event names (see RAZORPAY_EVENTS).
 *
 * `createPaymentLink` and `retryCharge` here are DEMO helpers: in simulation
 * mode they synthesise plausible responses/events so the app is fully
 * demonstrable without a live Razorpay account. They do not call any real
 * Razorpay endpoint and make no claims of doing so. Wiring them to the real
 * Razorpay REST API (Payment Links / Subscriptions) is left as an integration
 * point and intentionally not faked.
 *
 * This module is decoupled from the decision engine: it only produces
 * normalised events; the engine consumes domain events elsewhere.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { RazorpayConfig } from "../config.js";

/**
 * The set of REAL Razorpay webhook event names this system understands. No
 * fictional events are included.
 */
export const RAZORPAY_EVENTS = [
  "payment.captured",
  "payment.failed",
  "payment.authorized",
  "subscription.charged",
  "subscription.pending",
  "subscription.halted",
  "subscription.cancelled",
  "subscription.activated",
  "subscription.completed",
] as const;

export type RazorpayEventName = (typeof RAZORPAY_EVENTS)[number];

export function isKnownRazorpayEvent(name: string): name is RazorpayEventName {
  return (RAZORPAY_EVENTS as readonly string[]).includes(name);
}

/** A normalised, adapter-level view of an inbound Razorpay webhook. */
export interface NormalisedPaymentEvent {
  /** Idempotency key from the `x-razorpay-event-id` header, when available. */
  eventId?: string;
  /** The real Razorpay event name (e.g. "payment.failed"). */
  event: RazorpayEventName;
  /** Whether this event represents a success, failure, or neutral lifecycle. */
  kind: "success" | "failure" | "lifecycle";
  /** Amount in the smallest currency unit, when present in the payload. */
  amount?: number;
  currency?: string;
  /** Gateway error code, present on failures. */
  errorCode?: string;
  /** Gateway error description, present on failures. */
  errorDescription?: string;
  /** The raw, parsed payload for downstream mapping. */
  raw: unknown;
}

export interface SimulatedPaymentLink {
  id: string;
  short_url: string;
  amount: number;
  currency: string;
  status: "created";
  /** Marks this as a simulated artefact, never a real Razorpay resource. */
  simulated: true;
}

export interface SimulatedRetryResult {
  paymentId: string;
  status: "created" | "captured" | "failed";
  simulated: true;
}

export interface PaymentAdapter {
  readonly mode: "simulation" | "live";
  /**
   * Verify a webhook signature. `rawBody` MUST be the exact raw bytes/string of
   * the request body (not a re-serialised object) and `signature` is the value
   * of the `X-Razorpay-Signature` header.
   */
  verifyWebhookSignature(rawBody: string | Buffer, signature: string): boolean;
  /** Parse + normalise a webhook payload. Throws only on structurally invalid input. */
  parseEvent(payload: unknown, eventId?: string): NormalisedPaymentEvent;
  /** DEMO: create a (simulated) payment link. */
  createPaymentLink(input: {
    amount: number;
    currency: string;
    description?: string;
  }): Promise<SimulatedPaymentLink>;
  /** DEMO: retry a charge (simulated). */
  retryCharge(input: {
    subscriptionId: string;
    amount: number;
  }): Promise<SimulatedRetryResult>;
}

// ---------------------------------------------------------------------------
// Shared parsing / signature helpers
// ---------------------------------------------------------------------------

function classifyEvent(event: RazorpayEventName): NormalisedPaymentEvent["kind"] {
  switch (event) {
    case "payment.captured":
    case "subscription.charged":
    case "subscription.activated":
    case "subscription.completed":
      return "success";
    case "payment.failed":
    case "subscription.halted":
      return "failure";
    case "payment.authorized":
    case "subscription.pending":
    case "subscription.cancelled":
      return "lifecycle";
    default: {
      const _never: never = event;
      return _never;
    }
  }
}

/**
 * Compute the HMAC-SHA256 hex digest of `rawBody` keyed by `secret`, matching
 * Razorpay's documented webhook signing.
 */
export function computeWebhookSignature(
  rawBody: string | Buffer,
  secret: string,
): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual throws if lengths differ, so guard first (length is not secret).
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

interface RawRazorpayPayload {
  event?: unknown;
  payload?: {
    payment?: { entity?: Record<string, unknown> };
    subscription?: { entity?: Record<string, unknown> };
  };
}

function parseNormalised(
  payload: unknown,
  eventId?: string,
): NormalisedPaymentEvent {
  const p = payload as RawRazorpayPayload;
  const eventName = typeof p.event === "string" ? p.event : "";
  if (!isKnownRazorpayEvent(eventName)) {
    throw new Error(
      `Unknown or unsupported Razorpay event: ${JSON.stringify(p.event)}`,
    );
  }
  const paymentEntity = p.payload?.payment?.entity ?? {};
  const amount =
    typeof paymentEntity.amount === "number" ? paymentEntity.amount : undefined;
  const currency =
    typeof paymentEntity.currency === "string"
      ? paymentEntity.currency
      : undefined;
  const errorCode =
    typeof paymentEntity.error_code === "string"
      ? paymentEntity.error_code
      : undefined;
  const errorDescription =
    typeof paymentEntity.error_description === "string"
      ? paymentEntity.error_description
      : undefined;

  return {
    ...(eventId ? { eventId } : {}),
    event: eventName,
    kind: classifyEvent(eventName),
    ...(amount !== undefined ? { amount } : {}),
    ...(currency !== undefined ? { currency } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(errorDescription !== undefined ? { errorDescription } : {}),
    raw: payload,
  };
}

// ---------------------------------------------------------------------------
// Live adapter
// ---------------------------------------------------------------------------

export class RazorpayAdapter implements PaymentAdapter {
  readonly mode = "live" as const;
  private readonly config: RazorpayConfig;

  constructor(config: RazorpayConfig) {
    this.config = config;
  }

  verifyWebhookSignature(rawBody: string | Buffer, signature: string): boolean {
    const secret = this.config.webhookSecret;
    // Without a configured secret we cannot verify; fail closed.
    if (!secret || !signature) return false;
    const expected = computeWebhookSignature(rawBody, secret);
    return timingSafeEqualHex(expected, signature);
  }

  parseEvent(payload: unknown, eventId?: string): NormalisedPaymentEvent {
    return parseNormalised(payload, eventId);
  }

  // DEMO helpers: not wired to real Razorpay endpoints (see file header).
  async createPaymentLink(input: {
    amount: number;
    currency: string;
    description?: string;
  }): Promise<SimulatedPaymentLink> {
    return simulatePaymentLink(input);
  }

  async retryCharge(input: {
    subscriptionId: string;
    amount: number;
  }): Promise<SimulatedRetryResult> {
    return simulateRetry(input);
  }
}

// ---------------------------------------------------------------------------
// Simulation adapter (default for the demo)
// ---------------------------------------------------------------------------

/**
 * Simulation adapter used by default so the app is fully demonstrable without a
 * live Razorpay account. Signature verification still uses the same real
 * HMAC-SHA256 scheme when a webhook secret is configured, so demo webhooks can
 * be signed locally and verified identically to production.
 */
export class SimulationRazorpayAdapter implements PaymentAdapter {
  readonly mode = "simulation" as const;
  private readonly config: RazorpayConfig;

  constructor(config: RazorpayConfig) {
    this.config = config;
  }

  verifyWebhookSignature(rawBody: string | Buffer, signature: string): boolean {
    const secret = this.config.webhookSecret;
    if (!secret || !signature) return false;
    const expected = computeWebhookSignature(rawBody, secret);
    return timingSafeEqualHex(expected, signature);
  }

  parseEvent(payload: unknown, eventId?: string): NormalisedPaymentEvent {
    return parseNormalised(payload, eventId);
  }

  async createPaymentLink(input: {
    amount: number;
    currency: string;
    description?: string;
  }): Promise<SimulatedPaymentLink> {
    return simulatePaymentLink(input);
  }

  async retryCharge(input: {
    subscriptionId: string;
    amount: number;
  }): Promise<SimulatedRetryResult> {
    return simulateRetry(input);
  }

  /**
   * Generate a plausible, correctly-shaped Razorpay webhook payload (using a
   * real event name) for the demo. Optionally sign it with the configured
   * webhook secret so the full verify -> parse path can be exercised.
   */
  generateEvent(
    event: RazorpayEventName,
    opts: { amount?: number; currency?: string; errorCode?: string } = {},
  ): { eventId: string; body: string; signature?: string } {
    const eventId = `evt_sim_${randomUUID()}`;
    const paymentEntity: Record<string, unknown> = {
      id: `pay_sim_${randomUUID().slice(0, 12)}`,
      amount: opts.amount ?? 49900,
      currency: opts.currency ?? "INR",
    };
    if (classifyEvent(event) === "failure") {
      paymentEntity.error_code = opts.errorCode ?? "BAD_REQUEST_ERROR";
      paymentEntity.error_description = "Simulated failure for demo purposes.";
    }
    const payload = {
      entity: "event",
      event,
      contains: ["payment"],
      payload: { payment: { entity: paymentEntity } },
      created_at: Math.floor(Date.now() / 1000),
    };
    const body = JSON.stringify(payload);
    const secret = this.config.webhookSecret;
    return {
      eventId,
      body,
      ...(secret ? { signature: computeWebhookSignature(body, secret) } : {}),
    };
  }
}

function simulatePaymentLink(input: {
  amount: number;
  currency: string;
  description?: string;
}): SimulatedPaymentLink {
  const id = `plink_sim_${randomUUID().slice(0, 12)}`;
  return {
    id,
    short_url: `https://rzp.io/i/sim/${id}`,
    amount: input.amount,
    currency: input.currency,
    status: "created",
    simulated: true,
  };
}

function simulateRetry(input: {
  subscriptionId: string;
  amount: number;
}): SimulatedRetryResult {
  // A retry is only meaningful for a non-zero amount; treat a zero/negative
  // amount as an immediate failure in the simulation.
  const status = input.amount > 0 ? "created" : "failed";
  return {
    paymentId: `pay_sim_${randomUUID().slice(0, 12)}`,
    status,
    simulated: true,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Choose the adapter based on config. Defaults to the simulation adapter unless
 * mode is explicitly 'live'. Never throws for missing credentials.
 */
export function createPaymentAdapter(config: RazorpayConfig): PaymentAdapter {
  return config.mode === "live"
    ? new RazorpayAdapter(config)
    : new SimulationRazorpayAdapter(config);
}
