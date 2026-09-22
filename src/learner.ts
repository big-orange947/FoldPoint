import { NUMERIC_BOUNDS } from "./defaults";
import { clamp, emaUpdate } from "./math";
import { costOfUsage, resolveUnitPrices } from "./pricing";
import type {
  CompactionObservation,
  FoldPointDefaults,
  FoldPointProfileState,
  PricingSnapshot,
  RequestObservation,
  SessionEndObservation,
} from "./types";

function assertFiniteNumber(name: string, value: unknown, min: number): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(
      `FoldPoint observation "${name}" must be a finite number, received ${String(value)}`,
    );
  }
  if (value < min) {
    throw new RangeError(`FoldPoint observation "${name}" must be >= ${min}, received ${value}`);
  }
}

function assertOptionalTokenCount(name: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  assertFiniteNumber(name, value, 0);
}

function assertUsageConsistency(observation: {
  promptTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
}): void {
  if (
    observation.promptTokens !== undefined &&
    observation.cachedInputTokens !== undefined &&
    observation.cachedInputTokens > observation.promptTokens
  ) {
    throw new RangeError(
      `FoldPoint observation "cachedInputTokens" (${observation.cachedInputTokens}) must not exceed "promptTokens" (${observation.promptTokens})`,
    );
  }
}

/** Validates a request observation. Throws `RangeError` on illegal values. */
export function validateRequestObservation(observation: RequestObservation): void {
  assertFiniteNumber("timestamp", observation.timestamp, 0);
  assertFiniteNumber("promptTokens", observation.promptTokens, 0);
  assertOptionalTokenCount("cachedInputTokens", observation.cachedInputTokens);
  assertOptionalTokenCount("cacheWriteTokens", observation.cacheWriteTokens);
  assertOptionalTokenCount("outputTokens", observation.outputTokens);
  if (observation.actualCost !== undefined) {
    assertFiniteNumber("actualCost", observation.actualCost, 0);
  }
  if (observation.cacheExpiresAt !== undefined) {
    assertFiniteNumber("cacheExpiresAt", observation.cacheExpiresAt, 0);
  }
  assertUsageConsistency(observation);
}

/** Validates a compaction observation. Throws `RangeError` on illegal values. */
export function validateCompactionObservation(observation: CompactionObservation): void {
  assertFiniteNumber("timestamp", observation.timestamp, 0);
  assertFiniteNumber("beforeTokens", observation.beforeTokens, 0);
  assertFiniteNumber("afterTokens", observation.afterTokens, 0);
  assertOptionalTokenCount("promptTokens", observation.promptTokens);
  assertOptionalTokenCount("cachedInputTokens", observation.cachedInputTokens);
  assertOptionalTokenCount("outputTokens", observation.outputTokens);
  if (observation.actualCost !== undefined) {
    assertFiniteNumber("actualCost", observation.actualCost, 0);
  }
  assertUsageConsistency(observation);
  if (observation.success && observation.beforeTokens <= 0) {
    throw new RangeError(
      "FoldPoint compaction observation must report beforeTokens > 0 for a successful compaction",
    );
  }
}

/** A fresh profile state seeded from the cold-start defaults. */
export function createProfileState(defaults: FoldPointDefaults): FoldPointProfileState {
  return {
    version: 1,
    requestCount: 0,
    compactionCount: 0,
    successfulCompactionCount: 0,
    callsSinceLastCompaction: 0,
    retentionRatioEma: defaults.retentionRatio,
    compactOutputRatioEma: defaults.compactOutputRatio,
    cacheHitRatioEma: 0,
    reuseHorizonEma: defaults.expectedFutureCalls,
    growthPerCallEma: 0,
    retentionSamples: 0,
    compactionCostSamples: 0,
    cacheSamples: 0,
    horizonSamples: 0,
    growthSamples: 0,
  };
}

function readOptionalTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function readRatio(value: unknown, fallback: number, min = 0, max = 1): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return clamp(value, min, max);
}

/**
 * Rebuilds a well-formed profile state from arbitrary JSON.
 *
 * Unknown fields are ignored, missing fields fall back to the cold-start defaults and
 * malformed numbers degrade to their default instead of throwing: persisted state must
 * never be able to break the decision path.
 */
export function normalizeProfileState(
  raw: unknown,
  defaults: FoldPointDefaults,
): FoldPointProfileState {
  if (raw === null || typeof raw !== "object") {
    return createProfileState(defaults);
  }

  const source = raw as Partial<FoldPointProfileState>;
  const state: FoldPointProfileState = {
    version: 1,
    requestCount: readCount(source.requestCount),
    compactionCount: readCount(source.compactionCount),
    successfulCompactionCount: readCount(source.successfulCompactionCount),
    callsSinceLastCompaction: readCount(source.callsSinceLastCompaction),
    retentionRatioEma: readRatio(
      source.retentionRatioEma,
      defaults.retentionRatio,
      NUMERIC_BOUNDS.retentionRatioMin,
      NUMERIC_BOUNDS.retentionRatioMax,
    ),
    compactOutputRatioEma: readRatio(
      source.compactOutputRatioEma,
      defaults.compactOutputRatio,
      0,
      NUMERIC_BOUNDS.compactOutputRatioMax,
    ),
    cacheHitRatioEma: readRatio(source.cacheHitRatioEma, 0, 0, 1),
    reuseHorizonEma:
      typeof source.reuseHorizonEma === "number" && Number.isFinite(source.reuseHorizonEma)
        ? Math.max(1, source.reuseHorizonEma)
        : defaults.expectedFutureCalls,
    growthPerCallEma:
      typeof source.growthPerCallEma === "number" && Number.isFinite(source.growthPerCallEma)
        ? Math.max(0, source.growthPerCallEma)
        : 0,
    retentionSamples: readCount(source.retentionSamples),
    compactionCostSamples: readCount(source.compactionCostSamples),
    cacheSamples: readCount(source.cacheSamples),
    horizonSamples: readCount(source.horizonSamples),
    growthSamples: readCount(source.growthSamples),
  };

  const lastRequestAt = readOptionalTimestamp(source.lastRequestAt);
  if (lastRequestAt !== undefined) {
    state.lastRequestAt = lastRequestAt;
  }
  const lastCompactionAt = readOptionalTimestamp(source.lastCompactionAt);
  if (lastCompactionAt !== undefined) {
    state.lastCompactionAt = lastCompactionAt;
  }
  const lastCacheExpiresAt = readOptionalTimestamp(source.lastCacheExpiresAt);
  if (lastCacheExpiresAt !== undefined) {
    state.lastCacheExpiresAt = lastCacheExpiresAt;
  }
  if (typeof source.compactionCostEma === "number" && Number.isFinite(source.compactionCostEma)) {
    state.compactionCostEma = Math.max(0, source.compactionCostEma);
  }
  const lastPromptTokens = readCount(source.lastPromptTokens);
  if (lastPromptTokens > 0) {
    state.lastPromptTokens = lastPromptTokens;
  }

  return state;
}

/**
 * Records one real model request.
 *
 * Updates: request count, call counter since the last compaction, cache-hit EMA (only when
 * `promptTokens > 0`) and the exact cache expiry when the host reports one.
 */
export function applyRequestObservation(
  state: FoldPointProfileState,
  observation: RequestObservation,
  defaults: FoldPointDefaults,
): FoldPointProfileState {
  validateRequestObservation(observation);

  const next: FoldPointProfileState = {
    ...state,
    version: 1,
    requestCount: state.requestCount + 1,
    callsSinceLastCompaction: state.callsSinceLastCompaction + 1,
    lastRequestAt: observation.timestamp,
  };

  if (observation.cacheExpiresAt !== undefined) {
    next.lastCacheExpiresAt = observation.cacheExpiresAt;
  }

  if (observation.promptTokens > 0) {
    const observedCacheHitRatio = clamp(
      (observation.cachedInputTokens ?? 0) / observation.promptTokens,
      0,
      1,
    );
    next.cacheHitRatioEma = emaUpdate(
      state.cacheHitRatioEma,
      observedCacheHitRatio,
      defaults.emaAlpha,
    );
    next.cacheSamples = state.cacheSamples + 1;
  }

  // Growth is only learned when the context actually grew: a smaller prompt means a
  // compaction or a reset happened, which says nothing about the growth rate.
  if (state.lastPromptTokens !== undefined && observation.promptTokens >= state.lastPromptTokens) {
    next.growthPerCallEma = emaUpdate(
      state.growthPerCallEma,
      observation.promptTokens - state.lastPromptTokens,
      defaults.emaAlpha,
    );
    next.growthSamples = state.growthSamples + 1;
  }
  next.lastPromptTokens = observation.promptTokens;

  return next;
}

/**
 * Records the outcome of a real compaction attempt.
 *
 * Only successful compactions update the retention ratio, the compaction output ratio and
 * the compaction cost. Failures are counted but do not reset the cooldown, so a failing
 * compactor cannot be hammered; window safety (`FORCE`) is unaffected by the cooldown.
 */
export function applyCompactionObservation(
  state: FoldPointProfileState,
  observation: CompactionObservation,
  defaults: FoldPointDefaults,
  pricing?: PricingSnapshot,
): FoldPointProfileState {
  validateCompactionObservation(observation);

  const next: FoldPointProfileState = {
    ...state,
    version: 1,
    compactionCount: state.compactionCount + 1,
  };

  if (!observation.success) {
    return next;
  }

  const observedRetentionRatio = clamp(
    observation.afterTokens / observation.beforeTokens,
    NUMERIC_BOUNDS.retentionRatioMin,
    NUMERIC_BOUNDS.retentionRatioMax,
  );
  next.retentionRatioEma = emaUpdate(
    state.retentionRatioEma,
    observedRetentionRatio,
    defaults.emaAlpha,
  );
  next.retentionSamples = state.retentionSamples + 1;

  if (observation.outputTokens !== undefined) {
    const observedCompactOutputRatio = clamp(
      observation.outputTokens / observation.beforeTokens,
      0,
      NUMERIC_BOUNDS.compactOutputRatioMax,
    );
    next.compactOutputRatioEma = emaUpdate(
      state.compactOutputRatioEma,
      observedCompactOutputRatio,
      defaults.emaAlpha,
    );
  }

  let observedCost: number | undefined;
  if (observation.actualCost !== undefined) {
    observedCost = observation.actualCost;
  } else if (observation.promptTokens !== undefined || observation.outputTokens !== undefined) {
    observedCost = costOfUsage(resolveUnitPrices(pricing), {
      promptTokens: observation.promptTokens ?? 0,
      cachedInputTokens: observation.cachedInputTokens ?? 0,
      outputTokens: observation.outputTokens ?? 0,
    });
  }

  if (observedCost !== undefined && Number.isFinite(observedCost)) {
    const previousCost = state.compactionCostEma ?? observedCost;
    next.compactionCostEma = emaUpdate(previousCost, observedCost, defaults.emaAlpha);
    next.compactionCostSamples = state.compactionCostSamples + 1;
  }

  next.successfulCompactionCount = state.successfulCompactionCount + 1;
  next.lastCompactionAt = observation.timestamp;
  next.callsSinceLastCompaction = 0;

  return next;
}

/**
 * Records the end of a session, so the reuse horizon can be learned from real data.
 * A no-op when the profile never compacted: the horizon is only meaningful after a
 * compaction happened.
 */
export function applySessionEnd(
  state: FoldPointProfileState,
  observation: SessionEndObservation,
  defaults: FoldPointDefaults,
): FoldPointProfileState {
  assertFiniteNumber("timestamp", observation.timestamp, 0);
  if (state.compactionCount <= 0) {
    return { ...state, version: 1 };
  }

  const callsSinceLastCompaction =
    observation.callsSinceLastCompaction ?? state.callsSinceLastCompaction;
  assertFiniteNumber("callsSinceLastCompaction", callsSinceLastCompaction, 0);

  return {
    ...state,
    version: 1,
    reuseHorizonEma: emaUpdate(state.reuseHorizonEma, callsSinceLastCompaction, defaults.emaAlpha),
    horizonSamples: state.horizonSamples + 1,
  };
}
