import { NUMERIC_BOUNDS } from "./defaults";
import { clamp, emaUpdate } from "./math";
import { costOfUsage, isTokenOnlyPricing, resolveUnitPrices } from "./pricing";
import type {
  CompactionObservation,
  FoldPointDefaults,
  FoldPointProfileLearningState,
  FoldPointSessionState,
  PricingSnapshot,
  RequestObservation,
  SessionEndObservation,
} from "./types";

/** The pair of states a stateful update produces. Both are new objects; inputs are never mutated. */
export interface StateUpdate {
  learning: FoldPointProfileLearningState;
  session: FoldPointSessionState;
}

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
  cacheWriteTokens?: number | undefined;
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
  if (
    observation.promptTokens !== undefined &&
    observation.cacheWriteTokens !== undefined &&
    observation.cacheWriteTokens > observation.promptTokens
  ) {
    throw new RangeError(
      `FoldPoint observation "cacheWriteTokens" (${observation.cacheWriteTokens}) must not exceed "promptTokens" (${observation.promptTokens})`,
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
  assertOptionalTokenCount("cacheWriteTokens", observation.cacheWriteTokens);
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

/** A fresh profile learning state seeded from the cold-start defaults. */
export function createProfileLearningState(
  defaults: FoldPointDefaults,
): FoldPointProfileLearningState {
  return {
    version: 2,
    successfulCompactionCount: 0,
    retentionRatioEma: defaults.retentionRatio,
    retentionSamples: 0,
    compactPromptRatioEma: defaults.compactPromptRatio,
    compactPromptSamples: 0,
    compactOutputRatioEma: defaults.compactOutputRatio,
    compactOutputSamples: 0,
    compactCachedInputRatioEma: defaults.compactCachedInputRatio,
    compactCachedInputSamples: 0,
    compactCacheWriteRatioEma: defaults.compactCacheWriteRatio,
    compactCacheWriteSamples: 0,
    compactCostScaleEma: defaults.compactCostScale,
    compactCostScaleSamples: 0,
    cacheCoverageRatioEma: 0,
    cacheCoverageSamples: 0,
    reuseHorizonEma: defaults.expectedFutureCalls,
    horizonSamples: 0,
  };
}

/** A fresh session runtime state. */
export function createSessionState(): FoldPointSessionState {
  return {
    version: 2,
    requestCount: 0,
    compactionAttemptCount: 0,
    successfulCompactionCount: 0,
    failedCompactionCount: 0,
    callsSinceLastAttempt: 0,
    callsSinceLastSuccessfulCompaction: 0,
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
 * Rebuilds a well-formed profile learning state from arbitrary JSON.
 *
 * Unknown fields are ignored, missing fields fall back to the cold-start defaults, and
 * malformed numbers degrade to their default instead of throwing: persisted state must
 * never be able to break the decision path.
 */
export function normalizeProfileLearningState(
  raw: unknown,
  defaults: FoldPointDefaults,
): FoldPointProfileLearningState {
  if (raw === null || typeof raw !== "object") {
    return createProfileLearningState(defaults);
  }

  const source = raw as Partial<FoldPointProfileLearningState>;
  return {
    version: 2,
    successfulCompactionCount: readCount(source.successfulCompactionCount),
    retentionRatioEma: readRatio(
      source.retentionRatioEma,
      defaults.retentionRatio,
      NUMERIC_BOUNDS.retentionRatioMin,
      NUMERIC_BOUNDS.retentionRatioMax,
    ),
    retentionSamples: readCount(source.retentionSamples),
    compactPromptRatioEma: readRatio(
      source.compactPromptRatioEma,
      defaults.compactPromptRatio,
      0,
      NUMERIC_BOUNDS.compactPromptRatioMax,
    ),
    compactPromptSamples: readCount(source.compactPromptSamples),
    compactOutputRatioEma: readRatio(
      source.compactOutputRatioEma,
      defaults.compactOutputRatio,
      0,
      NUMERIC_BOUNDS.compactOutputRatioMax,
    ),
    compactOutputSamples: readCount(source.compactOutputSamples),
    compactCachedInputRatioEma: readRatio(
      source.compactCachedInputRatioEma,
      defaults.compactCachedInputRatio,
      0,
      1,
    ),
    compactCachedInputSamples: readCount(source.compactCachedInputSamples),
    compactCacheWriteRatioEma: readRatio(
      source.compactCacheWriteRatioEma,
      defaults.compactCacheWriteRatio,
      0,
      1,
    ),
    compactCacheWriteSamples: readCount(source.compactCacheWriteSamples),
    compactCostScaleEma: readRatio(
      source.compactCostScaleEma,
      defaults.compactCostScale,
      NUMERIC_BOUNDS.compactCostScaleMin,
      NUMERIC_BOUNDS.compactCostScaleMax,
    ),
    compactCostScaleSamples: readCount(source.compactCostScaleSamples),
    cacheCoverageRatioEma: readRatio(source.cacheCoverageRatioEma, 0, 0, 1),
    cacheCoverageSamples: readCount(source.cacheCoverageSamples),
    reuseHorizonEma:
      typeof source.reuseHorizonEma === "number" && Number.isFinite(source.reuseHorizonEma)
        ? Math.max(1, source.reuseHorizonEma)
        : defaults.expectedFutureCalls,
    horizonSamples: readCount(source.horizonSamples),
  };
}

/** Rebuilds a well-formed session runtime state from arbitrary JSON. */
export function normalizeSessionState(raw: unknown): FoldPointSessionState {
  if (raw === null || typeof raw !== "object") {
    return createSessionState();
  }

  const source = raw as Partial<FoldPointSessionState>;
  const session: FoldPointSessionState = {
    version: 2,
    requestCount: readCount(source.requestCount),
    compactionAttemptCount: readCount(source.compactionAttemptCount),
    successfulCompactionCount: readCount(source.successfulCompactionCount),
    failedCompactionCount: readCount(source.failedCompactionCount),
    callsSinceLastAttempt: readCount(source.callsSinceLastAttempt),
    callsSinceLastSuccessfulCompaction: readCount(source.callsSinceLastSuccessfulCompaction),
  };

  const lastRequestAt = readOptionalTimestamp(source.lastRequestAt);
  if (lastRequestAt !== undefined) {
    session.lastRequestAt = lastRequestAt;
  }
  const lastAttemptAt = readOptionalTimestamp(source.lastAttemptAt);
  if (lastAttemptAt !== undefined) {
    session.lastAttemptAt = lastAttemptAt;
  }
  const lastSuccessfulCompactionAt = readOptionalTimestamp(source.lastSuccessfulCompactionAt);
  if (lastSuccessfulCompactionAt !== undefined) {
    session.lastSuccessfulCompactionAt = lastSuccessfulCompactionAt;
  }
  const cacheExpiresAt = readOptionalTimestamp(source.cacheExpiresAt);
  if (cacheExpiresAt !== undefined) {
    session.cacheExpiresAt = cacheExpiresAt;
  }

  return session;
}

/**
 * Records one real model request.
 *
 * Profile learning: the cache *coverage* ratio (only when `promptTokens > 0`).
 * Session runtime: request count, the two call counters, the last request time, and the
 * exact cache expiry of the prefix this request built. A request that reports no expiry
 * **clears** the stored one, so a stale expiry can never control a newer prefix.
 */
export function applyRequestObservation(
  learning: FoldPointProfileLearningState,
  session: FoldPointSessionState,
  observation: RequestObservation,
  defaults: FoldPointDefaults,
): StateUpdate {
  validateRequestObservation(observation);

  const nextLearning: FoldPointProfileLearningState = { ...learning, version: 2 };
  const nextSession: FoldPointSessionState = {
    ...session,
    version: 2,
    requestCount: session.requestCount + 1,
    callsSinceLastAttempt: session.callsSinceLastAttempt + 1,
    callsSinceLastSuccessfulCompaction: session.callsSinceLastSuccessfulCompaction + 1,
    lastRequestAt: observation.timestamp,
  };

  if (observation.cacheExpiresAt !== undefined) {
    nextSession.cacheExpiresAt = observation.cacheExpiresAt;
  } else {
    delete nextSession.cacheExpiresAt;
  }

  if (observation.promptTokens > 0) {
    const observedCacheCoverageRatio = clamp(
      (observation.cachedInputTokens ?? 0) / observation.promptTokens,
      0,
      1,
    );
    nextLearning.cacheCoverageRatioEma = emaUpdate(
      learning.cacheCoverageRatioEma,
      observedCacheCoverageRatio,
      defaults.emaAlpha,
    );
    nextLearning.cacheCoverageSamples = learning.cacheCoverageSamples + 1;
  }

  return { learning: nextLearning, session: nextSession };
}

/**
 * Records the outcome of a real compaction attempt.
 *
 * Every attempt — successful or not — resets the cooldown (`callsSinceLastAttempt`) and
 * bumps the attempt counter. Only successful attempts update profile learning: retention,
 * the compaction call's usage ratios (scale-free, so they survive pricing changes) and the
 * actual-cost scale. A failed attempt teaches nothing about the compactor.
 */
export function applyCompactionObservation(
  learning: FoldPointProfileLearningState,
  session: FoldPointSessionState,
  observation: CompactionObservation,
  defaults: FoldPointDefaults,
  pricing?: PricingSnapshot,
): StateUpdate {
  validateCompactionObservation(observation);

  const nextLearning: FoldPointProfileLearningState = { ...learning, version: 2 };
  const nextSession: FoldPointSessionState = {
    ...session,
    version: 2,
    compactionAttemptCount: session.compactionAttemptCount + 1,
    callsSinceLastAttempt: 0,
    lastAttemptAt: observation.timestamp,
  };

  if (!observation.success) {
    nextSession.failedCompactionCount = session.failedCompactionCount + 1;
    return { learning: nextLearning, session: nextSession };
  }

  nextSession.successfulCompactionCount = session.successfulCompactionCount + 1;
  nextSession.callsSinceLastSuccessfulCompaction = 0;
  nextSession.lastSuccessfulCompactionAt = observation.timestamp;
  nextLearning.successfulCompactionCount = learning.successfulCompactionCount + 1;

  const beforeTokens = observation.beforeTokens;

  nextLearning.retentionRatioEma = emaUpdate(
    learning.retentionRatioEma,
    clamp(
      observation.afterTokens / beforeTokens,
      NUMERIC_BOUNDS.retentionRatioMin,
      NUMERIC_BOUNDS.retentionRatioMax,
    ),
    defaults.emaAlpha,
  );
  nextLearning.retentionSamples = learning.retentionSamples + 1;

  if (observation.promptTokens !== undefined) {
    nextLearning.compactPromptRatioEma = emaUpdate(
      learning.compactPromptRatioEma,
      clamp(observation.promptTokens / beforeTokens, 0, NUMERIC_BOUNDS.compactPromptRatioMax),
      defaults.emaAlpha,
    );
    nextLearning.compactPromptSamples = learning.compactPromptSamples + 1;
  }

  if (observation.outputTokens !== undefined) {
    nextLearning.compactOutputRatioEma = emaUpdate(
      learning.compactOutputRatioEma,
      clamp(observation.outputTokens / beforeTokens, 0, NUMERIC_BOUNDS.compactOutputRatioMax),
      defaults.emaAlpha,
    );
    nextLearning.compactOutputSamples = learning.compactOutputSamples + 1;
  }

  if (observation.cachedInputTokens !== undefined && (observation.promptTokens ?? 0) > 0) {
    nextLearning.compactCachedInputRatioEma = emaUpdate(
      learning.compactCachedInputRatioEma,
      clamp(observation.cachedInputTokens / (observation.promptTokens ?? 1), 0, 1),
      defaults.emaAlpha,
    );
    nextLearning.compactCachedInputSamples = learning.compactCachedInputSamples + 1;
  }

  if (observation.cacheWriteTokens !== undefined && (observation.promptTokens ?? 0) > 0) {
    nextLearning.compactCacheWriteRatioEma = emaUpdate(
      learning.compactCacheWriteRatioEma,
      clamp(observation.cacheWriteTokens / (observation.promptTokens ?? 1), 0, 1),
      defaults.emaAlpha,
    );
    nextLearning.compactCacheWriteSamples = learning.compactCacheWriteSamples + 1;
  }

  // The actual-cost scale is dimensionless and only meaningful with a real currency, a
  // complete usage report and a modeled cost to compare against.
  if (
    observation.actualCost !== undefined &&
    observation.promptTokens !== undefined &&
    pricing !== undefined &&
    !isTokenOnlyPricing(pricing)
  ) {
    const modeledCost = costOfUsage(resolveUnitPrices(pricing), {
      promptTokens: observation.promptTokens,
      cachedInputTokens: observation.cachedInputTokens ?? 0,
      cacheWriteTokens: observation.cacheWriteTokens ?? 0,
      outputTokens: observation.outputTokens ?? 0,
    });
    if (Number.isFinite(modeledCost) && modeledCost > 0) {
      nextLearning.compactCostScaleEma = emaUpdate(
        learning.compactCostScaleEma,
        clamp(
          observation.actualCost / modeledCost,
          NUMERIC_BOUNDS.compactCostScaleMin,
          NUMERIC_BOUNDS.compactCostScaleMax,
        ),
        defaults.emaAlpha,
      );
      nextLearning.compactCostScaleSamples = learning.compactCostScaleSamples + 1;
    }
  }

  return { learning: nextLearning, session: nextSession };
}

/**
 * Learns the reuse horizon at session end: the number of calls between the last successful
 * compaction of this session and its end. A no-op when the session never compacted
 * successfully, because then there is no horizon to learn.
 */
export function applySessionEnd(
  learning: FoldPointProfileLearningState,
  session: FoldPointSessionState,
  observation: SessionEndObservation,
  defaults: FoldPointDefaults,
): FoldPointProfileLearningState {
  assertFiniteNumber("timestamp", observation.timestamp, 0);

  if (session.successfulCompactionCount <= 0) {
    return { ...learning, version: 2 };
  }

  return {
    ...learning,
    version: 2,
    reuseHorizonEma: emaUpdate(
      learning.reuseHorizonEma,
      session.callsSinceLastSuccessfulCompaction,
      defaults.emaAlpha,
    ),
    horizonSamples: learning.horizonSamples + 1,
  };
}
