import {
  createProfileState,
  decideFoldPoint,
  type FoldPointDecision,
  type FoldPointDecisionOptions,
  type FoldPointInput,
  type FoldPointProfile,
  type FoldPointProfileState,
  resolveDefaults,
} from "../src/index";

export const DEFAULT_OPTIONS_SET = resolveDefaults();

export const PRICING = {
  currency: "USD",
  inputPerMillion: 3,
  outputPerMillion: 15,
  cacheReadPerMillion: 0.3,
  cacheWritePerMillion: 3.75,
};

export const BASE_TIMESTAMP = 1_700_000_000_000;

export function makeProfile(overrides: Partial<FoldPointProfile> = {}): FoldPointProfile {
  return {
    provider: "test-provider",
    model: "test-model",
    contextWindowTokens: 200_000,
    compactorId: "test-compactor",
    pricing: { ...PRICING },
    ...overrides,
  };
}

export function makeState(overrides: Partial<FoldPointProfileState> = {}): FoldPointProfileState {
  return { ...createProfileState(DEFAULT_OPTIONS_SET), ...overrides };
}

export function makeInput(overrides: Partial<FoldPointInput> = {}): FoldPointInput {
  return {
    profile: makeProfile(),
    timestamp: BASE_TIMESTAMP,
    contextTokens: 50_000,
    safeBoundary: true,
    compactionAllowed: true,
    ...overrides,
  };
}

/**
 * A profile with real compaction history: a good compactor, a live cache with a known TTL,
 * a learned horizon of 10 calls and a learned compaction cost.
 */
export const HISTORY: Partial<FoldPointProfileState> = {
  compactionCount: 1,
  successfulCompactionCount: 1,
  callsSinceLastCompaction: 10,
  retentionSamples: 4,
  retentionRatioEma: 0.25,
  cacheSamples: 3,
  cacheHitRatioEma: 0.9,
  horizonSamples: 3,
  reuseHorizonEma: 10,
  compactionCostSamples: 2,
  compactionCostEma: 0.05,
};

export function decideWith(
  inputOverrides: Partial<FoldPointInput> = {},
  stateOverrides: Partial<FoldPointProfileState> = {},
  options?: FoldPointDecisionOptions,
): FoldPointDecision {
  return decideFoldPoint(makeInput(inputOverrides), makeState(stateOverrides), options);
}

/** A profile whose cache is known to stay alive for a long time. */
export function profileWithCacheTtl(ttlMs: number): FoldPointProfile {
  return makeProfile({ cachePolicy: { ttlMs } });
}

export function expectAllMetricsFinite(decision: FoldPointDecision): void {
  for (const [key, value] of Object.entries(decision.metrics)) {
    if (value === null) {
      continue;
    }
    if (!Number.isFinite(value)) {
      throw new Error(`metric ${key} must be finite, received ${String(value)}`);
    }
  }
  if (!Number.isFinite(decision.confidence)) {
    throw new Error(`confidence must be finite, received ${decision.confidence}`);
  }
}
