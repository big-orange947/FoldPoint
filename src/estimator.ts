import { estimateCacheModel, resolveCacheExpiresAt, resolveIdleMs } from "./cache";
import { isResolvedDefaults, NUMERIC_BOUNDS, resolveDefaults } from "./defaults";
import { clamp, computeConfidence, safeDivide } from "./math";
import { costOfCall, costOfUsage, resolveUnitPrices, type UnitPrices } from "./pricing";
import type {
  FoldPointDecision,
  FoldPointDecisionMetrics,
  FoldPointDecisionOptions,
  FoldPointDefaults,
  FoldPointInput,
  FoldPointProfileLearningState,
  FoldPointReason,
  FoldPointSessionState,
} from "./types";

/**
 * Break-even is unreachable but still representable when the division overflows.
 * Used only as a numeric guard so that metrics stay JSON-safe.
 */
const UNREACHABLE_BREAK_EVEN = Number.MAX_SAFE_INTEGER;

/** The five costs the break-even formula needs. */
export interface BreakEvenInput {
  /**
   * Cost of the call being decided about, **including any prefix it has to write now**
   * because the cache is not alive. A one-time cost, not the steady-state per-call cost.
   */
  currentCallReplayCost: number;
  /** Expected cost of a later call on the kept context (no one-time write). */
  laterCallReplayCost: number;
  /** Cost of the compaction call itself. */
  compactCallCost: number;
  /** Cost of the first replay after compaction (the prefix has to be rebuilt). */
  firstPostCompactReplayCost: number;
  /** Cost of each later replay after compaction. */
  laterPostCompactReplayCost: number;
}

/**
 * Break-even call count, solved exactly.
 *
 * Keeping costs `C_now + (N - 1) * C_later` for the next `N` calls. Compacting costs
 * `K + F + (N - 1) * L`. Setting them equal:
 *
 * ```
 * C_now + (N - 1) * C_later = K + F + (N - 1) * L
 * (N - 1) * (C_later - L) = K + F - C_now
 * N = 1 + (K + F - C_now) / (C_later - L)
 * ```
 *
 * `C_now` and `C_later` are separate because they can genuinely differ: a call that finds
 * the cache lapsed writes its whole prompt at the cache-write price, while the later calls
 * it enables do not have to. With `C_now == C_later == C` this reduces to the familiar
 * `(K + F - L) / (C - L)`.
 *
 * Returns:
 * - `0` when `K + F <= C_now`: compacting already repays itself on the current call alone,
 *   so no per-call saving is needed for it to be worth doing. Checked **before** the
 *   denominator, because "no recurring saving" must not hide "immediately cheaper";
 * - `null` when it is not immediately repaid and `C_later - L <= 0`: there is no positive
 *   per-call saving either, so compaction can never repay itself;
 * - `Number.MAX_SAFE_INTEGER` if the division overflows (effectively unreachable).
 */
export function computeBreakEvenCalls(input: BreakEvenInput): number | null {
  const numerator =
    input.compactCallCost + input.firstPostCompactReplayCost - input.currentCallReplayCost;
  if (numerator <= 0) {
    return 0;
  }

  const denominator = input.laterCallReplayCost - input.laterPostCompactReplayCost;
  if (!(denominator > 0)) {
    return null;
  }

  const ratio = 1 + numerator / denominator;
  return Number.isFinite(ratio) ? ratio : UNREACHABLE_BREAK_EVEN;
}

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
    throw new RangeError(`FoldPoint ${name} must be a non-empty string`);
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

  assertNonEmptyString("sessionId", input.sessionId);

  const profile = input.profile;
  if (profile === null || typeof profile !== "object") {
    throw new RangeError("FoldPoint input must carry a profile");
  }
  assertNonEmptyString("profile.model", profile.model);
  assertNonEmptyString("profile.compactorId", profile.compactorId);
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
    throw new RangeError('FoldPoint input "safeBoundary" must be a boolean');
  }
  if (input.compactionAllowed !== undefined && typeof input.compactionAllowed !== "boolean") {
    throw new RangeError('FoldPoint input "compactionAllowed" must be a boolean');
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
 * Pure decision function: same `input`, `learning`, `session` and `options` always produce
 * the same decision. It never mutates state, never performs I/O, never allocates unbounded
 * memory and runs in O(1) time and space.
 */
export function decideFoldPoint(
  input: FoldPointInput,
  learning: FoldPointProfileLearningState,
  session: FoldPointSessionState,
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
  const retentionSamples = readStateNumber(learning?.retentionSamples, 0);
  const cacheCoverageSamples = readStateNumber(learning?.cacheCoverageSamples, 0);
  const horizonSamples = readStateNumber(learning?.horizonSamples, 0);
  const compactUsageSamples = Math.max(
    readStateNumber(learning?.compactPromptSamples, 0),
    readStateNumber(learning?.compactOutputSamples, 0),
    readStateNumber(learning?.compactCachedInputSamples, 0),
    readStateNumber(learning?.compactCacheWriteSamples, 0),
    readStateNumber(learning?.compactCostScaleSamples, 0),
  );
  const compactionAttemptCount = readStateNumber(session?.compactionAttemptCount, 0);
  const callsSinceLastAttempt = readStateNumber(session?.callsSinceLastAttempt, 0);

  const retentionRatio = clamp(
    retentionSamples > 0
      ? readStateNumber(learning?.retentionRatioEma, defaults.retentionRatio)
      : defaults.retentionRatio,
    NUMERIC_BOUNDS.retentionRatioMin,
    NUMERIC_BOUNDS.retentionRatioMax,
  );
  const compactPromptRatio = clamp(
    compactUsageSamples > 0
      ? readStateNumber(learning?.compactPromptRatioEma, defaults.compactPromptRatio)
      : defaults.compactPromptRatio,
    0,
    NUMERIC_BOUNDS.compactPromptRatioMax,
  );
  const compactOutputRatio = clamp(
    compactUsageSamples > 0
      ? readStateNumber(learning?.compactOutputRatioEma, defaults.compactOutputRatio)
      : defaults.compactOutputRatio,
    0,
    NUMERIC_BOUNDS.compactOutputRatioMax,
  );
  const compactCachedInputRatio = clamp(
    compactUsageSamples > 0
      ? readStateNumber(learning?.compactCachedInputRatioEma, defaults.compactCachedInputRatio)
      : defaults.compactCachedInputRatio,
    0,
    1,
  );
  const compactCacheWriteRatio = clamp(
    compactUsageSamples > 0
      ? readStateNumber(learning?.compactCacheWriteRatioEma, defaults.compactCacheWriteRatio)
      : defaults.compactCacheWriteRatio,
    0,
    1,
  );
  const compactCostScale = clamp(
    readStateNumber(learning?.compactCostScaleEma, defaults.compactCostScale),
    NUMERIC_BOUNDS.compactCostScaleMin,
    NUMERIC_BOUNDS.compactCostScaleMax,
  );
  const reuseHorizonEma = readStateNumber(
    learning?.reuseHorizonEma,
    defaults.expectedFutureCalls,
    1,
  );

  const confidence = computeConfidence(
    {
      retentionSamples,
      compactionUsageSamples: compactUsageSamples,
      cacheCoverageSamples,
      horizonSamples,
    },
    defaults,
  );

  // --- cache: coverage and aliveness are separate, and meet exactly once ---
  const prices: UnitPrices = resolveUnitPrices(input.profile.pricing);
  const cacheEnabled = prices.hasCacheDiscount && input.profile.cachePolicy?.disabled !== true;
  const idleMs = resolveIdleMs(input, session ?? {});

  const cache = estimateCacheModel({
    timestamp: input.timestamp,
    idleMs,
    contextTokens,
    cachedTokens: input.cachedTokens,
    cachePolicy: input.profile.cachePolicy,
    cacheExpiresAt: resolveCacheExpiresAt(input, session ?? {}),
    cacheCoverageRatioEma: readStateNumber(learning?.cacheCoverageRatioEma, 0, 0, 1),
    cacheCoverageSamples,
    hasCacheDiscount: prices.hasCacheDiscount,
  });

  // --- reclaim ---
  const estimatedPostCompactTokens = contextTokens * retentionRatio;
  const estimatedReclaimTokens = contextTokens - estimatedPostCompactTokens;
  const estimatedReclaimRatio = safeDivide(estimatedReclaimTokens, contextTokens, 0);

  // --- replay costs: this call and the later calls are priced separately ---
  // This call: if the prefix is not alive, this request has to write it now. That is a fact
  // about this call, and it is billed at the cache-write price.
  const currentReplayCost = costOfCall(
    prices,
    contextTokens,
    {
      prefixTokens: cache.candidateCachedTokens,
      aliveProbability: cache.aliveProbability,
      cachingInPlay: cache.cachingInPlay,
    },
    0,
  );
  // Later calls: whether they also find the cache gone is a forecast, not this call's
  // verdict. `laterAliveProbability` deliberately does not inherit a lapsed TTL, and the
  // candidate is the prefix this call leaves behind — never this call's hit count of 0.
  const laterReplayCost = costOfCall(
    prices,
    contextTokens,
    {
      prefixTokens: cache.laterCandidateTokens,
      aliveProbability: cache.laterAliveProbability,
      cachingInPlay: cache.cachingInPlay,
    },
    0,
  );

  // The compacted context becomes a fresh prefix, so the same reuse fraction applies to it.
  const laterCoverageRatio = safeDivide(cache.laterCandidateTokens, contextTokens, 0);
  const laterPostCompactCandidateTokens = estimatedPostCompactTokens * laterCoverageRatio;
  const laterPostCompactReplayCost = costOfCall(
    prices,
    estimatedPostCompactTokens,
    {
      prefixTokens: laterPostCompactCandidateTokens,
      aliveProbability: cache.laterAliveProbability,
      cachingInPlay: cache.cachingInPlay,
    },
    0,
  );

  // The first replay after compaction writes the whole compacted context as the new prefix.
  const firstPostCompactReplayCost = cache.cachingInPlay
    ? estimatedPostCompactTokens * prices.cacheWritePerToken
    : estimatedPostCompactTokens * prices.inputPerToken;

  // --- compaction call cost: usage ratios scaled to the current context, priced now ---
  const estimatedCompactPromptTokens = contextTokens * compactPromptRatio;
  const estimatedCompactOutputTokens = contextTokens * compactOutputRatio;
  const estimatedCompactCachedTokens = estimatedCompactPromptTokens * compactCachedInputRatio;
  const estimatedCompactWriteTokens = estimatedCompactPromptTokens * compactCacheWriteRatio;
  const modeledCompactCallCost = costOfUsage(prices, {
    promptTokens: estimatedCompactPromptTokens,
    cachedInputTokens: estimatedCompactCachedTokens,
    cacheWriteTokens: estimatedCompactWriteTokens,
    outputTokens: estimatedCompactOutputTokens,
  });
  const compactCallCost = modeledCompactCallCost * compactCostScale;

  // --- horizon and totals ---
  const expectedFutureCalls = resolveExpectedFutureCalls(
    input,
    horizonSamples,
    reuseHorizonEma,
    defaults,
  );

  const estimatedKeepCost =
    currentReplayCost + Math.max(expectedFutureCalls - 1, 0) * laterReplayCost;
  const estimatedCompactCost =
    compactCallCost +
    firstPostCompactReplayCost +
    Math.max(expectedFutureCalls - 1, 0) * laterPostCompactReplayCost;
  const estimatedNetSaving = estimatedKeepCost - estimatedCompactCost;
  const estimatedSavingPerFutureCall = laterReplayCost - laterPostCompactReplayCost;

  const breakEvenCalls = computeBreakEvenCalls({
    currentCallReplayCost: currentReplayCost,
    laterCallReplayCost: laterReplayCost,
    compactCallCost,
    firstPostCompactReplayCost,
    laterPostCompactReplayCost,
  });

  const belowSoftWindow = utilization < defaults.softWindowRatio;
  const uncertaintyPenalty =
    defaults.uncertaintyPenalty * (belowSoftWindow ? defaults.softWindowPenaltyMultiplier : 1);
  const adjustedNetSaving = estimatedNetSaving * confidence - uncertaintyPenalty * compactCallCost;

  // The quick-payback policy guard: below the soft window the window is not scarce, so a
  // compaction must repay itself within a few calls. A policy, not a mathematical optimum.
  const effectiveHorizonCalls = belowSoftWindow
    ? Math.min(expectedFutureCalls, defaults.softWindowBreakEvenCalls)
    : expectedFutureCalls;

  // Cache reasons only make sense when the profile actually has a cache candidate.
  const hasCacheEvidence =
    cacheEnabled && (cache.candidateCachedTokens > 0 || cacheCoverageSamples > 0);

  const metrics: FoldPointDecisionMetrics = {
    utilization,
    remainingTokens,
    estimatedPostCompactTokens,
    estimatedReclaimTokens,
    estimatedReclaimRatio,
    estimatedCacheCoverageRatio: cache.coverageRatio,
    estimatedCacheAliveProbability: cache.aliveProbability,
    /** The forecast for later calls, which does not inherit this call's verdict. */
    estimatedCacheLaterAliveProbability: cache.laterAliveProbability,
    /** The prefix a later call could reuse, as distinct from this call's hit count. */
    estimatedCacheLaterCandidateTokens: cache.laterCandidateTokens,
    estimatedEffectiveCachedTokens: cache.effectiveCachedTokens,

    /** Cost of this call, including any prefix it has to write now. */
    estimatedCurrentCallReplayCost: currentReplayCost,
    /** Expected cost of a later call on the kept context. */
    estimatedLaterCallReplayCost: laterReplayCost,
    estimatedKeepCost,
    estimatedCompactCallCost: compactCallCost,
    estimatedCompactCost,
    estimatedNetSaving,
    adjustedNetSaving,
    estimatedSavingPerFutureCall,
    breakEvenCalls,
    expectedFutureCalls,
    effectiveHorizonCalls,
    callsSinceLastAttempt,
    retentionSamples,
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

  // --- 4. cooldown: any attempt, successful or not, restarts it ---
  if (compactionAttemptCount > 0 && callsSinceLastAttempt < defaults.minCallsBetweenCompactions) {
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
    if (hasCacheEvidence && cache.aliveProbability < defaults.cacheAliveThreshold) {
      reasons.push("CACHE_LIKELY_EXPIRED");
    }
    return { action: "COMPACT", reasons, confidence, metrics };
  }

  // --- 7. KEEP, with the diagnosis that explains why ---
  const reasons: FoldPointReason[] = [];
  if (hasCacheEvidence) {
    reasons.push(
      cache.aliveProbability >= defaults.cacheAliveThreshold
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
    const perTokenCompactCost = safeDivide(compactCallCost, contextTokens, 0);
    const perTokenCompactExtraCost =
      perTokenCompactCost +
      retentionRatio * prices.cacheWritePerToken +
      Math.max(effectiveHorizonCalls - 1, 0) * retentionRatio * perTokenLaterCost;
    const slope =
      (effectiveHorizonCalls * perTokenReplayCost - perTokenCompactExtraCost) * confidence -
      uncertaintyPenalty * perTokenCompactCost;
    const economicBoundaryTokens =
      slope > 0 ? defaults.minNetSaving / slope : Number.POSITIVE_INFINITY;

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
