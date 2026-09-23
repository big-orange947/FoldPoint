import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createBaselineFactories, type Strategy } from "../benchmarks/fixed-threshold";
import {
  buildGrowthSequence,
  createRng,
  fingerprintSequence,
  growthAtStep,
  idleAtStep,
  SCENARIOS,
  type Scenario,
} from "../benchmarks/scenarios";
import { createFoldPointStrategy, runSession } from "../benchmarks/simulator";
import { computeBreakEvenCalls } from "../src/index";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function scenarioById(id: string): Scenario {
  const scenario = SCENARIOS.find((entry) => entry.id === id);
  if (!scenario) {
    throw new Error(`scenario ${id} is missing`);
  }
  return scenario;
}

const BASE_PRICING = {
  currency: "USD",
  inputPerMillion: 3,
  outputPerMillion: 15,
  cacheReadPerMillion: 0.3,
  cacheWritePerMillion: 3.75,
};

/** A tiny hand-computable scenario for the counterfactual accounting tests. */
function testScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: "T",
    name: "counterfactual-fixture",
    title: "hand-computable counterfactual fixture",
    seed: 7,
    contextWindowTokens: 1_000_000,
    pricing: BASE_PRICING,
    cachePolicy: { ttlMs: 1_000_000 },
    steps: 3,
    startTokens: 100_000,
    growthPerStep: 0,
    growthJitter: 0,
    outputTokens: 0,
    idleMs: 10_000,
    compactor: { retentionRatio: 0.5, outputRatio: 0, successRate: 1 },
    ...overrides,
  };
}

/** A strategy that compacts at one chosen step and keeps otherwise. */
function compactAtStep(step: number, action: "COMPACT" | "FORCE" = "COMPACT"): Strategy {
  return {
    id: `compact-at-${step}`,
    label: `compact at ${step}`,
    decide(request) {
      return request.step === step ? { action } : { action: "KEEP" };
    },
  };
}

/** A strategy that compacts at several chosen steps. */
function compactAtSteps(steps: number[]): Strategy {
  return {
    id: `compact-at-${steps.join("-")}`,
    label: `compact at ${steps.join(",")}`,
    decide(request) {
      return steps.includes(request.step) ? { action: "COMPACT" } : { action: "KEEP" };
    },
  };
}

describe("1/2/3/6. shadow branch accounting", () => {
  it("1. keeps the old warm cache in the shadow while the actual branch rebuilds", () => {
    // Step 0 builds a 100k cache at the write price, step 1 is served from it and then
    // compacts, so the shadow keeps that warm cache while the actual branch rebuilds 50k.
    const scenario = testScenario({ steps: 3, startTokens: 100_000 });
    const run = runSession(scenario, compactAtStep(1));
    const record = run.compactions[0];

    expect(record?.success).toBe(true);
    expect(record?.shadowOverflowed).toBe(false);
    // shadow: 100k served from cache twice = 2 * 0.03
    // actual: 50k rebuilt once (0.1875) + 50k served from cache once (0.015)
    // attempt: 100k prompt at the input price = 0.3
    expect(record?.realizedSaving).toBeCloseTo(0.06 - (0.1875 + 0.015) - 0.3, 12);
    expect(record?.unnecessary).toBe(true);
  });

  it("6. counts a compaction that cannot repay inside a short session as unnecessary", () => {
    const scenario = testScenario({ steps: 3, startTokens: 100_000 });
    const run = runSession(scenario, compactAtStep(1));

    expect(run.metrics.judgedCompactionCount).toBe(1);
    expect(run.metrics.unnecessaryCompactionCount).toBe(1);
    expect(run.compactions[0]?.unnecessary).toBe(true);
  });

  it("2. prices both branches as plain input when there is no cache-write price", () => {
    const scenario = testScenario({
      steps: 2,
      startTokens: 100_000,
      pricing: {
        currency: "USD",
        inputPerMillion: 3,
        outputPerMillion: 15,
        cacheReadPerMillion: 0.3,
      },
      cachePolicy: { ttlMs: 5_000 }, // every gap (10s) exceeds it: the cache is always cold
    });
    const run = runSession(scenario, compactAtStep(0));
    const record = run.compactions[0];

    // shadow: 100k twice at the input price = 0.6; actual: 50k twice = 0.3; attempt 0.3
    expect(record?.realizedSaving).toBeCloseTo(0.6 - 0.3 - 0.3, 12);
    expect(record?.realizedSaving).toBeCloseTo(0, 12);
  });

  it("3. lets each branch expire its own cache independently", () => {
    // Steps 0-1 have a 10s gap (cache alive); from step 2 the gap is 600s, beyond the TTL,
    // so both branches rebuild on their own context from step 2 on.
    const scenario = testScenario({
      steps: 4,
      startTokens: 100_000,
      growthPerStep: 20_000,
      idleMs: 10_000,
      idleMsAfterStep: { fromStep: 2, idleMs: 600_000 },
      cachePolicy: { ttlMs: 300_000 },
    });
    const run = runSession(scenario, compactAtStep(1));
    const record = run.compactions[0];

    // shadow calls: step1 120k cached (0.036 + 20k input 0.06) = 0.096,
    //               step2 160k rebuilt (0.6), step3 180k rebuilt (0.675)
    // actual calls: step1 70k rebuilt (0.2625), step2 90k rebuilt (0.3375), step3 110k rebuilt (0.4125)
    // attempt: 140k at the input price = 0.42
    const shadow = 0.096 + 0.6 + 0.675;
    const actualCalls = 0.2625 + 0.3375 + 0.4125;
    expect(record?.realizedSaving).toBeCloseTo(shadow - actualCalls - 0.42, 12);
    expect(record?.unnecessary).toBe(true);
  });

  it("7. never marks a compaction unnecessary when the shadow branch would overflow", () => {
    const scenario = testScenario({
      steps: 4,
      contextWindowTokens: 100_000,
      startTokens: 40_000,
      growthPerStep: 20_000,
      compactor: { retentionRatio: 0.2, outputRatio: 0, successRate: 1 },
    });
    const run = runSession(scenario, compactAtStep(1));
    const record = run.compactions[0];

    expect(record?.shadowOverflowed).toBe(true);
    expect(record?.unnecessary).toBe(false);
    expect(run.metrics.unnecessaryCompactionCount).toBe(0);
  });

  it("8. a failed attempt is billed, judged as nothing and opens no shadow", () => {
    const scenario = testScenario({
      steps: 4,
      startTokens: 100_000,
      growthPerStep: 10_000,
      compactor: { retentionRatio: 0.5, outputRatio: 0, successRate: 0 },
    });
    const run = runSession(scenario, compactAtSteps([1, 2]));

    expect(run.metrics.compactionAttemptCount).toBe(2);
    expect(run.metrics.failedCompactionCount).toBe(2);
    expect(run.metrics.successfulCompactionCount).toBe(0);
    expect(run.metrics.judgedCompactionCount).toBe(0);
    expect(run.metrics.unnecessaryCompactionCount).toBe(0);
    expect(run.compactions.every((record) => record.realizedSaving === null)).toBe(true);
    expect(run.compactions.every((record) => record.shadowOverflowed === false)).toBe(true);
    // The context never shrank, so the session ended with everything it was offered.
    expect(run.metrics.totalPromptTokens).toBeGreaterThan(0);
  });
});

describe("4/5. the benchmark reuses the core break-even solver", () => {
  it("5. reproduces the fixture K=9, F=5, L=2, C=5 -> 4", () => {
    expect(
      computeBreakEvenCalls({
        currentCallReplayCost: 5,
        laterCallReplayCost: 5,
        compactCallCost: 9,
        firstPostCompactReplayCost: 5,
        laterPostCompactReplayCost: 2,
      }),
    ).toBe(4);
  });

  it("4. reports exactly what computeBreakEvenCalls returns for the recorded inputs", () => {
    const scenario = testScenario({ steps: 3, startTokens: 100_000 });
    const run = runSession(scenario, compactAtStep(1));
    const record = run.compactions[0];

    expect(record?.staticBreakEvenInputs).not.toBeNull();
    const inputs = record?.staticBreakEvenInputs;
    if (!inputs) {
      throw new Error("missing static break-even inputs");
    }

    // C_now: 100k served from the warm cache at the read price.
    expect(inputs.currentCallReplayCost).toBeCloseTo(100_000 * (0.3 / 1_000_000), 12);
    // C_later: the same context read from cache again, not rewritten.
    expect(inputs.laterCallReplayCost).toBeCloseTo(100_000 * (0.3 / 1_000_000), 12);
    // K: the compaction prompt at the input price.
    expect(inputs.compactCallCost).toBeCloseTo(100_000 * (3 / 1_000_000), 12);
    // F: the rebuilt 50k prefix at the cache-write price.
    expect(inputs.firstPostCompactReplayCost).toBeCloseTo(50_000 * (3.75 / 1_000_000), 12);
    // L: a later call reads the prefix; it is not assumed to rebuild it.
    expect(inputs.laterPostCompactReplayCost).toBeCloseTo(50_000 * (0.3 / 1_000_000), 12);

    expect(record?.staticBreakEvenCalls).toBe(computeBreakEvenCalls(inputs));
    expect(record?.staticBreakEvenCalls).toBeCloseTo(
      1 + (0.3 + 0.1875 - 0.03) / (0.03 - 0.015),
      12,
    );
  });

  it("4c. bills the current call at the write price when the cache has lapsed", () => {
    // A write premium (3.75 against 3.00 input) and a gap beyond the TTL. The host reports no
    // served prefix, so this call has nothing to read: C is the whole prompt at the
    // cache-write price, not at the input price. (The current-call/later-call distinction
    // shows up when a prefix is reported while the TTL has lapsed: see the core's 17.3b.)
    const scenario = testScenario({
      cachePolicy: { ttlMs: 1_000 },
      idleMs: 600_000,
      steps: 3,
    });
    const run = runSession(scenario, compactAtStep(1));
    const inputs = run.compactions[0]?.staticBreakEvenInputs;

    if (!inputs) {
      throw new Error("missing static break-even inputs");
    }

    expect(inputs.currentCallReplayCost).toBeCloseTo(100_000 * (3.75 / 1_000_000), 12);
    expect(inputs.currentCallReplayCost).toBeGreaterThan(100_000 * (3 / 1_000_000));
    expect(inputs.laterCallReplayCost).toBeCloseTo(100_000 * (3.75 / 1_000_000), 12);
    // F and L both write the compacted prefix: there is no live prefix to read from.
    expect(inputs.firstPostCompactReplayCost).toBeCloseTo(50_000 * (3.75 / 1_000_000), 12);
    expect(inputs.laterPostCompactReplayCost).toBeCloseTo(50_000 * (3.75 / 1_000_000), 12);
    expect(run.compactions[0]?.staticBreakEvenCalls).toBe(computeBreakEvenCalls(inputs));
  });

  it("4b. every recorded static break-even is the core solver's answer", () => {
    let checked = 0;
    for (const scenario of SCENARIOS) {
      for (const factory of [...createBaselineFactories(), createFoldPointStrategy]) {
        const run = runSession(scenario, factory(scenario));
        for (const record of run.compactions) {
          if (!record.staticBreakEvenInputs) {
            continue;
          }
          expect(record.staticBreakEvenCalls).toBe(
            computeBreakEvenCalls(record.staticBreakEvenInputs),
          );
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("9. growth fairness", () => {
  it("every strategy of a scenario consumes the same growth sequence", () => {
    for (const scenario of SCENARIOS) {
      const factories = [...createBaselineFactories(), createFoldPointStrategy];
      const runs = factories.map((factory) => runSession(scenario, factory(scenario)));
      const expected = buildGrowthSequence(scenario);
      const expectedFingerprint = fingerprintSequence(expected);
      const expectedTotal = expected.reduce((total, value) => total + value, 0);

      for (const run of runs) {
        expect(
          run.metrics.totalOfferedGrowthTokens,
          `${scenario.id} ${run.metrics.strategyId}`,
        ).toBe(expectedTotal);
        expect(
          run.metrics.growthSequenceFingerprint,
          `${scenario.id} ${run.metrics.strategyId}`,
        ).toBe(expectedFingerprint);
      }

      // Compaction counts may differ wildly; the offer may not.
      const attempts = new Set(runs.map((run) => run.metrics.compactionAttemptCount));
      expect(attempts.size).toBeGreaterThanOrEqual(1);
    }
  });

  it("builds the sequence from one RNG advanced step by step", () => {
    const scenario = scenarioById("D");
    const rng = createRng(scenario.seed);
    const stepByStep = Array.from({ length: scenario.steps }, (_, step) =>
      growthAtStep(scenario, step, rng),
    );

    expect(stepByStep).toEqual(buildGrowthSequence(scenario));
    expect(stepByStep).not.toEqual(
      Array.from({ length: scenario.steps }, (_, step) =>
        growthAtStep(scenario, step, createRng(scenario.seed)),
      ),
    );
  });

  it("failure RNG consumption cannot change the growth fingerprint", () => {
    const flaky = scenarioById("K");
    const reliable: Scenario = {
      ...flaky,
      compactor: { ...flaky.compactor, successRate: 1 },
    };

    const withFailures = runSession(flaky, createFoldPointStrategy(flaky));
    const withoutFailures = runSession(reliable, createFoldPointStrategy(reliable));

    expect(withFailures.metrics.failedCompactionCount).toBeGreaterThan(0);
    expect(withoutFailures.metrics.failedCompactionCount).toBe(0);
    expect(withFailures.metrics.growthSequenceFingerprint).toBe(
      withoutFailures.metrics.growthSequenceFingerprint,
    );
    expect(withFailures.metrics.totalOfferedGrowthTokens).toBe(
      withoutFailures.metrics.totalOfferedGrowthTokens,
    );
  });

  it("reproduces the same run for the same seed and differs for another seed", () => {
    const scenario = scenarioById("B");
    const first = runSession(scenario, createFoldPointStrategy(scenario));
    const second = runSession(scenario, createFoldPointStrategy(scenario));
    const otherSeed = { ...scenario, seed: scenario.seed + 5 };
    const other = runSession(otherSeed, createFoldPointStrategy(otherSeed));

    expect(second.metrics.totalSimulatedCost).toBe(first.metrics.totalSimulatedCost);
    expect(second.metrics.growthSequenceFingerprint).toBe(first.metrics.growthSequenceFingerprint);
    expect(other.metrics.growthSequenceFingerprint).not.toBe(
      first.metrics.growthSequenceFingerprint,
    );
  });

  it("uses the per-step idle override for the cache decision", () => {
    const scenario = scenarioById("A");
    const withOverride: Scenario = {
      ...scenario,
      idleMsAfterStep: { fromStep: 1, idleMs: scenario.idleMs * 10 },
    };

    expect(idleAtStep(scenario, 0)).toBe(scenario.idleMs);
    expect(idleAtStep(withOverride, 0)).toBe(withOverride.idleMs);
    expect(idleAtStep(withOverride, 1)).toBe(withOverride.idleMs * 10);
  });
});

describe("10. the README aggregate table matches the report", () => {
  it("quotes exactly the committed JSON values", () => {
    const report = JSON.parse(
      readFileSync(join(REPO_ROOT, "benchmarks", "reports", "benchmark-report.json"), "utf8"),
    ) as {
      aggregate: Array<{
        strategyId: string;
        totalSimulatedCost: number;
        compactionAttemptCount: number;
        successfulCompactionCount: number;
        failedCompactionCount: number;
        economicAttemptCount: number;
        forcedAttemptCount: number;
        judgedCompactionCount: number;
        unnecessaryCompactionCount: number;
        overflowCount: number;
      }>;
    };
    const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");

    const labels: Record<string, string> = {
      never: "Never",
      "fixed-50-raw": "Fixed 50% raw",
      "fixed-70-raw": "Fixed 70% raw",
      "fixed-80-raw": "Fixed 80% raw",
      "fixed-90-raw": "Fixed 90% raw",
      "fixed-70-guarded": "Fixed 70% guarded",
      "fixed-80-guarded": "Fixed 80% guarded",
      "fixed-90-guarded": "Fixed 90% guarded",
      foldpoint: "FoldPoint",
    };

    const clean = (value: string) => value.replace(/\*/g, "").replace(/,/g, "").trim();
    let checked = 0;

    for (const row of report.aggregate) {
      const label = labels[row.strategyId];
      expect(label, `README label for ${row.strategyId}`).toBeDefined();
      const line = readme.split("\n").find((entry) => clean(entry.split("|")[1] ?? "") === label);
      expect(line, `README row for ${row.strategyId}`).toBeDefined();
      if (!line || !label) {
        continue;
      }

      const cells = line.split("|").map(clean);
      expect(Number(cells[2]).toFixed(2), `${label} cost`).toBe(row.totalSimulatedCost.toFixed(2));
      expect(Number(cells[3]), `${label} attempts`).toBe(row.compactionAttemptCount);
      expect(Number(cells[4]), `${label} ok`).toBe(row.successfulCompactionCount);
      expect(Number(cells[5]), `${label} failed`).toBe(row.failedCompactionCount);
      expect(Number(cells[6]), `${label} econ`).toBe(row.economicAttemptCount);
      expect(Number(cells[7]), `${label} forced`).toBe(row.forcedAttemptCount);
      expect(Number(cells[8]), `${label} judged`).toBe(row.judgedCompactionCount);
      expect(Number(cells[9]), `${label} unneeded`).toBe(row.unnecessaryCompactionCount);
      expect(Number(cells[10]), `${label} overflows`).toBe(row.overflowCount);
      checked += 1;
    }

    expect(checked).toBe(report.aggregate.length);
  });
});

describe("counterfactual invariants across the whole benchmark", () => {
  it("never marks an overflowing shadow as unnecessary, and never judges a forced compaction", () => {
    for (const scenario of SCENARIOS) {
      for (const factory of [...createBaselineFactories(), createFoldPointStrategy]) {
        const run = runSession(scenario, factory(scenario));
        for (const record of run.compactions) {
          if (record.shadowOverflowed) {
            expect(record.unnecessary, `${scenario.id} ${record.step}`).toBe(false);
          }
          if (record.forced) {
            expect(record.unnecessary, `${scenario.id} ${record.step}`).toBeNull();
            expect(record.realizedSaving, `${scenario.id} ${record.step}`).toBeNull();
          }
          if (!record.success) {
            expect(record.realizedSaving).toBeNull();
          }
        }
      }
    }
  });

  it("judges exactly the successful, non-forced compactions", () => {
    for (const scenario of SCENARIOS) {
      const run = runSession(scenario, createFoldPointStrategy(scenario));
      const expected = run.compactions.filter((record) => record.success && !record.forced).length;
      expect(run.metrics.judgedCompactionCount).toBe(expected);
    }
  });
});

describe("17.17 the benchmark consumes successRate", () => {
  it("scenario K really produces failed attempts, reproducibly", () => {
    const scenario = scenarioById("K");
    expect(scenario.compactor.successRate).toBeLessThan(1);

    const first = runSession(scenario, createFoldPointStrategy(scenario));
    const second = runSession(scenario, createFoldPointStrategy(scenario));

    expect(first.metrics.compactionAttemptCount).toBeGreaterThan(0);
    expect(first.metrics.failedCompactionCount).toBeGreaterThan(0);
    expect(first.metrics.successfulCompactionCount + first.metrics.failedCompactionCount).toBe(
      first.metrics.compactionAttemptCount,
    );

    expect(second.metrics.totalSimulatedCost).toBe(first.metrics.totalSimulatedCost);
    expect(second.metrics.compactionAttemptCount).toBe(first.metrics.compactionAttemptCount);
    expect(second.metrics.failedCompactionCount).toBe(first.metrics.failedCompactionCount);
    expect(second.metrics.judgedCompactionCount).toBe(first.metrics.judgedCompactionCount);
  });

  it("a strategy that never succeeds pays for every attempt", () => {
    const scenario = {
      ...scenarioById("K"),
      compactor: { ...scenarioById("K").compactor, successRate: 0 },
    };
    const run = runSession(scenario, createFoldPointStrategy(scenario));

    expect(run.metrics.compactionAttemptCount).toBeGreaterThan(0);
    expect(run.metrics.successfulCompactionCount).toBe(0);
    expect(run.metrics.failedCompactionCount).toBe(run.metrics.compactionAttemptCount);
    expect(run.metrics.overflowCount).toBeGreaterThan(0);
  });
});

describe("benchmark comparison set", () => {
  it("reports raw and guarded fixed thresholds plus FoldPoint", () => {
    const ids = createBaselineFactories().map((factory) => factory(scenarioById("A")).id);

    expect(ids).toContain("never");
    expect(ids).toContain("fixed-50-raw");
    expect(ids).toContain("fixed-70-raw");
    expect(ids).toContain("fixed-80-raw");
    expect(ids).toContain("fixed-90-raw");
    expect(ids).toContain("fixed-70-guarded");
    expect(ids).toContain("fixed-80-guarded");
    expect(ids).toContain("fixed-90-guarded");
    expect(createFoldPointStrategy(scenarioById("A")).id).toBe("foldpoint");
  });

  it("never lets the window overflow for FoldPoint", () => {
    for (const scenario of SCENARIOS) {
      const foldPoint = runSession(scenario, createFoldPointStrategy(scenario));
      expect(foldPoint.metrics.overflowCount, `scenario ${scenario.id}`).toBe(0);
    }
  });
});
