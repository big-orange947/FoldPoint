import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeBreakEvenCalls,
  costOfCall,
  costOfUsage,
  createProfileLearningState,
  createSessionState,
  DEFAULTS,
  decideFoldPoint,
  estimateCacheModel,
  FoldPoint,
  type FoldPointInput,
  type FoldPointProfile,
  isCachingInPlay,
  percentile,
  resolveDefaults,
  resolveUnitPrices,
  type UnitPrices,
} from "../src/index";
import {
  type CompactionEvent,
  createBaselineFactories,
  type DecisionRequest,
  type RequestEvent,
  type Strategy,
  type StrategyFactory,
} from "./fixed-threshold";
import {
  buildGrowthSequence,
  createFailureRng,
  fingerprintSequence,
  idleAtStep,
  SCENARIOS,
  type Scenario,
} from "./scenarios";

const BASE_TIMESTAMP = 1_700_000_000_000;
const REPORT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "reports",
  "benchmark-report.json",
);

/** The state a branch needs to price its own next call. */
interface BranchState {
  contextTokens: number;
  lastPromptTokens: number;
  lastCallAt?: number;
  cacheHeld: boolean;
  rebuildingCache: boolean;
}

/**
 * The counterfactual branch: "what would this session have cost if this compaction had not
 * happened?" It carries its own context, its own cache history and its own cost total.
 */
interface ShadowBranch extends BranchState {
  /** Model call costs plus any counterfactual emergency recovery cost. */
  cumulativeCost: number;
  /** True when this branch would have run into the window during the interval. */
  overflowed: boolean;
}

/** A successful compaction whose payback is still being measured. */
interface OpenCompaction {
  step: number;
  action: "COMPACT" | "FORCE";
  forced: boolean;
  beforeTokens: number;
  afterTokens: number;
  attemptCost: number;
  cachedTokensAtCompaction: number;
  staticBreakEvenCalls: number | null;
  /** The exact inputs handed to `computeBreakEvenCalls`, for auditing. */
  staticBreakEvenInputs: {
    currentCallReplayCost: number;
    laterCallReplayCost: number;
    compactCallCost: number;
    firstPostCompactReplayCost: number;
    laterPostCompactReplayCost: number;
  } | null;
  /** Null for forced compactions: they are not judged economically. */
  shadow: ShadowBranch | null;
  /** Model call costs the actual branch paid during this interval. */
  actualCallCost: number;
}

/** One compaction attempt, with the outcome of its counterfactual settlement. */
export interface CompactionRecord {
  step: number;
  action: "COMPACT" | "FORCE";
  success: boolean;
  forced: boolean;
  beforeTokens: number;
  afterTokens: number;
  attemptCost: number;
  /** Counterfactual cost minus actual call cost minus the attempt cost; null when not judged. */
  realizedSaving: number | null;
  /** Null when the compaction is not judged (forced, failed, or still open at session end). */
  unnecessary: boolean | null;
  /** True when the counterfactual branch would have overflowed during the interval. */
  shadowOverflowed: boolean;
  /** Local, static break-even from `computeBreakEvenCalls`; not a dynamic payback measure. */
  staticBreakEvenCalls: number | null;
  /** The exact inputs handed to `computeBreakEvenCalls`, for auditing the metric. */
  staticBreakEvenInputs: {
    currentCallReplayCost: number;
    laterCallReplayCost: number;
    compactCallCost: number;
    firstPostCompactReplayCost: number;
    laterPostCompactReplayCost: number;
  } | null;
}

export interface SessionMetrics {
  scenarioId: string;
  scenarioName: string;
  strategyId: string;
  totalSimulatedCost: number;
  totalPromptTokens: number;
  totalCachedTokens: number;
  totalOutputTokens: number;
  /** Sum of every growth value the scenario offered. Strategy-independent by construction. */
  totalOfferedGrowthTokens: number;
  /** FNV-1a fingerprint of the offered growth sequence. Strategy-independent. */
  growthSequenceFingerprint: string;
  compactionAttemptCount: number;
  successfulCompactionCount: number;
  failedCompactionCount: number;
  economicAttemptCount: number;
  forcedAttemptCount: number;
  forceDecisionCount: number;
  overflowCount: number;
  overflowRecoveryCount: number;
  minRemainingHeadroom: number;
  averageUtilizationAtCompaction: number | null;
  /** Successful, non-forced compactions whose counterfactual payback was measured. */
  judgedCompactionCount: number;
  unnecessaryCompactionCount: number;
  /** Local static break-even at compaction, from the core `computeBreakEvenCalls`. */
  meanStaticBreakEvenCallsAtCompaction: number | null;
  /** FoldPoint's own estimate at the same moment, for comparison. */
  meanFoldPointEstimatedBreakEvenCallsAtCompaction: number | null;
  decisionLatencyP50Ms: number;
  decisionLatencyP95Ms: number;
  decisionLatencyP99Ms: number;
}

export interface SessionRun {
  metrics: SessionMetrics;
  latencies: number[];
  compactions: CompactionRecord[];
}

/**
 * FoldPoint wired the way a host would wire it: one session per scenario run, every real
 * call observed, every compaction attempt recorded (successful or not), and the session
 * ended at the end so the reuse horizon can be learned.
 */
export function createFoldPointStrategy(scenario: Scenario): Strategy {
  const foldPoint = new FoldPoint();
  const sessionId = `bench-${scenario.id}`;
  const profile: FoldPointProfile = {
    provider: "benchmark",
    model: "benchmark-model",
    contextWindowTokens: scenario.contextWindowTokens,
    compactorId: "benchmark-compactor",
    pricing: scenario.pricing,
    cachePolicy: scenario.cachePolicy,
  };

  return {
    id: "foldpoint",
    label: "FoldPoint",
    decide(request: DecisionRequest) {
      const input: FoldPointInput = {
        sessionId,
        profile,
        timestamp: request.timestamp,
        contextTokens: request.contextTokens,
        cachedTokens: request.cachedTokens,
        idleMs: request.idleMs,
        safeBoundary: true,
        compactionAllowed: true,
      };
      if (scenario.hostHorizon !== undefined) {
        // A host that declares a remaining budget never claims more future calls than the
        // session can still have, so the estimate shrinks as the session proceeds.
        input.expectedFutureCalls = Math.max(
          1,
          Math.min(scenario.hostHorizon, scenario.steps - request.step),
        );
      }

      const decision = foldPoint.decide(input);
      return {
        action: decision.action,
        reasons: decision.reasons,
        estimatedBreakEvenCalls: decision.metrics.breakEvenCalls,
      };
    },
    onCompaction(event: CompactionEvent) {
      foldPoint.recordCompaction(sessionId, profile, {
        timestamp: event.timestamp,
        beforeTokens: event.beforeTokens,
        afterTokens: event.afterTokens,
        promptTokens: event.beforeTokens,
        outputTokens: event.outputTokens,
        success: event.success,
      });
    },
    onRequest(event: RequestEvent) {
      foldPoint.observeRequest(sessionId, profile, {
        timestamp: event.timestamp,
        promptTokens: event.promptTokens,
        cachedInputTokens: event.cachedInputTokens,
        outputTokens: event.outputTokens,
      });
    },
    onSessionEnd(timestamp: number) {
      foldPoint.endSession(sessionId, profile, { timestamp });
    },
  };
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function safePercentile(values: readonly number[], p: number): number {
  return values.length === 0 ? 0 : percentile(values, p);
}

/** Cache state of one branch, from that branch's own history. */
function branchCache(
  branch: BranchState,
  timestamp: number,
  ttlMs: number,
): { cachedTokens: number; rebuildsCache: boolean } {
  const cacheAlive =
    branch.cacheHeld && branch.lastCallAt !== undefined && timestamp - branch.lastCallAt < ttlMs;
  return {
    cachedTokens: cacheAlive ? Math.min(branch.lastPromptTokens, branch.contextTokens) : 0,
    rebuildsCache: branch.rebuildingCache || !cacheAlive,
  };
}

/**
 * Cost of one model call, through the same helper the engine uses.
 *
 * A call that has to (re)build a cache prefix writes its whole prompt at the cache-write
 * price; a call whose prefix is alive pays the cache-read price for the prefix and the plain
 * input price for the appended tail. `cachingInPlay` is false for a profile without a cache
 * discount, where the prompt is plain input.
 */
function branchCallCost(
  prices: UnitPrices,
  chargedPrompt: number,
  cachedTokens: number,
  rebuildsCache: boolean,
  outputTokens: number,
  cachingInPlay: boolean,
): number {
  return costOfCall(
    prices,
    chargedPrompt,
    {
      prefixTokens: cachedTokens,
      aliveProbability: rebuildsCache ? 0 : 1,
      cachingInPlay,
    },
    outputTokens,
  );
}

function afterCall(branch: BranchState, chargedPrompt: number, timestamp: number): void {
  branch.lastPromptTokens = chargedPrompt;
  branch.lastCallAt = timestamp;
  branch.cacheHeld = true;
  branch.rebuildingCache = false;
}

/**
 * Runs one simulated session.
 *
 * The model is identical for every strategy:
 * - new tokens are appended at the start of each step, from the scenario's growth sequence;
 * - the provider caches the whole prompt of a successful call, until the TTL lapses or a
 *   successful compaction rebuilds the prefix;
 * - rebuilding a prefix is billed at the cache-write price;
 * - a compaction attempt fails with probability `1 - successRate`: it is billed, it does not
 *   change the context, it does not build a cache and it creates no counterfactual branch;
 * - an overflow is a call whose prompt exceeds the window: it is counted, and the host then
 *   has to compact at the worst possible moment and pays for that recovery.
 *
 * Every successful, non-forced compaction also opens a **shadow branch**: an independent
 * counterfactual that keeps the pre-compaction context and the pre-compaction cache history,
 * receives exactly the same growth, and prices its own calls. When the next successful
 * compaction or the end of the session settles the interval, the realized saving is
 * `shadowCost - actualCallCost - attemptCost`. If the shadow branch would have overflowed,
 * the compaction is never counted as unnecessary (the rule is documented in
 * `benchmarks/README.md`).
 */
export function runSession(scenario: Scenario, strategy: Strategy): SessionRun {
  const growthSequence = buildGrowthSequence(scenario);
  const failureRandom = createFailureRng(scenario.seed);
  const prices: UnitPrices = resolveUnitPrices(scenario.pricing);
  const ttlMs = scenario.cachePolicy.ttlMs ?? Number.POSITIVE_INFINITY;
  const windowTokens = scenario.contextWindowTokens;
  // The provider caches the whole prompt of a successful call, so a prefix always exists
  // once a call has happened; the scenario's policy decides whether caching is in play.
  const cachingInPlay = isCachingInPlay(
    { cachePolicy: scenario.cachePolicy, hasCacheDiscount: prices.hasCacheDiscount },
    false,
  );

  const actual: BranchState = {
    contextTokens: scenario.startTokens,
    lastPromptTokens: 0,
    cacheHeld: false,
    rebuildingCache: true,
  };
  let open: OpenCompaction | null = null;
  let timestamp = BASE_TIMESTAMP;

  const latencies: number[] = [];
  const staticBreakEvens: number[] = [];
  const estimatedBreakEvens: number[] = [];
  const compactions: CompactionRecord[] = [];
  let totalSimulatedCost = 0;
  let totalPromptTokens = 0;
  let totalCachedTokens = 0;
  let totalOutputTokens = 0;
  let totalOfferedGrowthTokens = 0;
  let compactionAttemptCount = 0;
  let successfulCompactionCount = 0;
  let failedCompactionCount = 0;
  let economicAttemptCount = 0;
  let forcedAttemptCount = 0;
  let forceDecisionCount = 0;
  let overflowCount = 0;
  let overflowRecoveryCount = 0;
  let judgedCompactionCount = 0;
  let unnecessaryCompactionCount = 0;
  let minRemainingHeadroom = Number.POSITIVE_INFINITY;
  let utilizationAtCompactionSum = 0;
  // The hit rate this host has observed, mirroring the learner's cache-coverage EMA so the
  // static metric is fed the same input the engine would have learned.
  let coverageEma = 0;
  let coverageSamples = 0;

  /** Charges one overflow recovery to a branch, at the cache-write price. */
  const chargeRecovery = (branch: BranchState, cost: { value: number }): void => {
    const recoveryOutputTokens = Math.round(branch.contextTokens * scenario.compactor.outputRatio);
    cost.value += costOfCall(
      prices,
      branch.contextTokens,
      { prefixTokens: branch.contextTokens, aliveProbability: 0, cachingInPlay },
      recoveryOutputTokens,
    );
    branch.contextTokens = Math.round(branch.contextTokens * scenario.compactor.retentionRatio);
    branch.lastPromptTokens = 0;
    branch.cacheHeld = false;
    branch.rebuildingCache = true;
  };

  const settle = (): void => {
    if (!open) {
      return;
    }
    const shadow = open.shadow;
    let realizedSaving: number | null = null;
    let unnecessary: boolean | null = null;

    if (shadow) {
      realizedSaving = shadow.cumulativeCost - open.actualCallCost - open.attemptCost;
      unnecessary = !open.forced && !shadow.overflowed && realizedSaving < 0;
      judgedCompactionCount += 1;
      if (unnecessary) {
        unnecessaryCompactionCount += 1;
      }
    }

    compactions.push({
      step: open.step,
      action: open.action,
      success: true,
      forced: open.forced,
      beforeTokens: open.beforeTokens,
      afterTokens: open.afterTokens,
      attemptCost: open.attemptCost,
      realizedSaving,
      unnecessary,
      shadowOverflowed: shadow?.overflowed ?? false,
      staticBreakEvenCalls: open.staticBreakEvenCalls,
      staticBreakEvenInputs: open.staticBreakEvenInputs,
    });
    open = null;
  };

  for (let step = 0; step < scenario.steps; step += 1) {
    const stepIdleMs = idleAtStep(scenario, step);
    timestamp += stepIdleMs;

    const growth = growthSequence[step] ?? 0;
    totalOfferedGrowthTokens += growth;
    actual.contextTokens += growth;
    if (open?.shadow) {
      open.shadow.contextTokens += growth;
    }

    const actualCache = branchCache(actual, timestamp, ttlMs);
    const utilization = actual.contextTokens / windowTokens;

    const request: DecisionRequest = {
      step,
      timestamp,
      idleMs: stepIdleMs,
      contextTokens: actual.contextTokens,
      cachedTokens: actualCache.cachedTokens,
      utilization,
    };

    const started = performance.now();
    const decision = strategy.decide(request);
    latencies.push(performance.now() - started);

    if (decision.action === "FORCE") {
      forceDecisionCount += 1;
    }

    let callRebuildsCache = actualCache.rebuildsCache;
    let callCachedTokens = actualCache.cachedTokens;

    if (decision.action !== "KEEP") {
      const beforeTokens = actual.contextTokens;
      const compactionOutputTokens = Math.round(beforeTokens * scenario.compactor.outputRatio);
      const afterTokens = Math.round(beforeTokens * scenario.compactor.retentionRatio);
      const success = failureRandom() < scenario.compactor.successRate;
      const attemptCost = costOfUsage(prices, {
        promptTokens: beforeTokens,
        outputTokens: compactionOutputTokens,
      });

      totalSimulatedCost += attemptCost;
      compactionAttemptCount += 1;
      utilizationAtCompactionSum += utilization;
      if (decision.action === "COMPACT") {
        economicAttemptCount += 1;
      } else {
        forcedAttemptCount += 1;
      }

      // Static break-even at this moment, from the core solver and the same billing rule,
      // evaluated on the inputs the host reports. Output tokens are excluded: they are
      // identical on both sides and cancel.
      //
      // `currentCallReplayCost` is this call as it really is: when the prefix is not alive,
      // the whole prompt is written at the cache-write price. `laterCallReplayCost` is a
      // forecast for the calls after this one, so it does not inherit this call's verdict —
      // the same cache model the engine uses, fed with the hit rate this host has observed.
      const cacheModel = estimateCacheModel({
        timestamp,
        idleMs: stepIdleMs,
        contextTokens: beforeTokens,
        cachedTokens: actualCache.cachedTokens,
        cachePolicy: scenario.cachePolicy,
        cacheCoverageRatioEma: coverageEma,
        cacheCoverageSamples: coverageSamples,
        hasCacheDiscount: prices.hasCacheDiscount,
      });
      const currentCallReplayCost = costOfCall(
        prices,
        beforeTokens,
        {
          prefixTokens: cacheModel.candidateCachedTokens,
          aliveProbability: cacheModel.aliveProbability,
          cachingInPlay: cacheModel.cachingInPlay,
        },
        0,
      );
      const laterCallReplayCost = costOfCall(
        prices,
        beforeTokens,
        {
          prefixTokens: cacheModel.laterCandidateTokens,
          aliveProbability: cacheModel.laterAliveProbability,
          cachingInPlay: cacheModel.cachingInPlay,
        },
        0,
      );
      const firstPostCompactReplayCost = costOfCall(
        prices,
        afterTokens,
        { prefixTokens: afterTokens, aliveProbability: 0, cachingInPlay: cacheModel.cachingInPlay },
        0,
      );
      const laterPostCompactReplayCost = costOfCall(
        prices,
        afterTokens,
        {
          prefixTokens:
            afterTokens * (beforeTokens > 0 ? cacheModel.laterCandidateTokens / beforeTokens : 0),
          aliveProbability: cacheModel.laterAliveProbability,
          cachingInPlay: cacheModel.cachingInPlay,
        },
        0,
      );
      const staticBreakEvenCalls = computeBreakEvenCalls({
        currentCallReplayCost,
        laterCallReplayCost,
        compactCallCost: attemptCost,
        firstPostCompactReplayCost,
        laterPostCompactReplayCost,
      });
      const staticBreakEvenInputs = {
        currentCallReplayCost,
        laterCallReplayCost,
        compactCallCost: attemptCost,
        firstPostCompactReplayCost,
        laterPostCompactReplayCost,
      };

      strategy.onCompaction?.({
        step,
        timestamp,
        beforeTokens,
        afterTokens,
        outputTokens: compactionOutputTokens,
        action: decision.action,
        cost: attemptCost,
        breakEvenCalls: staticBreakEvenCalls,
        success,
      });

      if (!success) {
        failedCompactionCount += 1;
        compactions.push({
          step,
          action: decision.action,
          success: false,
          forced: decision.action === "FORCE",
          beforeTokens,
          afterTokens,
          attemptCost,
          realizedSaving: null,
          unnecessary: null,
          shadowOverflowed: false,
          staticBreakEvenCalls: null,
          staticBreakEvenInputs: null,
        });
        // The context, the cache and any open interval are untouched.
      } else {
        // A successful compaction supersedes whatever interval was still open.
        settle();

        successfulCompactionCount += 1;
        if (staticBreakEvenCalls !== null) {
          staticBreakEvens.push(staticBreakEvenCalls);
        }
        if (typeof decision.estimatedBreakEvenCalls === "number") {
          estimatedBreakEvens.push(decision.estimatedBreakEvenCalls);
        }

        const forced = decision.action === "FORCE";
        const preCompactionState: BranchState = {
          contextTokens: beforeTokens,
          lastPromptTokens: actual.lastPromptTokens,
          ...(actual.lastCallAt !== undefined ? { lastCallAt: actual.lastCallAt } : {}),
          cacheHeld: actual.cacheHeld,
          rebuildingCache: false,
        };

        actual.contextTokens = afterTokens;
        actual.lastPromptTokens = 0;
        actual.cacheHeld = false;
        actual.rebuildingCache = true;
        callCachedTokens = 0;
        callRebuildsCache = true;

        open = {
          step,
          action: decision.action,
          forced,
          beforeTokens,
          afterTokens,
          attemptCost,
          cachedTokensAtCompaction: actualCache.cachedTokens,
          staticBreakEvenCalls,
          staticBreakEvenInputs,
          shadow: forced ? null : { ...preCompactionState, cumulativeCost: 0, overflowed: false },
          actualCallCost: 0,
        };
      }
    }

    // --- the actual branch's model call ---
    const rawContextTokens = actual.contextTokens;
    if (rawContextTokens > windowTokens) {
      overflowCount += 1;
      const recovery = { value: 0 };
      chargeRecovery(actual, recovery);
      totalSimulatedCost += recovery.value;
      overflowRecoveryCount += 1;
      callCachedTokens = 0;
      callRebuildsCache = true;
    }

    minRemainingHeadroom = Math.min(minRemainingHeadroom, windowTokens - rawContextTokens);

    const chargedPrompt = actual.contextTokens;
    const actualCallCost = branchCallCost(
      prices,
      chargedPrompt,
      callCachedTokens,
      callRebuildsCache,
      scenario.outputTokens,
      cachingInPlay,
    );

    totalSimulatedCost += actualCallCost;
    totalPromptTokens += chargedPrompt;
    totalCachedTokens += callRebuildsCache ? 0 : callCachedTokens;
    totalOutputTokens += scenario.outputTokens;
    if (open) {
      open.actualCallCost += actualCallCost;
    }

    strategy.onRequest?.({
      step,
      timestamp,
      promptTokens: chargedPrompt,
      cachedInputTokens: callRebuildsCache ? 0 : callCachedTokens,
      outputTokens: scenario.outputTokens,
      cost: actualCallCost,
    });

    // The host's own view of its hit rate, updated exactly like the learner's coverage EMA.
    if (chargedPrompt > 0) {
      const observedCoverageRatio = (callRebuildsCache ? 0 : callCachedTokens) / chargedPrompt;
      coverageEma =
        coverageSamples === 0
          ? observedCoverageRatio
          : DEFAULTS.emaAlpha * observedCoverageRatio + (1 - DEFAULTS.emaAlpha) * coverageEma;
      coverageSamples += 1;
    }

    afterCall(actual, chargedPrompt, timestamp);

    // --- the shadow branch's model call, on its own context and its own cache ---
    if (open?.shadow) {
      const shadow = open.shadow;
      if (shadow.contextTokens > windowTokens) {
        shadow.overflowed = true;
        const recovery = { value: 0 };
        chargeRecovery(shadow, recovery);
        shadow.cumulativeCost += recovery.value;
      }

      const shadowCache = branchCache(shadow, timestamp, ttlMs);
      const shadowPrompt = shadow.contextTokens;
      shadow.cumulativeCost += branchCallCost(
        prices,
        shadowPrompt,
        shadowCache.cachedTokens,
        shadowCache.rebuildsCache,
        scenario.outputTokens,
        cachingInPlay,
      );
      afterCall(shadow, shadowPrompt, timestamp);
    }
  }

  settle();
  strategy.onSessionEnd?.(timestamp);

  return {
    metrics: {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      strategyId: strategy.id,
      totalSimulatedCost,
      totalPromptTokens,
      totalCachedTokens,
      totalOutputTokens,
      totalOfferedGrowthTokens,
      growthSequenceFingerprint: fingerprintSequence(growthSequence),
      compactionAttemptCount,
      successfulCompactionCount,
      failedCompactionCount,
      economicAttemptCount,
      forcedAttemptCount,
      forceDecisionCount,
      overflowCount,
      overflowRecoveryCount,
      minRemainingHeadroom: Number.isFinite(minRemainingHeadroom) ? minRemainingHeadroom : 0,
      averageUtilizationAtCompaction:
        compactionAttemptCount > 0 ? utilizationAtCompactionSum / compactionAttemptCount : null,
      judgedCompactionCount,
      unnecessaryCompactionCount,
      meanStaticBreakEvenCallsAtCompaction: mean(staticBreakEvens),
      meanFoldPointEstimatedBreakEvenCallsAtCompaction: mean(estimatedBreakEvens),
      decisionLatencyP50Ms: safePercentile(latencies, 0.5),
      decisionLatencyP95Ms: safePercentile(latencies, 0.95),
      decisionLatencyP99Ms: safePercentile(latencies, 0.99),
    },
    latencies,
    compactions,
  };
}

export interface AggregateMetrics {
  strategyId: string;
  strategyLabel: string;
  scenarioCount: number;
  totalSimulatedCost: number;
  totalPromptTokens: number;
  totalCachedTokens: number;
  totalOutputTokens: number;
  compactionAttemptCount: number;
  successfulCompactionCount: number;
  failedCompactionCount: number;
  economicAttemptCount: number;
  forcedAttemptCount: number;
  forceDecisionCount: number;
  overflowCount: number;
  overflowRecoveryCount: number;
  minRemainingHeadroom: number;
  averageUtilizationAtCompaction: number | null;
  judgedCompactionCount: number;
  unnecessaryCompactionCount: number;
  meanStaticBreakEvenCallsAtCompaction: number | null;
  meanFoldPointEstimatedBreakEvenCallsAtCompaction: number | null;
  decisionLatencyP50Ms: number;
  decisionLatencyP95Ms: number;
  decisionLatencyP99Ms: number;
}

function aggregateStrategy(
  strategy: { id: string; label: string },
  runs: SessionRun[],
): AggregateMetrics {
  const latencies = runs.flatMap((run) => run.latencies);
  const rows = runs.map((run) => run.metrics);
  const sum = (pick: (metrics: SessionMetrics) => number): number =>
    rows.reduce((total, metrics) => total + pick(metrics), 0);
  const meanOf = (pick: (metrics: SessionMetrics) => number | null): number | null =>
    mean(rows.map(pick).filter((value): value is number => value !== null));

  const attempts = sum((metrics) => metrics.compactionAttemptCount);
  const weightedUtilization =
    attempts > 0
      ? rows.reduce(
          (total, metrics) =>
            total + (metrics.averageUtilizationAtCompaction ?? 0) * metrics.compactionAttemptCount,
          0,
        ) / attempts
      : null;

  return {
    strategyId: strategy.id,
    strategyLabel: strategy.label,
    scenarioCount: rows.length,
    totalSimulatedCost: sum((metrics) => metrics.totalSimulatedCost),
    totalPromptTokens: sum((metrics) => metrics.totalPromptTokens),
    totalCachedTokens: sum((metrics) => metrics.totalCachedTokens),
    totalOutputTokens: sum((metrics) => metrics.totalOutputTokens),
    compactionAttemptCount: attempts,
    successfulCompactionCount: sum((metrics) => metrics.successfulCompactionCount),
    failedCompactionCount: sum((metrics) => metrics.failedCompactionCount),
    economicAttemptCount: sum((metrics) => metrics.economicAttemptCount),
    forcedAttemptCount: sum((metrics) => metrics.forcedAttemptCount),
    forceDecisionCount: sum((metrics) => metrics.forceDecisionCount),
    overflowCount: sum((metrics) => metrics.overflowCount),
    overflowRecoveryCount: sum((metrics) => metrics.overflowRecoveryCount),
    minRemainingHeadroom: Math.min(...rows.map((metrics) => metrics.minRemainingHeadroom)),
    averageUtilizationAtCompaction: weightedUtilization,
    judgedCompactionCount: sum((metrics) => metrics.judgedCompactionCount),
    unnecessaryCompactionCount: sum((metrics) => metrics.unnecessaryCompactionCount),
    meanStaticBreakEvenCallsAtCompaction: meanOf(
      (metrics) => metrics.meanStaticBreakEvenCallsAtCompaction,
    ),
    meanFoldPointEstimatedBreakEvenCallsAtCompaction: meanOf(
      (metrics) => metrics.meanFoldPointEstimatedBreakEvenCallsAtCompaction,
    ),
    decisionLatencyP50Ms: safePercentile(latencies, 0.5),
    decisionLatencyP95Ms: safePercentile(latencies, 0.95),
    decisionLatencyP99Ms: safePercentile(latencies, 0.99),
  };
}

const MICRO_BENCHMARK_ITERATIONS = 100_000;

export interface MicroBenchmarkResult {
  iterations: number;
  totalMs: number;
  nanosecondsPerDecision: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

/** 100,000 pure decisions on a fixed input and state. Reported, never used as a gate. */
export function runMicroBenchmark(iterations = MICRO_BENCHMARK_ITERATIONS): MicroBenchmarkResult {
  const defaults = resolveDefaults();
  const learning = {
    ...createProfileLearningState(defaults),
    successfulCompactionCount: 2,
    retentionSamples: 4,
    retentionRatioEma: 0.3,
    compactPromptSamples: 3,
    compactOutputSamples: 3,
    compactOutputRatioEma: 0.1,
    cacheCoverageSamples: 5,
    cacheCoverageRatioEma: 0.8,
    horizonSamples: 3,
    reuseHorizonEma: 6,
  };
  const session = {
    ...createSessionState(),
    requestCount: 10,
    compactionAttemptCount: 1,
    successfulCompactionCount: 1,
    callsSinceLastAttempt: 6,
  };
  const input: FoldPointInput = {
    sessionId: "micro-benchmark",
    profile: {
      provider: "benchmark",
      model: "benchmark-model",
      contextWindowTokens: 200_000,
      compactorId: "benchmark-compactor",
      pricing: {
        currency: "USD",
        inputPerMillion: 3,
        outputPerMillion: 15,
        cacheReadPerMillion: 0.3,
      },
      cachePolicy: { ttlMs: 120_000 },
    },
    timestamp: BASE_TIMESTAMP,
    contextTokens: 120_000,
    cachedTokens: 100_000,
    idleMs: 5_000,
    safeBoundary: true,
    compactionAllowed: true,
    expectedFutureCalls: 8,
  };

  for (let index = 0; index < 1_000; index += 1) {
    decideFoldPoint(input, learning, session);
  }

  const samples = new Float64Array(iterations);
  const startedAll = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    decideFoldPoint(input, learning, session);
    samples[index] = performance.now() - started;
  }
  const totalMs = performance.now() - startedAll;
  const values = Array.from(samples);

  return {
    iterations,
    totalMs,
    nanosecondsPerDecision: (totalMs * 1_000_000) / iterations,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
  };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

function fixed(value: number | null, digits = 4): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

function aggregateTable(rows: AggregateMetrics[]): string {
  const header = [
    pad("strategy", 20),
    padLeft("cost", 11),
    padLeft("attempts", 9),
    padLeft("ok", 5),
    padLeft("failed", 7),
    padLeft("econ", 5),
    padLeft("forced", 7),
    padLeft("judged", 7),
    padLeft("unneed", 7),
    padLeft("over", 5),
    padLeft("staticBE", 9),
    padLeft("p50 ms", 9),
    padLeft("p99 ms", 9),
  ].join(" ");

  const lines = [header, "-".repeat(header.length)];
  for (const row of rows) {
    lines.push(
      [
        pad(row.strategyLabel, 20),
        padLeft(row.totalSimulatedCost.toFixed(3), 11),
        padLeft(String(row.compactionAttemptCount), 9),
        padLeft(String(row.successfulCompactionCount), 5),
        padLeft(String(row.failedCompactionCount), 7),
        padLeft(String(row.economicAttemptCount), 5),
        padLeft(String(row.forcedAttemptCount), 7),
        padLeft(String(row.judgedCompactionCount), 7),
        padLeft(String(row.unnecessaryCompactionCount), 7),
        padLeft(String(row.overflowCount), 5),
        padLeft(fixed(row.meanStaticBreakEvenCallsAtCompaction, 2), 9),
        padLeft(fixed(row.decisionLatencyP50Ms, 5), 9),
        padLeft(fixed(row.decisionLatencyP99Ms, 5), 9),
      ].join(" "),
    );
  }
  return lines.join("\n");
}

function perScenarioTable(rows: SessionMetrics[]): string {
  const header = [
    pad("scenario", 22),
    pad("strategy", 20),
    padLeft("cost", 10),
    padLeft("att", 5),
    padLeft("ok", 4),
    padLeft("fail", 5),
    padLeft("judged", 7),
    padLeft("unneed", 7),
    padLeft("over", 5),
    padLeft("avgUtil", 8),
  ].join(" ");

  const lines = [header, "-".repeat(header.length)];
  for (const row of rows) {
    lines.push(
      [
        pad(`${row.scenarioId} ${row.scenarioName}`, 22),
        pad(row.strategyId, 20),
        padLeft(row.totalSimulatedCost.toFixed(3), 10),
        padLeft(String(row.compactionAttemptCount), 5),
        padLeft(String(row.successfulCompactionCount), 4),
        padLeft(String(row.failedCompactionCount), 5),
        padLeft(String(row.judgedCompactionCount), 7),
        padLeft(String(row.unnecessaryCompactionCount), 7),
        padLeft(String(row.overflowCount), 5),
        padLeft(fixed(row.averageUtilizationAtCompaction, 3), 8),
      ].join(" "),
    );
  }
  return lines.join("\n");
}

function main(): void {
  const factories: StrategyFactory[] = [...createBaselineFactories(), createFoldPointStrategy];
  const perScenario: SessionMetrics[] = [];
  const aggregate: AggregateMetrics[] = [];
  const strategyLabels = new Map<string, string>();

  for (const factory of factories) {
    const runs: SessionRun[] = [];
    let strategyId = "";
    let strategyLabel = "";

    for (const scenario of SCENARIOS) {
      const strategy = factory(scenario);
      strategyId = strategy.id;
      strategyLabel = strategy.label;
      strategyLabels.set(strategy.id, strategy.label);
      const run = runSession(scenario, strategy);
      runs.push(run);
      perScenario.push(run.metrics);
    }

    aggregate.push(aggregateStrategy({ id: strategyId, label: strategyLabel }, runs));
  }

  const micro = runMicroBenchmark();

  const report = {
    generatedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform },
    hardWindowRatioUsedForForcedDefinition: DEFAULTS.hardWindowRatio,
    counterfactual:
      "Each successful, non-forced compaction opens an independent shadow branch that keeps the pre-compaction context and cache history, receives the same growth and prices its own calls. A compaction is unnecessary when the shadow cost minus the actual call cost minus the attempt cost is negative, unless the shadow branch would have overflowed.",
    seeds: Object.fromEntries(SCENARIOS.map((scenario) => [scenario.id, scenario.seed])),
    growth: Object.fromEntries(
      SCENARIOS.map((scenario) => {
        const sequence = buildGrowthSequence(scenario);
        return [
          scenario.id,
          {
            fingerprint: fingerprintSequence(sequence),
            totalOfferedGrowthTokens: sequence.reduce((total, value) => total + value, 0),
          },
        ];
      }),
    ),
    strategies: [...strategyLabels.entries()].map(([id, label]) => ({ id, label })),
    scenarios: SCENARIOS.map((scenario) => ({
      id: scenario.id,
      name: scenario.name,
      title: scenario.title,
      steps: scenario.steps,
      contextWindowTokens: scenario.contextWindowTokens,
      idleMs: scenario.idleMs,
      hostHorizon: scenario.hostHorizon ?? null,
      compactor: scenario.compactor,
      pricing: scenario.pricing,
      cachePolicy: scenario.cachePolicy,
    })),
    aggregate,
    perScenario,
    microBenchmark: micro,
  };

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log("FoldPoint simulation benchmark");
  console.log(`scenarios: ${SCENARIOS.length}  strategies: ${aggregate.length}`);
  console.log("");
  console.log("Aggregate over all scenarios");
  console.log(aggregateTable(aggregate));
  console.log("");
  console.log("Per scenario");
  console.log(perScenarioTable(perScenario));
  console.log("");
  console.log("Decision micro-benchmark (pure decideFoldPoint, no I/O)");
  console.log(
    `  iterations=${micro.iterations} total=${micro.totalMs.toFixed(1)}ms per-decision=${micro.nanosecondsPerDecision.toFixed(0)}ns p50=${micro.p50Ms.toFixed(5)}ms p95=${micro.p95Ms.toFixed(5)}ms p99=${micro.p99Ms.toFixed(5)}ms`,
  );
  console.log("");
  console.log(`raw report: ${REPORT_PATH}`);
}

const isDirectRun = (): boolean => {
  const invoked = process.argv[1];
  return invoked !== undefined && resolve(invoked) === resolve(fileURLToPath(import.meta.url));
};

if (isDirectRun()) {
  main();
}
