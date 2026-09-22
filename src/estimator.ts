import {
  estimateCacheSurvival,
  resolveCacheExpiresAt,
  resolveCacheHitRatio,
  resolveIdleMs,
} from "./cache";
import { isResolvedDefaults, NUMERIC_BOUNDS, resolveDefaults } from "./defaults";
import { clamp, computeConfidence, safeDivide } from "./math";
import { resolveUnitPrices, type UnitPrices } from "./pricing";
import type {
  FoldPointDecision,
  FoldPointDecisionMetrics,
  FoldPointDecisionOptions,
  FoldPointDefaults,
  FoldPointInput,
  FoldPointProfileState,
  FoldPointReason,
} from "./types";

/**
 * Break-even is unreachable but still representable when the division overflows.
 * Used only as a numeric guard so that metrics stay JSON-safe.
 */
const UNREACHABLE_BREAK_EVEN = Number.MAX_SAFE_INTEGER;

function assertFiniteNumber(
  name: string,
  value: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(
      `FoldPoint input "${name}" must be a finite number, received ${String(value)}`,
    );
  }
  if (value < min || value > max) {
    throw new RangeError(
      `FoldPoint input "${name}" must be within [${min}, ${max}], received ${value}`,
    );
  }
}

function assertNonEmptyString(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RangeError(`FoldPoint profile "${name}" must be a non-empty string`);
  }
}

/** Reads a state field defensively: malformed state degrades to the cold-start value. */
function readStateNumber(
  value: unknown,
  fallback: number,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return clamp(value, min, max);
}

/**
 * Validates a decision input. Illegal data throws instead of being silently repaired.
 * Throws `RangeError`.
 */
export function validateFoldPointInput(input: FoldPointInput): void {
  if (input === null || typeof input !== "object") {
    throw new RangeError("FoldPoint input must be an object");
  }

  const profile = input.profile;
  if (profile === null || typeof profile !== "object") {
    throw new RangeError("FoldPoint input must carry a profile");
  }
  assertNonEmptyString("model", profile.model);
  assertNonEmptyString("compactorId", profile.compactorId);
  assertFiniteNumber("profile.contextWindowTokens", profile.contextWindowTokens, Number.MIN_VALUE);

  assertFiniteNumber("timestamp", input.timestamp, 0);
  assertFiniteNumber("contextTokens", input.contextTokens, 0);

  if (input.cachedTokens !== undefined) {
    assertFiniteNumber("cachedTokens", input.cachedTokens, 0);
    if (input.cachedTokens > input.contextTokens) {
      throw new RangeError(
        `FoldPoint input "cachedTokens" (${input.cachedTokens}) must not exceed "contextTokens" (${input.contextTokens})`,
      );
    }
  }

  if (input.idleMs !== undefined) {
    assertFiniteNumber("idleMs", input.idleMs, 0);
  }
  if (input.expectedFutureCalls !== undefined) {
    assertFiniteNumber("expectedFutureCalls", input.expectedFutureCalls, 1);
  }
  if (input.cacheExpiresAt !== undefined) {
    assertFiniteNumber("cacheExpiresAt", input.cacheExpiresAt, 0);
  }
  if (input.safeBoundary !== undefined && typeof input.safeBoundary !== "boolean") {
    throw new RangeError(`FoldPoint input "safeBoundary" must be a boolean`);
  }
  if (input.compactionAllowed !== undefined && typeof input.compactionAllowed !== "boolean") {
    throw new RangeError(`FoldPoint input "compactionAllowed" must be a boolean`);
  }
}

/** Future-call horizon: host input, then learned horizon, then cold start. */
function resolveExpectedFutureCalls(
  input: FoldPointInput,
  horizonSamples: number,
  reuseHorizonEma: number,
  defaults: FoldPointDefaults,
): number {
  if (input.expectedFutureCalls !== undefined) {
    return input.expectedFutureCalls;
  }
  if (horizonSamples > 0) {
    return clamp(reuseHorizonEma, 1, Number.MAX_SAFE_INTEGER);
  }
  return defaults.expectedFutureCalls;
}

/**
 * Advisory token count at which something can actually change: the soft-window boundary,
 * the minimum-reclaim boundary, the economic break-even boundary, or the force boundary,
 * whichever comes first.
 */
function computeNextCheckAtTokens(args: {
  contextTokens: number;
  windowTokens: number;
  defaults: FoldPointDefaults;
  retentionRatio: number;
  economicBoundaryTokens: number;
}): number {
  const { contextTokens, windowTokens, defaults, retentionRatio, economicBoundaryTokens } = args;

  const softBoundary = Math.ceil(defaults.softWindowRatio * windowTokens);
  const forceBoundary = Math.min(
    Math.ceil(defaults.hardWindowRatio * windowTokens),
    windowTokens - defaults.reserveTokens,
  );
  const reclaimBoundary =
    retentionRatio < 1
      ? Math.ceil(defaults.minReclaimTokens / (1 - retentionRatio))
      : Number.POSITIVE_INFINITY;

  const candidates = [softBoundary, reclaimBoundary, economicBoundaryTokens].filter(
    (value) => Number.isFinite(value) && value > contextTokens,
  );

  const next = candidates.length > 0 ? Math.min(...candidates) : forceBoundary;
  return Math.max(
    Math.ceil(contextTokens) + 1,
    Math.ceil(Math.min(next, Math.max(forceBoundary, 0))),
  );
}

/**
 * Pure decision function: same `input`, `state` and `options` always produce the same
 * decision. It never mutates state, never performs I/O, never allocates unbounded memory
 * and runs in O(1) time and space.
 */
export function decideFoldPoint(
  input: FoldPointInput,
  state: FoldPointProfileState,
  options?: FoldPointDecisionOptions,
): FoldPointDecision {
  validateFoldPointInput(input);
  // A default set produced by resolveDefaults is already validated: reuse it as is, so the
  // hot path stays allocation-free.
  const defaults: FoldPointDefaults = isResolvedDefaults(options?.defaults)
    ? (options?.defaults as FoldPointDefaults)
    : resolveDefaults(options?.defaults);

  const windowTokens = input.profile.contextWindowTokens;
  const contextTokens = input.contextTokens;
  const utilization = contextTokens / windowTokens;
  const remainingTokens = windowTokens - contextTokens;

  // --- evidence ---
  const retentionSamples = readStateNumber(state?.retentionSamples, 0);
  const cacheSamples = readStateNumber(state?.cacheSamples, 0);
  const horizonSamples = readStateNumber(state?.horizonSamples, 0);
  const compactionCostSamples = readStateNumber(state?.compactionCostSamples, 0);
  const compactionCount = readStateNumber(state?.compactionCount, 0);
  const callsSinceLastCompaction = readStateNumber(state?.callsSinceLastCompaction, 0);

  const retentionRatio = clamp(
    retentionSamples > 0
      ? readStateNumber(state?.retentionRatioEma, defaults.retentionRatio)
      : defaults.retentionRatio,
    NUMERIC_BOUNDS.retentionRatioMin,
    NUMERIC_BOUNDS.retentionRatioMax,
  );
  const compactOutputRatio = clamp(
    retentionSamples > 0
      ? readStateNumber(state?.compactOutputRatioEma, defaults.compactOutputRatio)
      : defaults.compactOutputRatio,
    0,
    NUMERIC_BOUNDS.compactOutputRatioMax,
  );
  const reuseHorizonEma = readStateNumber(state?.reuseHorizonEma, defaults.expectedFutureCalls, 1);
  const growthSamples = readStateNumber(state?.growthSamples, 0);
  const growthPerCall = growthSamples > 0 ? readStateNumber(state?.growthPerCallEma, 0) : 0;

  const confidence = computeConfidence(
    { retentionSamples, cacheSamples, horizonSamples },
    defaults,
  );

  // --- cache ---
  const prices: UnitPrices = resolveUnitPrices(input.profile.pricing);
  const cacheEnabled = prices.hasCacheDiscount && input.profile.cachePolicy?.disabled !== true;
  const cachedTokens = clamp(input.cachedTokens ?? 0, 0, contextTokens);
  const uncachedTokens = contextTokens - cachedTokens;
  const idleMs = resolveIdleMs(input, state ?? {});

  const cacheEstimate = estimateCacheSurvival({
    timestamp: input.timestamp,
    idleMs,
    contextTokens,
    cachedTokens,
    cachePolicy: input.profile.cachePolicy,
    cacheExpiresAt: resolveCacheExpiresAt(input, state ?? {}),
    cacheHitRatioEma: readStateNumber(state?.cacheHitRatioEma, 0, 0, 1),
    cacheSamples,
    hasCacheDiscount: prices.hasCacheDiscount,
  });
  const cacheSurvival = cacheEnabled ? cacheEstimate.survival : 0;

  // --- reclaim ---
  const estimatedPostCompactTokens = contextTokens * retentionRatio;
  const estimatedReclaimTokens = contextTokens - estimatedPostCompactTokens;
  const estimatedReclaimRatio = safeDivide(estimatedReclaimTokens, contextTokens, 0);

  // --- replay costs ---
  const currentReplayCost =
    uncachedTokens * prices.inputPerToken +
    cachedTokens *
      (cacheSurvival * prices.cacheReadPerToken + (1 - cacheSurvival) * prices.inputPerToken);

  const observedHitRatio = resolveCacheHitRatio(
    { cacheHitRatioEma: readStateNumber(state?.cacheHitRatioEma, 0, 0, 1), cacheSamples },
    contextTokens,
    cachedTokens,
  );
  // A rebuilt prefix is never assumed to be better cached than the current one.
  const newPrefixHitRatio = cacheEnabled
    ? clamp(Math.min(observedHitRatio, cacheSurvival), 0, 1)
    : 0;

  const laterPostCompactReplayCost =
    estimatedPostCompactTokens *
    (newPrefixHitRatio * prices.cacheReadPerToken + (1 - newPrefixHitRatio) * prices.inputPerToken);
  const firstPostCompactReplayCost = estimatedPostCompactTokens * prices.cacheWritePerToken;

  // --- compaction call cost ---
  const estimatedCompactOutputTokens = contextTokens * compactOutputRatio;
  const coldStartCompactCallCost =
    contextTokens * prices.inputPerToken + estimatedCompactOutputTokens * prices.outputPerToken;

  const learnedCompactCallCost = readStateNumber(state?.compactionCostEma, Number.NaN);
  const usesLearnedCost =
    compactionCostSamples > 0 &&
    Number.isFinite(learnedCompactCallCost) &&
    learnedCompactCallCost >= 0;
  const compactCallCost = usesLearnedCost ? learnedCompactCallCost : coldStartCompactCallCost;

  // --- horizon and totals ---
  const expectedFutureCalls = resolveExpectedFutureCalls(
    input,
    horizonSamples,
    reuseHorizonEma,
    defaults,
  );

  const estimatedKeepCost = expectedFutureCalls * currentReplayCost;
  const estimatedCompactCost =
    compactCallCost +
    firstPostCompactReplayCost +
    Math.max(expectedFutureCalls - 1, 0) * laterPostCompactReplayCost;
  const estimatedNetSaving = estimatedKeepCost - estimatedCompactCost;
  const estimatedSavingPerFutureCall = currentReplayCost - laterPostCompactReplayCost;

  let breakEvenCalls: number | null;
  if (estimatedSavingPerFutureCall > 0) {
    const raw = (compactCallCost + firstPostCompactReplayCost) / estimatedSavingPerFutureCall;
    breakEvenCalls = Number.isFinite(raw) ? raw : UNREACHABLE_BREAK_EVEN;
  } else {
    breakEvenCalls = null;
  }

  const belowSoftWindow = utilization < defaults.softWindowRatio;
  const uncertaintyPenalty =
    defaults.uncertaintyPenalty * (belowSoftWindow ? defaults.softWindowPenaltyMultiplier : 1);
  const adjustedNetSaving = estimatedNetSaving * confidence - uncertaintyPenalty * compactCallCost;

  // Below the soft window the window is not scarce, so the payback must be quick.
  // A compaction can only pay off while its reclaim lasts: once the context has regrown to
  // its pre-compaction size, the situation repeats and the horizon restarts.
  const callsUntilRefill =
    growthPerCall > 0 ? estimatedReclaimTokens / growthPerCall : Number.POSITIVE_INFINITY;
  const effectiveHorizonCalls = Math.max(
    1,
    Math.min(
      expectedFutureCalls,
      belowSoftWindow ? defaults.softWindowBreakEvenCalls : expectedFutureCalls,
      callsUntilRefill,
    ),
  );

  // Cache reasons only make sense when the profile actually has cache evidence.
  const hasCacheEvidence = cacheEnabled && (cachedTokens > 0 || cacheSamples > 0);

  const metrics: FoldPointDecisionMetrics = {
    utilization,
    remainingTokens,
    estimatedPostCompactTokens,
    estimatedReclaimTokens,
    estimatedReclaimRatio,
    estimatedCacheSurvival: cacheSurvival,
    estimatedKeepCost,
    estimatedCompactCost,
    estimatedNetSaving,
    estimatedSavingPerFutureCall,
    breakEvenCalls,
    expectedFutureCalls,
    effectiveHorizonCalls,
    callsUntilRefill: Number.isFinite(callsUntilRefill) ? callsUntilRefill : null,
    callsSinceLastCompaction,
    compactionSamples: retentionSamples,
    adjustedNetSaving,
  };

  // --- 1. window safety always wins ---
  const forceByRatio = utilization >= defaults.hardWindowRatio;
  const forceByReserve = remainingTokens <= defaults.reserveTokens;
  if (forceByRatio || forceByReserve) {
    const reasons: FoldPointReason[] = [];
    if (forceByRatio) {
      reasons.push("HARD_WINDOW_RATIO");
    }
    if (forceByReserve) {
      reasons.push("RESERVE_TOKENS_REACHED");
    }
    if (input.compactionAllowed === false) {
      reasons.push("COMPACTION_DISABLED");
    }
    if (input.safeBoundary === false) {
      reasons.push("UNSAFE_BOUNDARY");
    }
    return { action: "FORCE", reasons, confidence, metrics };
  }

  // --- 2. host opt-out ---
  if (input.compactionAllowed === false) {
    return keepDecision(["COMPACTION_DISABLED"]);
  }

  // --- 3. step boundary ---
  if (input.safeBoundary === false) {
    return keepDecision(["UNSAFE_BOUNDARY"]);
  }

  // --- 4. cooldown ---
  if (compactionCount > 0 && callsSinceLastCompaction < defaults.minCallsBetweenCompactions) {
    return keepDecision(["COOLDOWN_ACTIVE"]);
  }

  // --- 5. minimum reclaim ---
  const reclaimTokensShort = estimatedReclaimTokens < defaults.minReclaimTokens;
  const reclaimRatioShort = estimatedReclaimRatio < defaults.minReclaimRatio;
  if (reclaimTokensShort || reclaimRatioShort) {
    const reasons: FoldPointReason[] = [];
    if (reclaimTokensShort) {
      reasons.push("INSUFFICIENT_RECLAIM_TOKENS");
    }
    if (reclaimRatioShort) {
      reasons.push("INSUFFICIENT_RECLAIM_RATIO");
    }
    return keepDecision(reasons);
  }

  // --- 6. economics ---
  if (
    adjustedNetSaving > defaults.minNetSaving &&
    breakEvenCalls !== null &&
    breakEvenCalls <= effectiveHorizonCalls
  ) {
    const reasons: FoldPointReason[] = ["ECONOMIC_TRIGGER", "BREAK_EVEN_WITHIN_HORIZON"];
    if (hasCacheEvidence && cacheSurvival < defaults.cacheValuableThreshold) {
      reasons.push("CACHE_LIKELY_EXPIRED");
    }
    return { action: "COMPACT", reasons, confidence, metrics };
  }

  // --- 7. KEEP, with the diagnosis that explains why ---
  const reasons: FoldPointReason[] = [];
  if (hasCacheEvidence) {
    reasons.push(
      cacheSurvival >= defaults.cacheValuableThreshold
        ? "CACHE_STILL_VALUABLE"
        : "CACHE_LIKELY_EXPIRED",
    );
  }
  if (breakEvenCalls === null) {
    reasons.push("NO_BREAK_EVEN");
  } else if (breakEvenCalls > effectiveHorizonCalls) {
    reasons.push("BREAK_EVEN_BEYOND_HORIZON");
  }
  if (adjustedNetSaving <= defaults.minNetSaving) {
    reasons.push("NO_POSITIVE_SAVING");
    if (confidence < defaults.lowConfidenceThreshold) {
      reasons.push("LOW_CONFIDENCE");
    }
  }
  if (reasons.length === 0) {
    reasons.push("DEFAULT_KEEP");
  }
  return keepDecision(reasons);

  function keepDecision(reasonList: FoldPointReason[]): FoldPointDecision {
    const perTokenReplayCost = safeDivide(currentReplayCost, contextTokens, 0);
    const perTokenLaterCost = safeDivide(laterPostCompactReplayCost, contextTokens, 0);
    const perTokenCompactExtraCost =
      (usesLearnedCost ? 0 : prices.inputPerToken + compactOutputRatio * prices.outputPerToken) +
      retentionRatio * prices.cacheWritePerToken +
      Math.max(effectiveHorizonCalls - 1, 0) * retentionRatio * perTokenLaterCost;
    const slope =
      (effectiveHorizonCalls * perTokenReplayCost - perTokenCompactExtraCost) * confidence -
      uncertaintyPenalty * perTokenCompactExtraCost;
    const fixedCompactCost = usesLearnedCost ? compactCallCost : 0;
    const economicBoundaryTokens =
      slope > 0
        ? (defaults.minNetSaving + uncertaintyPenalty * fixedCompactCost) / slope
        : Number.POSITIVE_INFINITY;

    return {
      action: "KEEP",
      reasons: reasonList,
      confidence,
      metrics,
      nextCheckAtTokens: computeNextCheckAtTokens({
        contextTokens,
        windowTokens,
        defaults,
        retentionRatio,
        economicBoundaryTokens,
      }),
    };
  }
}
