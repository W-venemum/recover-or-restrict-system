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
  OpenRouterAdapter,
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
      const result = await adapter.explainDecision(decision(outcome));
      expect(result.text.length).toBeGreaterThan(0);
      // Evidence messages must appear in the explanation.
      expect(result.text).toContain("low band");
      expect(result.text).toContain("82%");
      // Provenance is honestly reported as deterministic.
      expect(result.source).toBe("deterministic");
      expect(result.model).toBe("deterministic");
      expect(result.fallbackReason).toBeUndefined();
    }
  });

  it("is deterministic: the same input yields identical output", async () => {
    const d = decision("RECOVER");
    const a = await adapter.explainDecision(d);
    const b = await adapter.explainDecision(d);
    expect(a.text).toBe(b.text);
  });

  it("notes that blacklist is a recommendation only when flagged", async () => {
    const d = decision("SUSPEND");
    d.blacklistRecommended = true;
    const result = await adapter.explainDecision(d);
    expect(result.text.toLowerCase()).toContain("blacklist");
    expect(result.text.toLowerCase()).toContain("never applied automatically");
  });

  it("never throws even with empty evidence", async () => {
    const empty: Decision = {
      outcome: "RECOVER",
      confidence: 0.5,
      evidence: [],
      blacklistRecommended: false,
    };
    const result = await adapter.explainDecision(empty);
    expect(result.text).toBeTypeOf("string");
    expect(result.source).toBe("deterministic");
    expect(result.model).toBe("deterministic");
  });
});

describe("DeterministicExplainer.draftRecoveryMessage", () => {
  const adapter = new DeterministicExplainer();

  it("produces a non-empty, customer-facing message per outcome", async () => {
    const outcomes: DecisionOutcome[] = ["RECOVER", "INTERVENE", "RESTRICT", "SUSPEND"];
    for (const outcome of outcomes) {
      const result = await adapter.draftRecoveryMessage(customer, decision(outcome));
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.text).toContain(customer.name);
      expect(result.source).toBe("deterministic");
      expect(result.model).toBe("deterministic");
    }
  });

  it("is deterministic", async () => {
    const d = decision("INTERVENE");
    const a = await adapter.draftRecoveryMessage(customer, d);
    const b = await adapter.draftRecoveryMessage(customer, d);
    expect(a.text).toBe(b.text);
  });

  it("handles a missing customer name gracefully without throwing", async () => {
    const anon: Customer = { id: "c2", name: "", createdAt: new Date().toISOString() };
    const result = await adapter.draftRecoveryMessage(anon, decision("RECOVER"));
    expect(result.text.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// OpenRouterAdapter — success + failure paths via a MOCK fetch (no network).
// ---------------------------------------------------------------------------

const keyConfig: OpenRouterConfig = {
  apiKey: "sk-test-not-a-real-key",
  model: "openrouter/free",
  baseUrl: "https://openrouter.ai/api/v1",
  enabled: true,
};

/** Build a mock fetch returning a 200 chat-completion with the given content/model. */
function okFetch(content: string, model: string): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({ model, choices: [{ message: { content } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof fetch;
}

/** Build a mock fetch returning a non-2xx status. */
function statusFetch(status: number): typeof fetch {
  return (async () =>
    new Response("{}", { status })) as unknown as typeof fetch;
}

/** Build a mock fetch that throws (network error). */
function throwingFetch(message: string): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

describe("OpenRouterAdapter success path (mocked fetch)", () => {
  it("reports source 'openrouter' and the model the API actually returned", async () => {
    const returnedModel = "meta-llama/llama-3.1-8b-instruct:free";
    const adapter = new OpenRouterAdapter(
      keyConfig,
      okFetch("LLM generated explanation.", returnedModel),
    );
    const result = await adapter.explainDecision(decision("RECOVER"));
    expect(result.source).toBe("openrouter");
    expect(result.model).toBe(returnedModel);
    expect(result.text).toBe("LLM generated explanation.");
    expect(result.fallbackReason).toBeUndefined();
  });

  it("falls back to the configured model string when the response omits `model`", async () => {
    const noModelFetch: typeof fetch = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "hi" } }] }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const adapter = new OpenRouterAdapter(keyConfig, noModelFetch);
    const result = await adapter.draftRecoveryMessage(customer, decision("RECOVER"));
    expect(result.source).toBe("openrouter");
    expect(result.model).toBe(keyConfig.model);
    expect(result.text).toBe("hi");
  });

  it("exposes the configured model via the adapter's `model` getter", () => {
    const adapter = new OpenRouterAdapter(keyConfig, okFetch("x", "y"));
    expect(adapter.kind).toBe("openrouter");
    expect(adapter.model).toBe("openrouter/free");
  });
});

describe("OpenRouterAdapter failure path falls back deterministically", () => {
  const deterministic = new DeterministicExplainer();

  it("reports source 'deterministic' with a fallbackReason on a non-2xx status", async () => {
    const adapter = new OpenRouterAdapter(keyConfig, statusFetch(401));
    const d = decision("RECOVER");
    const result = await adapter.explainDecision(d);
    expect(result.source).toBe("deterministic");
    expect(result.text).toBe(deterministic.explainDecisionSync(d, d.evidence));
    expect(result.fallbackReason).toBe("HTTP 401");
    // Model reported is the configured one so the UI can still name it.
    expect(result.model).toBe(keyConfig.model);
  });

  it("reports source 'deterministic' with a network-error reason when fetch throws", async () => {
    const adapter = new OpenRouterAdapter(keyConfig, throwingFetch("ECONNREFUSED"));
    const result = await adapter.draftRecoveryMessage(customer, decision("RECOVER"));
    expect(result.source).toBe("deterministic");
    expect(result.text).toBe(
      deterministic.draftRecoveryMessageSync(customer, decision("RECOVER")),
    );
    expect(result.fallbackReason).toContain("network error");
    expect(result.fallbackReason).toContain("ECONNREFUSED");
  });

  it("treats an empty completion as a fallback", async () => {
    const adapter = new OpenRouterAdapter(keyConfig, okFetch("   ", "some/model"));
    const result = await adapter.explainDecision(decision("RECOVER"));
    expect(result.source).toBe("deterministic");
    expect(result.fallbackReason).toBe("empty completion");
  });

  it("never leaks the API key in the fallbackReason", async () => {
    const adapter = new OpenRouterAdapter(keyConfig, statusFetch(500));
    const result = await adapter.explainDecision(decision("RECOVER"));
    expect(result.fallbackReason).not.toContain(keyConfig.apiKey);
  });
});
