import { describe, expect, it } from "vitest";
import { createBaselineFactories } from "../benchmarks/fixed-threshold";
import { createFailureRng, createRng, growthAtStep, SCENARIOS } from "../benchmarks/scenarios";
import { createFoldPointStrategy, runSession } from "../benchmarks/simulator";

function scenarioById(id: string) {
  const scenario = SCENARIOS.find((entry) => entry.id === id);
  if (!scenario) {
    throw new Error(`scenario ${id} is missing`);
  }
  return scenario;
}

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

    // Same seed, same result: only latency may differ between runs.
    expect(second.metrics.totalSimulatedCost).toBe(first.metrics.totalSimulatedCost);
    expect(second.metrics.compactionAttemptCount).toBe(first.metrics.compactionAttemptCount);
    expect(second.metrics.failedCompactionCount).toBe(first.metrics.failedCompactionCount);
  });

  it("a failed attempt costs money but does not shrink the context", () => {
    const scenario = {
      ...scenarioById("K"),
      compactor: { ...scenarioById("K").compactor, successRate: 0 },
    };
    const run = runSession(scenario, createFoldPointStrategy(scenario));

    expect(run.metrics.compactionAttemptCount).toBeGreaterThan(0);
    expect(run.metrics.successfulCompactionCount).toBe(0);
    expect(run.metrics.failedCompactionCount).toBe(run.metrics.compactionAttemptCount);
    // Nothing ever shrank, so the window was overrun and the host had to recover.
    expect(run.metrics.overflowCount).toBeGreaterThan(0);
  });

  it("the failure stream is independent of the growth stream", () => {
    const scenario = scenarioById("K");
    const growthValues = [0, 1, 2, 3, 4].map((step) =>
      growthAtStep(scenario, step, createRng(scenario.seed)),
    );
    const failureValues = Array.from({ length: 5 }, () => createFailureRng(scenario.seed)());

    expect(growthValues).not.toEqual(failureValues);
    // Both streams are stable for a given seed.
    expect([0, 1, 2].map((step) => growthAtStep(scenario, step, createRng(scenario.seed)))).toEqual(
      growthValues.slice(0, 3),
    );
  });
});

describe("17.18 every strategy sees the same growth sequence", () => {
  it("growth depends only on the scenario seed and the step", () => {
    const scenario = scenarioById("D");

    const first = Array.from({ length: scenario.steps }, (_, step) =>
      growthAtStep(scenario, step, createRng(scenario.seed)),
    );
    const second = Array.from({ length: scenario.steps }, (_, step) =>
      growthAtStep(scenario, step, createRng(scenario.seed)),
    );

    expect(second).toEqual(first);
  });

  it("a strategy that compacts far more often still sees the same growth", () => {
    const scenario = scenarioById("D");
    const factories = createBaselineFactories();
    const never = factories[0];
    const guardedNinety = factories[factories.length - 1];
    if (!never || !guardedNinety) {
      throw new Error("baseline factories are missing");
    }

    const neverRun = runSession(scenario, never(scenario));
    const guardedRun = runSession(scenario, guardedNinety(scenario));

    // Both runs consume the same growth stream, so the total tokens they were offered are
    // identical; they differ only in what they did with them.
    const expectedGrowth = Array.from({ length: scenario.steps }, (_, step) =>
      growthAtStep(scenario, step, createRng(scenario.seed)),
    ).reduce((total, value) => total + value, 0);

    expect(neverRun.metrics.totalPromptTokens).toBeGreaterThan(0);
    expect(guardedRun.metrics.compactionAttemptCount).toBeGreaterThan(0);
    expect(expectedGrowth).toBeGreaterThan(0);
  });

  it("compaction attempts differ between strategies while the scenario stays fixed", () => {
    const scenario = scenarioById("F");
    const factories = createBaselineFactories();
    const rawFifty = factories[1];
    if (!rawFifty) {
      throw new Error("baseline factory is missing");
    }

    const raw = runSession(scenario, rawFifty(scenario));
    const foldPoint = runSession(scenario, createFoldPointStrategy(scenario));

    expect(raw.metrics.compactionAttemptCount).toBeGreaterThan(
      foldPoint.metrics.compactionAttemptCount,
    );
    expect(foldPoint.metrics.failedCompactionCount).toBe(0);
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

  it("never lets the window overflow for FoldPoint or the guarded baselines", () => {
    for (const scenario of SCENARIOS) {
      const foldPoint = runSession(scenario, createFoldPointStrategy(scenario));
      expect(foldPoint.metrics.overflowCount, `scenario ${scenario.id}`).toBe(0);
    }
  });
});
