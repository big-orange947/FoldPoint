import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createProfileState,
  DEFAULTS,
  decideFoldPoint,
  FoldPoint,
  type FoldPointInput,
  type FoldPointProfile,
  percentile,
  resolveDefaults,
} from "../src/index";
import {
  type CompactionEvent,
  createBaselineFactories,
  type DecisionRequest,
  type RequestEvent,
  type Strategy,
  type StrategyFactory,
} from "./fixed-threshold";
import { createRng, growthAtStep, SCENARIOS, type Scenario } from "./scenarios";

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
  compactionCount: number;
  forcedCompactionCount: number;
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
 * FoldPoint wired the way a host would wire it: observe every real call, record every real
 * compaction, report session end, and never hand it ground truth.
 */
export function createFoldPointStrategy(scenario: Scenario): Strategy {
  const foldPoint = new FoldPoint();
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
        profile,
        timestamp: request.timestamp,
        contextTokens: request.contextTokens,
        cachedTokens: request.cachedTokens,
        idleMs: request.idleMs,
        safeBoundary: true,
        compactionAllowed: true,
      };
      if (scenario.hostHorizon !== undefined) {
        input.expectedFutureCalls = scenario.hostHorizon;
      }

      const decision = foldPoint.decide(input);
      return {
        action: decision.action,
        reasons: decision.reasons,
        estimatedBreakEvenCalls: decision.metrics.breakEvenCalls,
      };
    },
    onCompaction(event: CompactionEvent) {
      foldPoint.recordCompaction(profile, {
        timestamp: event.timestamp,
        beforeTokens: event.beforeTokens,
        afterTokens: event.afterTokens,
        promptTokens: event.beforeTokens,
        outputTokens: event.outputTokens,
        success: event.success,
      });
    },
    onRequest(event: RequestEvent) {
      foldPoint.observeRequest(profile, {
        timestamp: event.timestamp,
        promptTokens: event.promptTokens,
        cachedInputTokens: event.cachedInputTokens,
        outputTokens: event.outputTokens,
      });
    },
    onSessionEnd(timestamp: number) {
      foldPoint.endSession(profile, { timestamp });
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
 * - new tokens are appended at the start of each step,
 * - the provider caches the whole prompt of a successful call, until the TTL lapses or a
 *   compaction rebuilds the prefix,
 * - an overflow is a call whose prompt exceeds the window: it is charged at the window
 *   limit and counted, and the strategy gets no second chance,
 * - the compactor behaves exactly as the scenario's ground truth says.
 */
export function runSession(scenario: Scenario, strategy: Strategy): SessionRun {
  const random = createRng(scenario.seed);
  const pin = scenario.pricing.inputPerMillion / 1_000_000;
  const pout = scenario.pricing.outputPerMillion / 1_000_000;
  const pcache =
    (scenario.pricing.cacheReadPerMillion ?? scenario.pricing.inputPerMillion) / 1_000_000;
  const ttlMs = scenario.cachePolicy.ttlMs ?? Number.POSITIVE_INFINITY;

  let contextTokens = scenario.startTokens;
  let lastPromptTokens = 0;
  let lastCallAt: number | undefined;
  let cacheHeld = false;
  let timestamp = BASE_TIMESTAMP;

  const latencies: number[] = [];
  const breakEvens: number[] = [];
  const estimatedBreakEvens: number[] = [];
  let totalSimulatedCost = 0;
  let totalPromptTokens = 0;
  let totalCachedTokens = 0;
  let totalOutputTokens = 0;
  let compactionCount = 0;
  let forcedCompactionCount = 0;
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
    contextTokens += growthAtStep(scenario, step, random);

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

    if (decision.action !== "KEEP") {
      finalizeActive();

      const beforeTokens = contextTokens;
      const compactionOutputTokens = Math.round(beforeTokens * scenario.compactor.outputRatio);
      const afterTokens = Math.round(beforeTokens * scenario.compactor.retentionRatio);
      const cost = beforeTokens * pin + compactionOutputTokens * pout;
      const coverage = beforeTokens > 0 ? cachedTokens / beforeTokens : 0;
      const perTokenReplay = coverage * pcache + (1 - coverage) * pin;
      const savingPerCall = (beforeTokens - afterTokens) * perTokenReplay;
      const breakEvenCalls = savingPerCall > 0 ? cost / savingPerCall : null;
      const forced = utilization >= DEFAULTS.hardWindowRatio;

      totalSimulatedCost += cost;
      compactionCount += 1;
      utilizationAtCompactionSum += utilization;
      if (forced) {
        forcedCompactionCount += 1;
      }
      if (breakEvenCalls !== null) {
        breakEvens.push(breakEvenCalls);
      }
      if (typeof decision.estimatedBreakEvenCalls === "number") {
        estimatedBreakEvens.push(decision.estimatedBreakEvenCalls);
      }

      active = { beforeTokens, afterTokens, cost, saving: 0, forced };

      strategy.onCompaction?.({
        step,
        timestamp,
        beforeTokens,
        afterTokens,
        outputTokens: compactionOutputTokens,
        action: decision.action,
        cost,
        breakEvenCalls,
        success: true,
      });

      contextTokens = afterTokens;
      lastPromptTokens = 0;
      cacheHeld = false;
      callCachedTokens = 0;
    }

    const rawContextTokens = contextTokens;

    // An overflow is a call the provider rejects: the host is then forced to compact at the
    // worst possible moment. The strategy still pays for that recovery and is charged for
    // the overflow in the overflow count.
    if (rawContextTokens > scenario.contextWindowTokens) {
      overflowCount += 1;
      finalizeActive();

      const beforeTokens = rawContextTokens;
      const recoveryOutputTokens = Math.round(beforeTokens * scenario.compactor.outputRatio);
      const recoveredTokens = Math.round(beforeTokens * scenario.compactor.retentionRatio);
      const recoveryCost = beforeTokens * pin + recoveryOutputTokens * pout;

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
    }

    const chargedPrompt = contextTokens;
    minRemainingHeadroom = Math.min(
      minRemainingHeadroom,
      scenario.contextWindowTokens - rawContextTokens,
    );

    callCachedTokens = Math.min(callCachedTokens, chargedPrompt);
    const callCost =
      (chargedPrompt - callCachedTokens) * pin +
      callCachedTokens * pcache +
      scenario.outputTokens * pout;

    totalSimulatedCost += callCost;
    totalPromptTokens += chargedPrompt;
    totalCachedTokens += callCachedTokens;
    totalOutputTokens += scenario.outputTokens;

    if (active) {
      const counterfactualPrompt = chargedPrompt + (active.beforeTokens - active.afterTokens);
      const coverage = chargedPrompt > 0 ? callCachedTokens / chargedPrompt : 0;
      const counterfactualCached = Math.min(
        counterfactualPrompt,
        Math.round(counterfactualPrompt * coverage),
      );
      const counterfactualCost =
        (counterfactualPrompt - counterfactualCached) * pin + counterfactualCached * pcache;
      active.saving += counterfactualCost - callCost;
    }

    strategy.onRequest?.({
      step,
      timestamp,
      promptTokens: chargedPrompt,
      cachedInputTokens: callCachedTokens,
      outputTokens: scenario.outputTokens,
      cost: callCost,
    });

    lastPromptTokens = chargedPrompt;
    lastCallAt = timestamp;
    cacheHeld = true;
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
      compactionCount,
      forcedCompactionCount,
      forceDecisionCount,
      overflowCount,
      overflowRecoveryCount,
      minRemainingHeadroom: Number.isFinite(minRemainingHeadroom) ? minRemainingHeadroom : 0,
      averageUtilizationAtCompaction:
        compactionCount > 0 ? utilizationAtCompactionSum / compactionCount : null,
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
  compactionCount: number;
  forcedCompactionCount: number;
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

  const compactionCount = sum((metrics) => metrics.compactionCount);
  const weightedUtilization =
    compactionCount > 0
      ? rows.reduce(
          (total, metrics) =>
            total + (metrics.averageUtilizationAtCompaction ?? 0) * metrics.compactionCount,
          0,
        ) / compactionCount
      : null;

  return {
    strategyId: strategy.id,
    strategyLabel: strategy.label,
    scenarioCount: rows.length,
    totalSimulatedCost: sum((metrics) => metrics.totalSimulatedCost),
    totalPromptTokens: sum((metrics) => metrics.totalPromptTokens),
    totalCachedTokens: sum((metrics) => metrics.totalCachedTokens),
    totalOutputTokens: sum((metrics) => metrics.totalOutputTokens),
    compactionCount,
    forcedCompactionCount: sum((metrics) => metrics.forcedCompactionCount),
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
  const state = {
    ...createProfileState(defaults),
    compactionCount: 1,
    successfulCompactionCount: 1,
    callsSinceLastCompaction: 6,
    retentionSamples: 4,
    retentionRatioEma: 0.3,
    cacheSamples: 5,
    cacheHitRatioEma: 0.8,
    horizonSamples: 3,
    reuseHorizonEma: 6,
    compactionCostSamples: 2,
    compactionCostEma: 0.05,
  };
  const input: FoldPointInput = {
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
    decideFoldPoint(input, state);
  }

  const samples = new Float64Array(iterations);
  const startedAll = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    decideFoldPoint(input, state);
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
    pad("strategy", 12),
    padLeft("cost", 12),
    padLeft("compactions", 12),
    padLeft("forced", 8),
    padLeft("unneeded", 9),
    padLeft("overflows", 10),
    padLeft("recovered", 10),
    padLeft("minHeadroom", 12),
    padLeft("avgUtil@comp", 13),
    padLeft("breakEven", 10),
    padLeft("p50 ms", 9),
    padLeft("p95 ms", 9),
    padLeft("p99 ms", 9),
  ].join(" ");

  const lines = [header, "-".repeat(header.length)];
  for (const row of rows) {
    lines.push(
      [
        pad(row.strategyLabel, 12),
        padLeft(row.totalSimulatedCost.toFixed(4), 12),
        padLeft(String(row.compactionCount), 12),
        padLeft(String(row.forcedCompactionCount), 8),
        padLeft(String(row.unnecessaryCompactionCount), 9),
        padLeft(String(row.overflowCount), 10),
        padLeft(String(row.overflowRecoveryCount), 10),
        padLeft(String(row.minRemainingHeadroom), 12),
        padLeft(fixed(row.averageUtilizationAtCompaction, 3), 13),
        padLeft(fixed(row.meanBreakEvenCallsAtCompaction, 2), 10),
        padLeft(fixed(row.decisionLatencyP50Ms, 5), 9),
        padLeft(fixed(row.decisionLatencyP95Ms, 5), 9),
        padLeft(fixed(row.decisionLatencyP99Ms, 5), 9),
      ].join(" "),
    );
  }
  return lines.join("\n");
}

function perScenarioTable(rows: SessionMetrics[]): string {
  const header = [
    pad("scenario", 20),
    pad("strategy", 12),
    padLeft("cost", 11),
    padLeft("comp", 5),
    padLeft("forced", 7),
    padLeft("unneed", 7),
    padLeft("over", 5),
    padLeft("recov", 6),
    padLeft("avgUtil", 8),
    padLeft("cached%", 8),
  ].join(" ");

  const lines = [header, "-".repeat(header.length)];
  for (const row of rows) {
    const cachedShare =
      row.totalPromptTokens > 0 ? (row.totalCachedTokens / row.totalPromptTokens) * 100 : 0;
    lines.push(
      [
        pad(`${row.scenarioId} ${row.scenarioName}`, 20),
        pad(row.strategyId, 12),
        padLeft(row.totalSimulatedCost.toFixed(3), 11),
        padLeft(String(row.compactionCount), 5),
        padLeft(String(row.forcedCompactionCount), 7),
        padLeft(String(row.unnecessaryCompactionCount), 7),
        padLeft(String(row.overflowCount), 5),
        padLeft(String(row.overflowRecoveryCount), 6),
        padLeft(fixed(row.averageUtilizationAtCompaction, 3), 8),
        padLeft(cachedShare.toFixed(1), 8),
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
