import type { FoldPointAction, FoldPointReason } from "../src/index";
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
  /** Ground-truth cost of the compaction call. */
  cost: number;
  /** Ground-truth break-even of this compaction, when it has a positive per-call saving. */
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

/** The naive baseline: never compact, whatever happens. */
export function createNeverStrategy(): Strategy {
  return {
    id: "never",
    label: "Never compact",
    decide() {
      return { action: "KEEP" };
    },
  };
}

/**
 * Fixed utilization thresholds, exactly as most agent frameworks implement them.
 *
 * These baselines deliberately get no cooldown and no minimum reclaim gate: they are the
 * naive comparison point, so their churn must be visible in the results.
 */
export function createFixedThresholdStrategy(threshold: number): Strategy {
  const percent = Math.round(threshold * 100);
  return {
    id: `fixed-${percent}`,
    label: `Fixed ${percent}%`,
    decide(request: DecisionRequest) {
      return { action: request.utilization >= threshold ? "COMPACT" : "KEEP" };
    },
  };
}

export const FIXED_THRESHOLDS: readonly number[] = Object.freeze([0.5, 0.7, 0.8, 0.9]);

/** Every non-learning strategy in the comparison, in report order. */
export function createBaselineFactories(): StrategyFactory[] {
  return [
    () => createNeverStrategy(),
    ...FIXED_THRESHOLDS.map((threshold) => () => createFixedThresholdStrategy(threshold)),
  ];
}
