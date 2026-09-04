/**
 * Express application factory.
 *
 * Wires the deterministic decision engine, the SQLite repository and the
 * payment / LLM adapters behind a small REST surface. The app is created via a
 * factory that takes its dependencies explicitly (no globals) so it can be
 * exercised in tests with an in-memory DB and simulation adapters.
 *
 * IMPORTANT: normal routes use JSON body parsing, but the Razorpay webhook
 * route uses `express.raw` so HMAC-SHA256 signature verification runs against
 * the EXACT raw request bytes (re-serialising JSON would change the bytes and
 * break the signature).
 */

import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { z } from "zod";
import type { PaymentAdapter } from "../adapters/razorpay.js";
import type { LlmAdapter } from "../adapters/openrouter.js";
import type { Repository } from "../db/repo.js";
import { evaluateCustomer, summariseRevenue } from "../engine/index.js";
import type {
  AccessState,
  Decision,
  PaymentEvent,
  PaymentEventType,
} from "../domain/types.js";
import type { RevenueDecisionView } from "../engine/revenue.js";

export interface AppDependencies {
  repo: Repository;
  paymentAdapter: PaymentAdapter;
  llmAdapter: LlmAdapter;
}

/** A typed async route handler whose rejections are forwarded to Express. */
type AsyncHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

/** Wrap an async handler so thrown/rejected errors reach the error middleware. */
function asyncRoute(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
}

/** An HTTP error with an associated status code. */
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Re-run the deterministic engine for a customer from their stored history and
 * persist the resulting decision, access-state transition and audit entry.
 * Returns the fresh evaluation so callers can respond with it.
 */
function reevaluateAndPersist(repo: Repository, customerId: string) {
  const bundle = repo.getCustomerWithEvents(customerId);
  if (!bundle) throw new HttpError(404, `Customer ${customerId} not found`);
  const subscription = bundle.subscriptions[0];
  if (!subscription) {
    throw new HttpError(422, `Customer ${customerId} has no subscription`);
  }

  const result = evaluateCustomer({
    customer: bundle.customer,
    subscription,
    paymentEvents: bundle.paymentEvents,
    behaviouralEvents: bundle.behaviouralEvents,
  });

  const fromState = subscription.accessState;
  const stored = repo.insertDecision({
    customerId,
    subscriptionId: subscription.id,
    decision: result.decision,
    nextAccessState: result.nextAccessState,
    riskScore: result.risk.score,
    riskBand: result.risk.band,
  });

  if (result.nextAccessState !== fromState) {
    repo.updateSubscriptionAccessState(subscription.id, result.nextAccessState);
    repo.insertAccessStateHistory({
      customerId,
      subscriptionId: subscription.id,
      fromState,
      toState: result.nextAccessState,
      reason: `Engine transition after evaluation (${result.decision.outcome}).`,
    });
  }

  repo.insertAuditEntry({
    customerId,
    action: "decision_evaluated",
    detail: `Outcome ${result.decision.outcome}; access ${fromState} -> ${result.nextAccessState}.`,
    metadata: {
      outcome: result.decision.outcome,
      riskScore: result.risk.score,
      riskBand: result.risk.band,
      blacklistRecommended: result.decision.blacklistRecommended,
    },
  });

  return { result, stored, subscription, customer: bundle.customer, bundle };
}

/** Build a RevenueDecisionView from a stored decision for the revenue engine. */
function toRevenueView(
  customerId: string,
  subscriptionId: string,
  decision: {
    outcome: RevenueDecisionView["outcome"];
    confidence: number;
    recommendedAction?: RevenueDecisionView["recommendedAction"];
    blacklistRecommended: boolean;
    riskScore?: number;
    riskBand?: RevenueDecisionView["riskBand"];
    nextAccessState?: AccessState;
  },
): RevenueDecisionView {
  return {
    customerId,
    subscriptionId,
    outcome: decision.outcome,
    confidence: decision.confidence,
    ...(decision.recommendedAction
      ? { recommendedAction: decision.recommendedAction }
      : {}),
    blacklistRecommended: decision.blacklistRecommended,
    ...(decision.riskScore !== undefined ? { riskScore: decision.riskScore } : {}),
    ...(decision.riskBand ? { riskBand: decision.riskBand } : {}),
    ...(decision.nextAccessState ? { nextAccessState: decision.nextAccessState } : {}),
  };
}

// ---------------------------------------------------------------------------
// Input validation schemas (zod)
// ---------------------------------------------------------------------------

const customerIdParams = z.object({ id: z.string().min(1) });

const reviewBody = z.object({
  action: z.enum([
    "approve_blacklist",
    "reject_blacklist",
    "reinstate_access",
    "restore_access",
  ]),
  note: z.string().max(2000).optional(),
});

/** Map a normalised webhook event kind onto a domain payment event type. */
const KIND_TO_PAYMENT_TYPE: Record<string, PaymentEventType> = {
  success: "payment_succeeded",
  failure: "payment_failed",
};

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

export function createApp(deps: AppDependencies): Express {
  const { repo, paymentAdapter, llmAdapter } = deps;
  const app = express();

  // ---- Webhook route FIRST, with a raw body parser --------------------
  // Must be registered before the global express.json() so the raw bytes are
  // preserved for HMAC verification.
  app.post(
    "/api/webhooks/razorpay",
    express.raw({ type: "*/*" }),
    asyncRoute(async (req, res) => {
      const rawBody: Buffer = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from("");
      const signature = req.header("x-razorpay-signature") ?? "";

      if (!paymentAdapter.verifyWebhookSignature(rawBody, signature)) {
        return res
          .status(401)
          .json({ error: "Invalid or missing webhook signature" });
      }

      const eventId = req.header("x-razorpay-event-id") ?? undefined;

      // Idempotency: dedupe on the event id. If we have seen it, ack 200 but do
      // not re-process.
      if (eventId && !repo.markWebhookProcessed(eventId)) {
        return res.status(200).json({ status: "duplicate", eventId });
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        throw new HttpError(400, "Webhook body is not valid JSON");
      }

      const normalised = paymentAdapter.parseEvent(payload, eventId);

      // Resolve the customer via the notes / payload if present, otherwise via
      // an explicit query param (useful for the simulation demo).
      const customerId =
        (typeof req.query.customerId === "string" && req.query.customerId) ||
        extractCustomerId(payload);

      if (!customerId) {
        // We still ack the webhook (already recorded for idempotency) but note
        // that no customer could be linked.
        repo.insertAuditEntry({
          action: "webhook_unlinked",
          detail: `Received ${normalised.event} but could not link a customer.`,
          metadata: { event: normalised.event, ...(eventId ? { eventId } : {}) },
        });
        return res.status(202).json({ status: "accepted_unlinked", event: normalised.event });
      }

      const bundle = repo.getCustomerWithEvents(customerId);
      if (!bundle || !bundle.subscriptions[0]) {
        throw new HttpError(404, `Customer ${customerId} not found for webhook`);
      }
      const subscription = bundle.subscriptions[0];

      // Ingest the event into the payment history so the engine sees it.
      const paymentType = KIND_TO_PAYMENT_TYPE[normalised.kind];
      if (paymentType) {
        const event: PaymentEvent = {
          id: eventId ?? `evt_${Date.now()}`,
          customerId,
          subscriptionId: subscription.id,
          type: paymentType,
          timestamp: new Date().toISOString(),
          ...(normalised.amount !== undefined ? { amount: normalised.amount } : {}),
          ...(normalised.currency ? { currency: normalised.currency } : {}),
          ...(normalised.errorCode ? { failureCode: normalised.errorCode } : {}),
          ...(normalised.errorDescription
            ? { failureReason: normalised.errorDescription }
            : {}),
        };
        repo.insertPaymentEvent(event);
      }

      repo.insertAuditEntry({
        customerId,
        action: "webhook_ingested",
        detail: `Ingested Razorpay ${normalised.event} (${normalised.kind}).`,
        metadata: {
          event: normalised.event,
          kind: normalised.kind,
          ...(eventId ? { eventId } : {}),
        },
      });

      const { result } = reevaluateAndPersist(repo, customerId);

      return res.status(200).json({
        status: "processed",
        event: normalised.event,
        outcome: result.decision.outcome,
        nextAccessState: result.nextAccessState,
      });
    }),
  );

  // ---- JSON parsing for all remaining routes --------------------------
  app.use(express.json());

  // ---- Health ----------------------------------------------------------
  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      paymentMode: paymentAdapter.mode,
      llm: llmAdapter.kind,
    });
  });

  // ---- Dashboard: revenue-at-risk + risk distribution + recovery -------
  app.get(
    "/api/dashboard",
    asyncRoute(async (_req, res) => {
      const rows = repo.listCustomersWithLatestDecision();
      const subscriptions = rows.flatMap((r) => r.subscriptions);
      const decisions: RevenueDecisionView[] = [];
      for (const r of rows) {
        const d = r.latestDecision;
        const sub = r.subscriptions[0];
        if (d && sub) {
          decisions.push(toRevenueView(r.customer.id, sub.id, d));
        }
      }

      const summary = summariseRevenue({ subscriptions, decisions });

      // Recent recovery events: audit entries where a genuine failure was
      // recovered (access restored to ACTIVE) plus recent decisions.
      const recentDecisions = repo
        .listDecisions()
        .slice(0, 10)
        .map((d) => ({
          customerId: d.customerId,
          outcome: d.outcome,
          nextAccessState: d.nextAccessState,
          riskScore: d.riskScore,
          riskBand: d.riskBand,
          recommendedAction: d.recommendedAction,
          blacklistRecommended: d.blacklistRecommended,
          createdAt: d.createdAt,
        }));

      const recentRecoveries = recentDecisions.filter(
        (d) => d.outcome === "RECOVER" || d.nextAccessState === "ACTIVE",
      );

      res.json({
        revenue: summary,
        riskDistribution: summary.riskDistribution,
        recentDecisions,
        recentRecoveries,
      });
    }),
  );

  // ---- Customers list --------------------------------------------------
  app.get(
    "/api/customers",
    asyncRoute(async (_req, res) => {
      const rows = repo.listCustomersWithLatestDecision();
      const customers = rows.map((r) => {
        const sub = r.subscriptions[0];
        const d = r.latestDecision;
        return {
          id: r.customer.id,
          name: r.customer.name,
          ...(r.customer.email ? { email: r.customer.email } : {}),
          plan: sub?.plan,
          amount: sub?.amount,
          currency: sub?.currency,
          accessState: sub?.accessState,
          riskScore: d?.riskScore ?? null,
          riskBand: d?.riskBand ?? null,
          decision: d?.outcome ?? null,
          recommendedAction: d?.recommendedAction ?? null,
          blacklistRecommended: d?.blacklistRecommended ?? false,
        };
      });
      res.json({ customers });
    }),
  );

  // ---- Customer detail -------------------------------------------------
  app.get(
    "/api/customers/:id",
    asyncRoute(async (req, res) => {
      const { id } = customerIdParams.parse(req.params);
      const bundle = repo.getCustomerWithEvents(id);
      if (!bundle) throw new HttpError(404, `Customer ${id} not found`);
      const subscription = bundle.subscriptions[0];
      const latest = repo.getLatestDecisionForCustomer(id);

      // Build a merged, chronological behavioural + payment timeline.
      const timeline = [
        ...bundle.paymentEvents.map((e) => ({
          kind: "payment" as const,
          type: e.type,
          timestamp: e.timestamp,
          amount: e.amount,
          failureCode: e.failureCode,
          failureReason: e.failureReason,
        })),
        ...bundle.behaviouralEvents.map((e) => ({
          kind: "behavioural" as const,
          type: e.type,
          timestamp: e.timestamp,
          metadata: e.metadata,
        })),
      ].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

      res.json({
        customer: bundle.customer,
        subscription,
        subscriptions: bundle.subscriptions,
        paymentHistory: bundle.paymentEvents,
        behaviouralTimeline: bundle.behaviouralEvents,
        timeline,
        riskScore: latest?.riskScore ?? null,
        riskBand: latest?.riskBand ?? null,
        decision: latest?.outcome ?? null,
        recommendedAction: latest?.recommendedAction ?? null,
        expectedRecoveryOutcome: latest?.expectedRecoveryOutcome ?? null,
        blacklistRecommended: latest?.blacklistRecommended ?? false,
        accessState: subscription?.accessState ?? null,
        evidence: latest?.evidence ?? [],
      });
    }),
  );

  // ---- Explain: LLM-or-fallback explanation + drafted message ----------
  app.post(
    "/api/customers/:id/explain",
    asyncRoute(async (req, res) => {
      const { id } = customerIdParams.parse(req.params);
      const bundle = repo.getCustomerWithEvents(id);
      if (!bundle) throw new HttpError(404, `Customer ${id} not found`);
      let latest = repo.getLatestDecisionForCustomer(id);
      // Ensure a decision exists to explain (evaluate on demand if missing).
      if (!latest) {
        latest = reevaluateAndPersist(repo, id).stored;
      }

      const decision: Decision = {
        outcome: latest.outcome,
        confidence: latest.confidence,
        evidence: latest.evidence,
        ...(latest.recommendedAction
          ? { recommendedAction: latest.recommendedAction }
          : {}),
        ...(latest.expectedRecoveryOutcome
          ? { expectedRecoveryOutcome: latest.expectedRecoveryOutcome }
          : {}),
        blacklistRecommended: latest.blacklistRecommended,
      };

      const [explanation, recoveryMessage] = await Promise.all([
        llmAdapter.explainDecision(decision, latest.evidence),
        llmAdapter.draftRecoveryMessage(bundle.customer, decision),
      ]);

      repo.insertAuditEntry({
        customerId: id,
        action: "explanation_generated",
        detail: `Generated explanation via ${llmAdapter.kind} adapter.`,
        metadata: { source: llmAdapter.kind, outcome: decision.outcome },
      });

      res.json({
        source: llmAdapter.kind,
        outcome: decision.outcome,
        explanation,
        recoveryMessage,
      });
    }),
  );

  // ---- Review: merchant approve / appeal controls ----------------------
  app.post(
    "/api/customers/:id/review",
    asyncRoute(async (req, res) => {
      const { id } = customerIdParams.parse(req.params);
      const body = reviewBody.parse(req.body ?? {});
      const bundle = repo.getCustomerWithEvents(id);
      if (!bundle || !bundle.subscriptions[0]) {
        throw new HttpError(404, `Customer ${id} not found`);
      }
      const subscription = bundle.subscriptions[0];
      const fromState = subscription.accessState;

      let newState: AccessState = fromState;
      let auditDetail: string;

      switch (body.action) {
        case "approve_blacklist":
          newState = "BLACKLIST_RECOMMENDED";
          auditDetail =
            "Merchant APPROVED the blacklist recommendation for human-reviewed enforcement.";
          break;
        case "reject_blacklist":
          // Rejecting the recommendation eases the account back to RESTRICTED
          // pending resolution rather than blacklisting.
          newState = "RESTRICTED";
          auditDetail =
            "Merchant REJECTED the blacklist recommendation; account kept restricted pending resolution.";
          break;
        case "reinstate_access":
          newState = "GRACE";
          auditDetail =
            "Merchant reinstated access into a limited grace window on appeal.";
          break;
        case "restore_access":
          newState = "ACTIVE";
          auditDetail = "Merchant fully restored access to ACTIVE on appeal.";
          break;
        default:
          throw new HttpError(400, "Unsupported review action");
      }

      repo.updateSubscriptionAccessState(subscription.id, newState);
      repo.insertAccessStateHistory({
        customerId: id,
        subscriptionId: subscription.id,
        fromState,
        toState: newState,
        reason: auditDetail,
      });
      const audit = repo.insertAuditEntry({
        customerId: id,
        action: `review_${body.action}`,
        detail: body.note ? `${auditDetail} Note: ${body.note}` : auditDetail,
        metadata: { action: body.action, fromState, toState: newState },
      });

      res.json({
        status: "ok",
        action: body.action,
        fromState,
        accessState: newState,
        audit,
      });
    }),
  );

  // ---- 404 for unknown API routes -------------------------------------
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // ---- Central error handler ------------------------------------------
  app.use(
    (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: "Validation failed", details: err.issues });
        return;
      }
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : "Internal server error";
      // eslint-disable-next-line no-console
      console.error("Unhandled error:", err);
      res.status(500).json({ error: message });
    },
  );

  return app;
}

/**
 * Best-effort extraction of a customer id from a Razorpay-style payload. Real
 * integrations put merchant references in `notes`; the simulation puts it in
 * `payload.payment.entity.notes.customer_id`.
 */
function extractCustomerId(payload: unknown): string | undefined {
  const p = payload as {
    payload?: {
      payment?: { entity?: { notes?: Record<string, unknown> } };
      subscription?: { entity?: { notes?: Record<string, unknown> } };
    };
  };
  const notes =
    p.payload?.payment?.entity?.notes ??
    p.payload?.subscription?.entity?.notes;
  const value = notes?.customer_id ?? notes?.customerId;
  return typeof value === "string" ? value : undefined;
}
