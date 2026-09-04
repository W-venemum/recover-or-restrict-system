/**
 * Behavioural tests for the access-state transition machine.
 *
 * Covers the transition table for each outcome, the recovery-on-payment rule,
 * and the invariant that BLACKLIST_RECOMMENDED is only ever a recommendation
 * flag and is never entered automatically by the engine.
 */

import { describe, it, expect } from "vitest";
import { transition } from "../src/engine/accessState.js";
import type { AccessState, Decision, DecisionOutcome } from "../src/domain/types.js";

function decision(
  outcome: DecisionOutcome,
  blacklistRecommended = false,
): Decision {
  return { outcome, confidence: 0.8, evidence: [], blacklistRecommended };
}

describe("successful payment restores access", () => {
  const states: AccessState[] = ["RECOVERY", "GRACE", "RESTRICTED"];
  for (const from of states) {
    it(`restores ${from} -> ACTIVE on a successful payment (non-SUSPEND decision)`, () => {
      const t = transition(from, decision("RECOVER"), true);
      expect(t.nextState).toBe("ACTIVE");
      expect(t.blacklistRecommended).toBe(false);
    });
  }

  it("a successful payment does NOT override a SUSPEND decision", () => {
    const t = transition("GRACE", decision("SUSPEND", true), true);
    expect(t.nextState).toBe("SUSPENDED");
  });
});

describe("RECOVER transitions", () => {
  it("ACTIVE -> RECOVERY (soft posture, never punitive)", () => {
    expect(transition("ACTIVE", decision("RECOVER"), false).nextState).toBe("RECOVERY");
  });
  it("RECOVERY stays RECOVERY", () => {
    expect(transition("RECOVERY", decision("RECOVER"), false).nextState).toBe("RECOVERY");
  });
  it("RESTRICTED eases back to GRACE on RECOVER", () => {
    expect(transition("RESTRICTED", decision("RECOVER"), false).nextState).toBe("GRACE");
  });
});

describe("INTERVENE transitions", () => {
  it("ACTIVE -> GRACE", () => {
    expect(transition("ACTIVE", decision("INTERVENE"), false).nextState).toBe("GRACE");
  });
  it("GRACE -> RESTRICTED (grace exhausted with continued concern)", () => {
    expect(transition("GRACE", decision("INTERVENE"), false).nextState).toBe("RESTRICTED");
  });
});

describe("RESTRICT transitions", () => {
  const froms: AccessState[] = ["ACTIVE", "RECOVERY", "GRACE"];
  for (const from of froms) {
    it(`${from} -> RESTRICTED`, () => {
      const t = transition(from, decision("RESTRICT"), false);
      expect(t.nextState).toBe("RESTRICTED");
      expect(t.blacklistRecommended).toBe(false);
    });
  }
});

describe("SUSPEND transitions & blacklist invariant", () => {
  it("SUSPEND -> SUSPENDED (never auto BLACKLIST_RECOMMENDED)", () => {
    const t = transition("RESTRICTED", decision("SUSPEND", true), false);
    expect(t.nextState).toBe("SUSPENDED");
    expect(t.nextState).not.toBe("BLACKLIST_RECOMMENDED");
  });

  it("surfaces the blacklist recommendation flag on SUSPEND when set", () => {
    const t = transition("RESTRICTED", decision("SUSPEND", true), false);
    expect(t.blacklistRecommended).toBe(true);
    expect(t.reason).toMatch(/blacklist/i);
  });

  it("SUSPEND without a blacklist recommendation stays a plain suspension", () => {
    const t = transition("RESTRICTED", decision("SUSPEND", false), false);
    expect(t.nextState).toBe("SUSPENDED");
    expect(t.blacklistRecommended).toBe(false);
  });

  it("no non-SUSPEND outcome ever produces the BLACKLIST_RECOMMENDED state", () => {
    const outcomes: DecisionOutcome[] = ["RECOVER", "INTERVENE", "RESTRICT"];
    const froms: AccessState[] = [
      "ACTIVE",
      "RECOVERY",
      "GRACE",
      "RESTRICTED",
      "SUSPENDED",
      "BLACKLIST_RECOMMENDED",
    ];
    for (const outcome of outcomes) {
      for (const from of froms) {
        const t = transition(from, decision(outcome, true), false);
        expect(t.nextState).not.toBe("BLACKLIST_RECOMMENDED");
      }
    }
  });
});
