import { DEFAULTS, type FoldPointAction, type FoldPointReason } from "../src/index";
import type { Scenario } from "./scenarios";

/** Everything a strategy is allowed to see when it makes a decision. */
export interface DecisionRequest {
  step: number;
  timestamp: number;
  idleMs: number;
  contextTokens: number;
  cachedTokens: number;
  utilization: number;
}

export interface StrategyDecision {
  action: FoldPointAction;
  reasons?: FoldPointReason[];
  /** The strategy's own break-even estimate, when it has one. */
  estimatedBreakEvenCalls?: number | null;
}

export interface CompactionEvent {
  step: number;
  timestamp: number;
  beforeTokens: number;
  afterTokens: number;
  outputTokens: number;
  action: FoldPointAction;
  /** Ground-truth cost of the compaction attempt. */
  cost: number;
  /** Ground-truth break-even of this attempt, when it has a positive per-call saving. */
  breakEvenCalls: number | null;
  success: boolean;
}

export interface RequestEvent {
  step: number;
  timestamp: number;
  promptTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Ground-truth cost of this call. */
  cost: number;
}

/** A decision policy under test. */
export interface Strategy {
  id: string;
  label: string;
  decide(request: DecisionRequest): StrategyDecision;
  onCompaction?(event: CompactionEvent): void;
  onRequest?(event: RequestEvent): void;
  onSessionEnd?(timestamp: number): void;
}

/**
 * Builds a fresh strategy for one scenario. Strategies that learn (FoldPoint) must start
 * from a clean state per session, so the simulator never reuses an instance.
 */
export type StrategyFactory = (scenario: Scenario) => Strategy;

/** The guards a guarded baseline shares with FoldPoint. It does NOT get its cost model. */
export interface GuardSettings {
  hardWindowRatio: number;
  reserveTokens: number;
  minCallsBetweenCompactions: number;
}

export const SHARED_GUARDS: GuardSettings = Object.freeze({
  hardWindowRatio: DEFAULTS.hardWindowRatio,
  reserveTokens: DEFAULTS.reserveTokens,
  minCallsBetweenCompactions: DEFAULTS.minCallsBetweenCompactions,
});

/** The naive baseline: never compact, whatever happens. */
export function createNeverStrategy(): Strategy {
  return {
    id: "never",
    label: "Never",
    decide() {
      return { action: "KEEP" };
    },
  };
}

/**
 * A raw utilization threshold, exactly as most agent frameworks implement it.
 *
 * A raw baseline deliberately gets no cooldown, no reserve and no safe-boundary rule: it is
 * the naive comparison point, so its churn has to be visible in the results.
 */
export function createRawFixedThresholdStrategy(threshold: number): Strategy {
  const percent = Math.round(threshold * 100);
  return {
    id: `fixed-${percent}-raw`,
    label: `Fixed ${percent}% raw`,
    decide(request: DecisionRequest) {
      return { action: request.utilization >= threshold ? "COMPACT" : "KEEP" };
    },
  };
}

/**
 * The same threshold, but with the guards FoldPoint also has: the hard window ratio, the
 * reserve tokens, the cooldown (restarted by any attempt, successful or not) and the safe
 * boundary. It has no cost model, no minimum reclaim and no economics, so a difference
 * against it is a difference the economic model made.
 */
export function createGuardedFixedThresholdStrategy(
  threshold: number,
  windowTokens: number,
  guards: GuardSettings = SHARED_GUARDS,
): Strategy {
  const percent = Math.round(threshold * 100);
  let attempts = 0;
  let callsSinceLastAttempt = 0;

  return {
    id: `fixed-${percent}-guarded`,
    label: `Fixed ${percent}% guarded`,
    decide(request: DecisionRequest) {
      const remaining = windowTokens - request.contextTokens;
      const windowDanger =
        request.utilization >= guards.hardWindowRatio || remaining <= guards.reserveTokens;
      if (windowDanger) {
        return { action: "FORCE", reasons: ["HARD_WINDOW_RATIO"] };
      }
      if (request.utilization < threshold) {
        return { action: "KEEP" };
      }
      if (attempts > 0 && callsSinceLastAttempt < guards.minCallsBetweenCompactions) {
        return { action: "KEEP", reasons: ["COOLDOWN_ACTIVE"] };
      }
      return { action: "COMPACT" };
    },
    onRequest() {
      callsSinceLastAttempt += 1;
    },
    onCompaction() {
      attempts += 1;
      callsSinceLastAttempt = 0;
    },
  };
}

/** Every non-learning strategy in the comparison, in report order. */
export function createBaselineFactories(): StrategyFactory[] {
  const raw = [0.5, 0.7, 0.8, 0.9].map(
    (threshold) => () => createRawFixedThresholdStrategy(threshold),
  );
  const guarded = [0.7, 0.8, 0.9].map(
    (threshold) => (scenario: Scenario) =>
      createGuardedFixedThresholdStrategy(threshold, scenario.contextWindowTokens),
  );

  return [() => createNeverStrategy(), ...raw, ...guarded];
}
