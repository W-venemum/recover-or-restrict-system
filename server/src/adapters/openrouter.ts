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

export interface LlmAdapter {
  /** Which implementation is active — useful for diagnostics / UI badges. */
  readonly kind: "openrouter" | "deterministic";
  /** Produce a human-readable explanation of a decision from its evidence. */
  explainDecision(decision: Decision, evidence?: Evidence[]): Promise<string>;
  /** Draft a customer-facing recovery message appropriate to the decision. */
  draftRecoveryMessage(customer: Customer, decision: Decision): Promise<string>;
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

  async explainDecision(
    decision: Decision,
    evidence: Evidence[] = decision.evidence,
  ): Promise<string> {
    return this.explainDecisionSync(decision, evidence);
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
  ): Promise<string> {
    return this.draftRecoveryMessageSync(customer, decision);
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
  choices?: { message?: { content?: string } }[];
}

/**
 * OpenRouter-backed explainer. POSTs to `${baseUrl}/chat/completions` with the
 * configured model. On ANY error (network, non-2xx, empty content) it falls
 * back to the deterministic explainer so callers always get non-empty text.
 */
export class OpenRouterAdapter implements LlmAdapter {
  readonly kind = "openrouter" as const;
  private readonly fallback = new DeterministicExplainer();
  private readonly config: OpenRouterConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenRouterConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async explainDecision(
    decision: Decision,
    evidence: Evidence[] = decision.evidence,
  ): Promise<string> {
    const prompt = [
      "You are a support analyst. In 2-4 short sentences, explain this subscription decision to an operator.",
      "Base your explanation ONLY on the evidence provided; do not invent facts.",
      `Decision: ${decision.outcome} (confidence ${decision.confidence}).`,
      "Evidence:",
      ...evidence.map((e) => `- ${e.message}`),
    ].join("\n");
    const text = await this.complete(prompt);
    return text ?? this.fallback.explainDecisionSync(decision, evidence);
  }

  async draftRecoveryMessage(
    customer: Customer,
    decision: Decision,
  ): Promise<string> {
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
    const text = await this.complete(prompt);
    return text ?? this.fallback.draftRecoveryMessageSync(customer, decision);
  }

  /**
   * Call the OpenRouter chat completions endpoint. Returns the message content,
   * or `undefined` on any failure (caller falls back deterministically).
   */
  private async complete(prompt: string): Promise<string | undefined> {
    if (!this.config.apiKey) return undefined;
    try {
      const res = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
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
      if (!res.ok) return undefined;
      const data = (await res.json()) as ChatCompletionResponse;
      const content = data.choices?.[0]?.message?.content?.trim();
      return content && content.length > 0 ? content : undefined;
    } catch {
      // Network / parse error — degrade silently to the deterministic fallback.
      return undefined;
    }
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
