/**
 * Behavioural tests for the OpenRouter LLM adapter's deterministic fallback.
 *
 * With NO OPENROUTER_API_KEY, the factory must return the DeterministicExplainer,
 * whose explainDecision + draftRecoveryMessage produce deterministic, non-empty
 * text derived from the decision/evidence and never throw.
 */

import { describe, it, expect } from "vitest";
import {
  createLlmAdapter,
  DeterministicExplainer,
} from "../src/adapters/openrouter.js";
import type {
  Customer,
  Decision,
  DecisionOutcome,
} from "../src/domain/types.js";
import type { OpenRouterConfig } from "../src/config.js";

const noKeyConfig: OpenRouterConfig = {
  model: "openai/gpt-4o-mini",
  baseUrl: "https://openrouter.ai/api/v1",
  enabled: false,
};

const customer: Customer = {
  id: "c1",
  name: "Test Person",
  createdAt: new Date().toISOString(),
};

function decision(outcome: DecisionOutcome): Decision {
  return {
    outcome,
    confidence: 0.82,
    evidence: [
      { code: "risk_band", message: "Risk score 12/100 in the low band." },
      { code: "recover_rule", message: "Genuine/transient failure with low risk." },
    ],
    recommendedAction: "retry",
    expectedRecoveryOutcome: "Automatically retry the charge; usually clears.",
    blacklistRecommended: false,
  };
}

describe("createLlmAdapter with no API key", () => {
  it("returns the deterministic explainer", () => {
    const adapter = createLlmAdapter(noKeyConfig);
    expect(adapter.kind).toBe("deterministic");
    expect(adapter).toBeInstanceOf(DeterministicExplainer);
  });
});

describe("DeterministicExplainer.explainDecision", () => {
  const adapter = new DeterministicExplainer();

  it("returns non-empty text derived from the evidence for every outcome", async () => {
    const outcomes: DecisionOutcome[] = ["RECOVER", "INTERVENE", "RESTRICT", "SUSPEND"];
    for (const outcome of outcomes) {
      const text = await adapter.explainDecision(decision(outcome));
      expect(text.length).toBeGreaterThan(0);
      // Evidence messages must appear in the explanation.
      expect(text).toContain("low band");
      expect(text).toContain("82%");
    }
  });

  it("is deterministic: the same input yields identical output", async () => {
    const d = decision("RECOVER");
    const a = await adapter.explainDecision(d);
    const b = await adapter.explainDecision(d);
    expect(a).toBe(b);
  });

  it("notes that blacklist is a recommendation only when flagged", async () => {
    const d = decision("SUSPEND");
    d.blacklistRecommended = true;
    const text = await adapter.explainDecision(d);
    expect(text.toLowerCase()).toContain("blacklist");
    expect(text.toLowerCase()).toContain("never applied automatically");
  });

  it("never throws even with empty evidence", async () => {
    const empty: Decision = {
      outcome: "RECOVER",
      confidence: 0.5,
      evidence: [],
      blacklistRecommended: false,
    };
    await expect(adapter.explainDecision(empty)).resolves.toBeTypeOf("string");
  });
});

describe("DeterministicExplainer.draftRecoveryMessage", () => {
  const adapter = new DeterministicExplainer();

  it("produces a non-empty, customer-facing message per outcome", async () => {
    const outcomes: DecisionOutcome[] = ["RECOVER", "INTERVENE", "RESTRICT", "SUSPEND"];
    for (const outcome of outcomes) {
      const msg = await adapter.draftRecoveryMessage(customer, decision(outcome));
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).toContain(customer.name);
    }
  });

  it("is deterministic", async () => {
    const d = decision("INTERVENE");
    const a = await adapter.draftRecoveryMessage(customer, d);
    const b = await adapter.draftRecoveryMessage(customer, d);
    expect(a).toBe(b);
  });

  it("handles a missing customer name gracefully without throwing", async () => {
    const anon: Customer = { id: "c2", name: "", createdAt: new Date().toISOString() };
    const msg = await adapter.draftRecoveryMessage(anon, decision("RECOVER"));
    expect(msg.length).toBeGreaterThan(0);
  });
});
