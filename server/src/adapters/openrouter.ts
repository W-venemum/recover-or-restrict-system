/**
 * LLM adapter (OpenRouter) with a deterministic fallback.
 *
 * The core financial / risk / decision logic NEVER depends on an LLM. This
 * adapter only produces optional human-readable summary text. When no
 * OPENROUTER_API_KEY is configured — or when any network / API error occurs —
 * we transparently fall back to the {@link DeterministicExplainer}, which
 * builds explanation + recovery-message text purely from the decision evidence.
 *
 * Adapter selection is automatic based on config (see createLlmAdapter).
 */

import type { OpenRouterConfig } from "../config.js";
import type {
  Customer,
  Decision,
  Evidence,
  RecoveryAction,
} from "../domain/types.js";

/**
 * Structured per-call LLM result. Carries the generated text plus the TRUE
 * provenance of that text so the API / UI can honestly report whether the
 * copy came from OpenRouter or from the deterministic fallback.
 *
 * - `source`  — what ACTUALLY produced `text` on this call ("openrouter" only
 *   when a live LLM completion succeeded; "deterministic" otherwise).
 * - `model`   — the model actually used. For a successful OpenRouter call this
 *   is the model reported by the API response (which may differ from a routing
 *   alias such as "openrouter/free"); on fallback it is the configured model
 *   string, or "deterministic" for the pure deterministic adapter.
 * - `fallbackReason` — present ONLY when an intended OpenRouter call degraded
 *   to deterministic text. A non-secret, human-readable reason (e.g. "HTTP 401",
 *   "network error: <safe message>", "empty completion"). Never contains the
 *   API key, headers, request/response bodies, prompt text, or PII.
 */
export interface LlmResult {
  text: string;
  source: "openrouter" | "deterministic";
  model: string;
  fallbackReason?: string;
}

export interface LlmAdapter {
  /** Which implementation is active — useful for diagnostics / UI badges. */
  readonly kind: "openrouter" | "deterministic";
  /**
   * The model this adapter is configured to use. "deterministic" for the pure
   * fallback adapter; the configured OpenRouter model id otherwise. Lets the
   * health endpoint / dashboard report the actual runtime configuration.
   */
  readonly model: string;
  /** Produce a human-readable explanation of a decision from its evidence. */
  explainDecision(
    decision: Decision,
    evidence?: Evidence[],
  ): Promise<LlmResult>;
  /** Draft a customer-facing recovery message appropriate to the decision. */
  draftRecoveryMessage(
    customer: Customer,
    decision: Decision,
  ): Promise<LlmResult>;
}

// ---------------------------------------------------------------------------
// Deterministic fallback
// ---------------------------------------------------------------------------

const ACTION_PHRASES: Record<RecoveryAction, string> = {
  retry: "we will automatically retry the charge",
  delayed_retry: "we will retry the charge shortly",
  payment_reminder: "we will send a friendly payment reminder",
  alternate_payment_method: "please try an alternate payment method",
  upi_payment_link: "you can complete payment via the UPI link we will send",
  update_payment_method: "please update your saved payment method",
  limited_grace_period: "we have extended a short grace period",
};

/**
 * Builds explanation + recovery-message text purely from decision evidence.
 * Pure and dependency-free, so it is always available with no credentials.
 */
export class DeterministicExplainer implements LlmAdapter {
  readonly kind = "deterministic" as const;
  readonly model = "deterministic" as const;

  async explainDecision(
    decision: Decision,
    evidence: Evidence[] = decision.evidence,
  ): Promise<LlmResult> {
    return {
      text: this.explainDecisionSync(decision, evidence),
      source: "deterministic",
      model: this.model,
    };
  }

  explainDecisionSync(
    decision: Decision,
    evidence: Evidence[] = decision.evidence,
  ): string {
    const headline = OUTCOME_HEADLINES[decision.outcome];
    const confidencePct = Math.round(decision.confidence * 100);
    const reasons = evidence
      .filter((e) => e.message)
      .map((e) => `- ${e.message}`)
      .join("\n");
    const parts = [
      `${headline} (confidence ${confidencePct}%).`,
      reasons ? `Why:\n${reasons}` : "",
    ];
    if (decision.recommendedAction) {
      parts.push(
        `Recommended next step: ${ACTION_PHRASES[decision.recommendedAction]}.`,
      );
    }
    if (decision.expectedRecoveryOutcome) {
      parts.push(`Expected outcome: ${decision.expectedRecoveryOutcome}`);
    }
    if (decision.blacklistRecommended) {
      parts.push(
        "Note: blacklist is RECOMMENDED for human review only and is never applied automatically.",
      );
    }
    return parts.filter(Boolean).join("\n\n");
  }

  async draftRecoveryMessage(
    customer: Customer,
    decision: Decision,
  ): Promise<LlmResult> {
    return {
      text: this.draftRecoveryMessageSync(customer, decision),
      source: "deterministic",
      model: this.model,
    };
  }

  draftRecoveryMessageSync(customer: Customer, decision: Decision): string {
    const name = customer.name || "there";
    const action = decision.recommendedAction
      ? ACTION_PHRASES[decision.recommendedAction]
      : "we're here to help you get back on track";
    switch (decision.outcome) {
      case "RECOVER":
        return `Hi ${name}, we noticed a hiccup with your recent payment. No worries — ${action}. Your access stays on while we sort this out.`;
      case "INTERVENE":
        return `Hi ${name}, your recent payment needs a quick action. To keep your subscription active, ${action}. We've kept a short grace window open for you.`;
      case "RESTRICT":
        return `Hi ${name}, we've had trouble collecting payment for your subscription, so some access is temporarily limited. To restore full access, ${action}.`;
      case "SUSPEND":
        return `Hi ${name}, your subscription has been suspended after repeated unresolved payment issues. Please contact support to review your account and restore access.`;
      default:
        return `Hi ${name}, please review your subscription payment so we can keep your access active.`;
    }
  }
}

const OUTCOME_HEADLINES: Record<Decision["outcome"], string> = {
  RECOVER: "Recovering a genuine payment failure without penalising the customer",
  INTERVENE: "Intervening with an assisted recovery step before any restriction",
  RESTRICT: "Restricting access due to avoidance / value-leakage signals",
  SUSPEND: "Suspending access after high-confidence repeated abuse",
};

// ---------------------------------------------------------------------------
// OpenRouter-backed adapter
// ---------------------------------------------------------------------------

interface ChatCompletionResponse {
  model?: string;
  choices?: { message?: { content?: string } }[];
}

/**
 * Internal outcome of a single OpenRouter completion attempt. Either a success
 * carrying the content and the model the API actually used, or a failure with a
 * non-secret reason suitable for logging and for the `fallbackReason` field.
 */
type CompletionOutcome =
  | { ok: true; content: string; model: string }
  | { ok: false; reason: string };

/**
 * OpenRouter-backed explainer. POSTs to `${baseUrl}/chat/completions` with the
 * configured model. On ANY error (network, non-2xx, empty content) it falls
 * back to the deterministic explainer so callers always get non-empty text.
 */
export class OpenRouterAdapter implements LlmAdapter {
  readonly kind = "openrouter" as const;
  readonly model: string;
  private readonly fallback = new DeterministicExplainer();
  private readonly config: OpenRouterConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenRouterConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.model = config.model;
    this.fetchImpl = fetchImpl;
  }

  async explainDecision(
    decision: Decision,
    evidence: Evidence[] = decision.evidence,
  ): Promise<LlmResult> {
    const prompt = [
      "You are a support analyst. In 2-4 short sentences, explain this subscription decision to an operator.",
      "Base your explanation ONLY on the evidence provided; do not invent facts.",
      `Decision: ${decision.outcome} (confidence ${decision.confidence}).`,
      "Evidence:",
      ...evidence.map((e) => `- ${e.message}`),
    ].join("\n");
    const outcome = await this.complete(prompt);
    if (outcome.ok) {
      return { text: outcome.content, source: "openrouter", model: outcome.model };
    }
    return {
      text: this.fallback.explainDecisionSync(decision, evidence),
      source: "deterministic",
      model: this.config.model,
      fallbackReason: outcome.reason,
    };
  }

  async draftRecoveryMessage(
    customer: Customer,
    decision: Decision,
  ): Promise<LlmResult> {
    const prompt = [
      "Write a short, friendly customer-facing message for the situation below.",
      "Be empathetic and never accusatory. 2-3 sentences.",
      `Customer name: ${customer.name}`,
      `Decision: ${decision.outcome}.`,
      decision.recommendedAction
        ? `Recommended action: ${decision.recommendedAction}.`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    const outcome = await this.complete(prompt);
    if (outcome.ok) {
      return { text: outcome.content, source: "openrouter", model: outcome.model };
    }
    return {
      text: this.fallback.draftRecoveryMessageSync(customer, decision),
      source: "deterministic",
      model: this.config.model,
      fallbackReason: outcome.reason,
    };
  }

  /**
   * Call the OpenRouter chat completions endpoint. Returns a structured outcome
   * describing success (content + the model the API actually used) or failure
   * (with a NON-SECRET reason). On any failure the caller degrades to the
   * deterministic fallback while honestly reporting source "deterministic".
   *
   * Security: this method NEVER logs or returns the API key, request/response
   * headers, request/response bodies, or the prompt (which may reference
   * customer data). Only the HTTP status or a safe error message is surfaced.
   */
  private async complete(prompt: string): Promise<CompletionOutcome> {
    if (!this.config.apiKey) {
      return { ok: false, reason: "no API key configured" };
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.3,
        }),
      });
    } catch (err) {
      // Network / DNS / abort error. Use only the safe error message — never
      // the prompt, key, or any request detail.
      const safeMessage = err instanceof Error ? err.message : "unknown error";
      const reason = `network error: ${safeMessage}`;
      this.warnFailure(reason);
      return { ok: false, reason };
    }

    if (!res.ok) {
      // Report only the HTTP status. Do NOT read/log the response body (may
      // echo request content) or headers.
      const reason = `HTTP ${res.status}`;
      this.warnFailure(reason);
      return { ok: false, reason };
    }

    let data: ChatCompletionResponse;
    try {
      data = (await res.json()) as ChatCompletionResponse;
    } catch {
      const reason = "invalid response JSON";
      this.warnFailure(reason);
      return { ok: false, reason };
    }

    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content || content.length === 0) {
      const reason = "empty completion";
      this.warnFailure(reason);
      return { ok: false, reason };
    }
    // Prefer the model the API actually used (routing aliases like
    // "openrouter/free" may resolve to a concrete model), else the configured one.
    const model =
      typeof data.model === "string" && data.model.length > 0
        ? data.model
        : this.config.model;
    return { ok: true, content, model };
  }

  /** Log a non-secret diagnostic for an OpenRouter failure. */
  private warnFailure(reason: string): void {
    // eslint-disable-next-line no-console
    console.warn(
      `OpenRouter call failed (source=deterministic fallback): ${reason}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Select the LLM adapter based on config. Returns the deterministic explainer
 * whenever no API key is present, so the app always runs with zero credentials.
 */
export function createLlmAdapter(config: OpenRouterConfig): LlmAdapter {
  return config.enabled && config.apiKey
    ? new OpenRouterAdapter(config)
    : new DeterministicExplainer();
}
