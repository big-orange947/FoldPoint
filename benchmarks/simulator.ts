import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  costOfUsage,
  createProfileLearningState,
  createSessionState,
  DEFAULTS,
  decideFoldPoint,
  FoldPoint,
  type FoldPointInput,
  type FoldPointProfile,
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
import { createFailureRng, createRng, growthAtStep, SCENARIOS, type Scenario } from "./scenarios";

const BASE_TIMESTAMP = 1_700_000_000_000;
const REPORT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "reports",
  "benchmark-report.json",
);

interface ActiveCompaction {
  beforeTokens: number;
  afterTokens: number;
  cost: number;
  saving: number;
  forced: boolean;
}

export interface SessionMetrics {
  scenarioId: string;
  scenarioName: string;
  strategyId: string;
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
  unnecessaryCompactionCount: number;
  meanBreakEvenCallsAtCompaction: number | null;
  meanEstimatedBreakEvenCallsAtCompaction: number | null;
  decisionLatencyP50Ms: number;
  decisionLatencyP95Ms: number;
  decisionLatencyP99Ms: number;
}

export interface SessionRun {
  metrics: SessionMetrics;
  latencies: number[];
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

/**
 * Runs one simulated session.
 *
 * The model is identical for every strategy:
 * - new tokens are appended at the start of each step, driven only by the growth RNG;
 * - the provider caches the whole prompt of a successful call, until the TTL lapses or a
 *   successful compaction rebuilds the prefix;
 * - rebuilding a prefix is billed at the cache-write price, exactly like the engine models
 *   the first post-compaction replay;
 * - a compaction attempt fails with probability `1 - successRate` (failure RNG): it is
 *   billed, it does not change the context and it does not build a cache;
 * - an overflow is a call whose prompt exceeds the window: it is counted, and the host is
 *   then forced to compact at the worst possible moment and pays for that recovery.
 */
export function runSession(scenario: Scenario, strategy: Strategy): SessionRun {
  const growthRandom = createRng(scenario.seed);
  const failureRandom = createFailureRng(scenario.seed);
  const prices: UnitPrices = resolveUnitPrices(scenario.pricing);
  const ttlMs = scenario.cachePolicy.ttlMs ?? Number.POSITIVE_INFINITY;

  let contextTokens = scenario.startTokens;
  let lastPromptTokens = 0;
  let lastCallAt: number | undefined;
  let cacheHeld = false;
  let rebuildingCache = true;
  let timestamp = BASE_TIMESTAMP;

  const latencies: number[] = [];
  const breakEvens: number[] = [];
  const estimatedBreakEvens: number[] = [];
  let totalSimulatedCost = 0;
  let totalPromptTokens = 0;
  let totalCachedTokens = 0;
  let totalOutputTokens = 0;
  let compactionAttemptCount = 0;
  let successfulCompactionCount = 0;
  let failedCompactionCount = 0;
  let economicAttemptCount = 0;
  let forcedAttemptCount = 0;
  let forceDecisionCount = 0;
  let overflowCount = 0;
  let overflowRecoveryCount = 0;
  let unnecessaryCompactionCount = 0;
  let minRemainingHeadroom = Number.POSITIVE_INFINITY;
  let utilizationAtCompactionSum = 0;
  let active: ActiveCompaction | null = null;

  const finalizeActive = (): void => {
    if (active && !active.forced && active.saving < active.cost) {
      unnecessaryCompactionCount += 1;
    }
    active = null;
  };

  for (let step = 0; step < scenario.steps; step += 1) {
    timestamp += scenario.idleMs;
    contextTokens += growthAtStep(scenario, step, growthRandom);

    const cacheAlive = cacheHeld && lastCallAt !== undefined && timestamp - lastCallAt < ttlMs;
    const cachedTokens = cacheAlive ? Math.min(lastPromptTokens, contextTokens) : 0;
    const utilization = contextTokens / scenario.contextWindowTokens;

    const request: DecisionRequest = {
      step,
      timestamp,
      idleMs: scenario.idleMs,
      contextTokens,
      cachedTokens,
      utilization,
    };

    const started = performance.now();
    const decision = strategy.decide(request);
    latencies.push(performance.now() - started);

    if (decision.action === "FORCE") {
      forceDecisionCount += 1;
    }

    let callCachedTokens = cachedTokens;
    let callRebuildsCache = rebuildingCache;

    if (decision.action !== "KEEP") {
      finalizeActive();

      const beforeTokens = contextTokens;
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

      const coverage = beforeTokens > 0 ? cachedTokens / beforeTokens : 0;
      const perTokenReplay =
        coverage * prices.cacheReadPerToken + (1 - coverage) * prices.inputPerToken;
      const savingPerCall = (beforeTokens - afterTokens) * perTokenReplay;
      const breakEvenCalls = success && savingPerCall > 0 ? attemptCost / savingPerCall : null;

      strategy.onCompaction?.({
        step,
        timestamp,
        beforeTokens,
        afterTokens,
        outputTokens: compactionOutputTokens,
        action: decision.action,
        cost: attemptCost,
        breakEvenCalls,
        success,
      });

      if (success) {
        successfulCompactionCount += 1;
        if (breakEvenCalls !== null) {
          breakEvens.push(breakEvenCalls);
        }
        if (typeof decision.estimatedBreakEvenCalls === "number") {
          estimatedBreakEvens.push(decision.estimatedBreakEvenCalls);
        }
        active = {
          beforeTokens,
          afterTokens,
          cost: attemptCost,
          saving: 0,
          forced: decision.action === "FORCE",
        };
        contextTokens = afterTokens;
        lastPromptTokens = 0;
        cacheHeld = false;
        callCachedTokens = 0;
        callRebuildsCache = true;
      } else {
        failedCompactionCount += 1;
        // The context is unchanged and no cache prefix was built; the next call still sees
        // whatever the previous call left in the cache.
      }
    }

    const rawContextTokens = contextTokens;

    if (rawContextTokens > scenario.contextWindowTokens) {
      overflowCount += 1;
      finalizeActive();

      const beforeTokens = rawContextTokens;
      const recoveryOutputTokens = Math.round(beforeTokens * scenario.compactor.outputRatio);
      const recoveredTokens = Math.round(beforeTokens * scenario.compactor.retentionRatio);
      const recoveryCost = costOfUsage(prices, {
        promptTokens: beforeTokens,
        cacheWriteTokens: beforeTokens,
        outputTokens: recoveryOutputTokens,
      });

      totalSimulatedCost += recoveryCost;
      overflowRecoveryCount += 1;
      strategy.onCompaction?.({
        step,
        timestamp,
        beforeTokens,
        afterTokens: recoveredTokens,
        outputTokens: recoveryOutputTokens,
        action: "FORCE",
        cost: recoveryCost,
        breakEvenCalls: null,
        success: true,
      });

      contextTokens = recoveredTokens;
      lastPromptTokens = 0;
      cacheHeld = false;
      callCachedTokens = 0;
      callRebuildsCache = true;
    }

    minRemainingHeadroom = Math.min(
      minRemainingHeadroom,
      scenario.contextWindowTokens - rawContextTokens,
    );

    const chargedPrompt = contextTokens;
    const usage = callRebuildsCache
      ? {
          promptTokens: chargedPrompt,
          cacheWriteTokens: chargedPrompt,
          outputTokens: scenario.outputTokens,
        }
      : {
          promptTokens: chargedPrompt,
          cachedInputTokens: callCachedTokens,
          outputTokens: scenario.outputTokens,
        };
    const callCost = costOfUsage(prices, usage);

    totalSimulatedCost += callCost;
    totalPromptTokens += chargedPrompt;
    totalCachedTokens += callRebuildsCache ? 0 : callCachedTokens;
    totalOutputTokens += scenario.outputTokens;

    if (active) {
      const counterfactualPrompt = chargedPrompt + (active.beforeTokens - active.afterTokens);
      const coverage =
        chargedPrompt > 0 ? (callRebuildsCache ? 0 : callCachedTokens / chargedPrompt) : 0;
      const counterfactualCached = Math.min(
        counterfactualPrompt,
        Math.round(counterfactualPrompt * coverage),
      );
      const counterfactualCost = costOfUsage(prices, {
        promptTokens: counterfactualPrompt,
        cachedInputTokens: counterfactualCached,
        outputTokens: scenario.outputTokens,
      });
      active.saving += counterfactualCost - callCost;
    }

    strategy.onRequest?.({
      step,
      timestamp,
      promptTokens: chargedPrompt,
      cachedInputTokens: callRebuildsCache ? 0 : callCachedTokens,
      outputTokens: scenario.outputTokens,
      cost: callCost,
    });

    lastPromptTokens = chargedPrompt;
    lastCallAt = timestamp;
    cacheHeld = true;
    rebuildingCache = false;
  }

  finalizeActive();
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
      unnecessaryCompactionCount,
      meanBreakEvenCallsAtCompaction: mean(breakEvens),
      meanEstimatedBreakEvenCallsAtCompaction: mean(estimatedBreakEvens),
      decisionLatencyP50Ms: safePercentile(latencies, 0.5),
      decisionLatencyP95Ms: safePercentile(latencies, 0.95),
      decisionLatencyP99Ms: safePercentile(latencies, 0.99),
    },
    latencies,
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
  unnecessaryCompactionCount: number;
  meanBreakEvenCallsAtCompaction: number | null;
  meanEstimatedBreakEvenCallsAtCompaction: number | null;
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
    unnecessaryCompactionCount: sum((metrics) => metrics.unnecessaryCompactionCount),
    meanBreakEvenCallsAtCompaction: meanOf((metrics) => metrics.meanBreakEvenCallsAtCompaction),
    meanEstimatedBreakEvenCallsAtCompaction: meanOf(
      (metrics) => metrics.meanEstimatedBreakEvenCallsAtCompaction,
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
    padLeft("unneed", 7),
    padLeft("over", 5),
    padLeft("minHead", 9),
    padLeft("avgUtil", 8),
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
        padLeft(String(row.unnecessaryCompactionCount), 7),
        padLeft(String(row.overflowCount), 5),
        padLeft(String(row.minRemainingHeadroom), 9),
        padLeft(fixed(row.averageUtilizationAtCompaction, 3), 8),
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
    seeds: Object.fromEntries(SCENARIOS.map((scenario) => [scenario.id, scenario.seed])),
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
