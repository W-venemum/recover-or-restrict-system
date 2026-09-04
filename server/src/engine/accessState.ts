/**
 * Adaptive access state machine.
 *
 * Pure transition function over
 *   ACTIVE -> RECOVERY -> GRACE -> RESTRICTED -> SUSPENDED -> BLACKLIST_RECOMMENDED
 *
 * A successful payment restores access where appropriate. Blacklist is only a
 * recommendation flag surfaced alongside SUSPENDED; it is never an automatic
 * terminal transition. No I/O.
 */

import type { AccessState, Decision } from "../domain/types.js";

export interface TransitionResult {
  nextState: AccessState;
  /** True when the engine recommends blacklisting for human review. */
  blacklistRecommended: boolean;
  /** Human-readable explanation of the transition. */
  reason: string;
}

/**
 * Compute the next access state.
 *
 * @param current         the current access state
 * @param decision        the engine's decision for this evaluation
 * @param paymentSucceeded whether a payment just succeeded (recovery signal)
 */
export function transition(
  current: AccessState,
  decision: Decision,
  paymentSucceeded: boolean,
): TransitionResult {
  // A successful payment is the primary recovery signal: it restores access
  // from any recoverable/restricted state back to ACTIVE. It does NOT override
  // a SUSPEND decision driven by high-confidence abuse.
  if (paymentSucceeded && decision.outcome !== "SUSPEND") {
    return {
      nextState: "ACTIVE",
      blacklistRecommended: false,
      reason: `Payment succeeded from ${current}; access restored to ACTIVE.`,
    };
  }

  switch (decision.outcome) {
    case "RECOVER":
      // Move into (or stay in) a soft RECOVERY posture while we attempt the
      // recommended action; never punitive for a genuine failure.
      return {
        nextState: current === "ACTIVE" ? "RECOVERY" : escalateSoftly(current),
        blacklistRecommended: false,
        reason: `RECOVER: attempting recovery from ${current}; access kept as open as possible.`,
      };

    case "INTERVENE":
      // Offer a limited grace window for assisted recovery.
      return {
        nextState: intervenTarget(current),
        blacklistRecommended: false,
        reason: `INTERVENE: entering a limited grace/recovery window from ${current}.`,
      };

    case "RESTRICT":
      return {
        nextState: "RESTRICTED",
        blacklistRecommended: false,
        reason: `RESTRICT: restricting access from ${current} due to avoidance/leakage signals.`,
      };

    case "SUSPEND":
      return {
        nextState: "SUSPENDED",
        // Surface the recommendation flag carried by the decision, but the state
        // itself only advances to SUSPENDED. BLACKLIST_RECOMMENDED is a flag,
        // never an automatic state.
        blacklistRecommended: decision.blacklistRecommended,
        reason: decision.blacklistRecommended
          ? `SUSPEND: suspending access from ${current}; blacklist RECOMMENDED for human review (not auto-applied).`
          : `SUSPEND: suspending access from ${current}.`,
      };

    default: {
      // Exhaustiveness guard.
      const _never: never = decision.outcome;
      return {
        nextState: current,
        blacklistRecommended: false,
        reason: `No transition for outcome ${String(_never)}.`,
      };
    }
  }
}

/** For RECOVER on an already-degraded state, keep it steady rather than worsen. */
function escalateSoftly(current: AccessState): AccessState {
  switch (current) {
    case "GRACE":
    case "RECOVERY":
      return current;
    case "RESTRICTED":
      // A recover decision on a restricted account eases back to GRACE.
      return "GRACE";
    default:
      return "RECOVERY";
  }
}

/** Target state for an INTERVENE decision. */
function intervenTarget(current: AccessState): AccessState {
  switch (current) {
    case "ACTIVE":
    case "RECOVERY":
      return "GRACE";
    case "GRACE":
      // Grace already exhausted with continued concern -> restrict.
      return "RESTRICTED";
    case "RESTRICTED":
    case "SUSPENDED":
      return current;
    case "BLACKLIST_RECOMMENDED":
      return "RESTRICTED";
    default:
      return "GRACE";
  }
}
