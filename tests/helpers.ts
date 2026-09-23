import {
  createProfileLearningState,
  createSessionState,
  decideFoldPoint,
  type FoldPointDecision,
  type FoldPointDecisionOptions,
  type FoldPointInput,
  type FoldPointProfile,
  type FoldPointProfileLearningState,
  type FoldPointSessionState,
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
export const SESSION_A = "session-a";
export const SESSION_B = "session-b";

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

export function makeLearning(
  overrides: Partial<FoldPointProfileLearningState> = {},
): FoldPointProfileLearningState {
  return { ...createProfileLearningState(DEFAULT_OPTIONS_SET), ...overrides };
}

export function makeSession(overrides: Partial<FoldPointSessionState> = {}): FoldPointSessionState {
  return { ...createSessionState(), ...overrides };
}

export function makeInput(overrides: Partial<FoldPointInput> = {}): FoldPointInput {
  return {
    sessionId: SESSION_A,
    profile: makeProfile(),
    timestamp: BASE_TIMESTAMP,
    contextTokens: 50_000,
    safeBoundary: true,
    compactionAllowed: true,
    ...overrides,
  };
}

/**
 * A profile with real compaction history: a good compactor, learned usage ratios, a learned
 * cache coverage ratio and a learned horizon of 10 calls.
 */
export const HISTORY: Partial<FoldPointProfileLearningState> = {
  successfulCompactionCount: 2,
  retentionSamples: 4,
  retentionRatioEma: 0.25,
  compactPromptSamples: 3,
  compactPromptRatioEma: 1,
  compactOutputSamples: 3,
  compactOutputRatioEma: 0.1,
  compactCachedInputSamples: 2,
  compactCachedInputRatioEma: 0,
  compactCacheWriteSamples: 0,
  compactCacheWriteRatioEma: 0,
  compactCostScaleSamples: 0,
  compactCostScaleEma: 1,
  cacheCoverageSamples: 3,
  cacheCoverageRatioEma: 0.9,
  horizonSamples: 3,
  reuseHorizonEma: 10,
};

/** A session that already compacted once and is past the cooldown. */
export const SESSION_HISTORY: Partial<FoldPointSessionState> = {
  requestCount: 10,
  compactionAttemptCount: 1,
  successfulCompactionCount: 1,
  callsSinceLastAttempt: 10,
  callsSinceLastSuccessfulCompaction: 10,
};

export function decideWith(
  inputOverrides: Partial<FoldPointInput> = {},
  learningOverrides: Partial<FoldPointProfileLearningState> = {},
  sessionOverrides: Partial<FoldPointSessionState> = {},
  options?: FoldPointDecisionOptions,
): FoldPointDecision {
  return decideFoldPoint(
    makeInput(inputOverrides),
    makeLearning(learningOverrides),
    makeSession(sessionOverrides),
    options,
  );
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
