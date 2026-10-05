import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compactorCases, type compactorModelReport } from "../benchmarks/compactor-model";
import {
  type executionConsistencyReport,
  renderExecution,
} from "../benchmarks/execution-consistency";
import { createFoldPointStrategy, runSession } from "../benchmarks/simulator";
import { estimateRuntimeSurvival, FoldPoint } from "../src/index";

describe("forecast execution constraints", () => {
  const input = {
    sessionId: "gates",
    timestamp: 1,
    contextTokens: 500000,
    reusablePrefixTokens: 480000,
    profile: {
      model: "gates",
      compactorId: "gates",
      contextWindowTokens: 1000000,
      pricing: {
        inputPerMillion: 2,
        outputPerMillion: 10,
        cacheReadPerMillion: 0.2,
        cacheWritePerMillion: 2.5,
      },
    },
  };
  const options = {
    continuationProbability: 0.95,
    maxImmediateLossRatio: 1,
    rolloutMode: "renewal" as const,
    savingMarginBasis: "timing" as const,
  };
  const constraints = {
    hasAttempt: false,
    minCallsBetweenCompactions: 3,
    minReclaimTokens: 4096,
    minReclaimRatio: 0.2,
    softWindowTokens: 0,
  };
  it("blocks an infeasible planned NOW without weakening the actual core safety action", () => {
    const baseline = new FoldPoint().decide(input);
    const result = estimateRuntimeSurvival(input, baseline, {
      ...options,
      executionConstraints: { ...constraints, hasAttempt: true },
    });
    expect(result.shouldCompact).toBe(false);
    expect(result.waitOneAvailable).toBe(false);
    expect(result.forecastCooldownBlocks).toBeGreaterThan(0);
    const safety = new FoldPoint().decide({ ...input, contextTokens: 750000 });
    expect(safety.action).toBe("FORCE");
  });
  it("refuses predicted no-reclaim even when the core ratio prior expects a reclaim", () => {
    const baseline = new FoldPoint().decide(input);
    const result = estimateRuntimeSurvival(input, baseline, {
      ...options,
      executionConstraints: constraints,
      compactorTokenModel: {
        after: { slope: 1, intercept: 0, residual: 0 },
        output: { slope: 0, intercept: 1, residual: 0 },
        samples: 3,
        minBefore: 100000,
        maxBefore: 600000,
        summaryInputCostPerToken: 0.000002,
      },
    });
    expect(result.shouldCompact).toBe(false);
    expect(result.waitOneAvailable).toBe(false);
    expect(result.forecastReclaimBlocks).toBeGreaterThan(0);
  });
  it("validates host gates rather than silently inventing their defaults", () => {
    const baseline = new FoldPoint().decide(input);
    expect(() =>
      estimateRuntimeSurvival(input, baseline, {
        ...options,
        executionConstraints: { ...constraints, minCallsBetweenCompactions: -1 },
      }),
    ).toThrow();
    expect(() =>
      estimateRuntimeSurvival(input, baseline, {
        ...options,
        executionConstraints: { ...constraints, minReclaimRatio: 2 },
      }),
    ).toThrow();
  });
  it("counts ordinary calls after NOW and bills the cooldown path by hand", () => {
    const baseline = new FoldPoint().decide(input);
    baseline.metrics.estimatedGrowthTokensPerCall = 20000;
    const result = estimateRuntimeSurvival(input, baseline, {
      ...options,
      maxCalls: 4,
      retentionStress: 0,
      probabilityStress: 0,
      executionConstraints: { ...constraints, minCallsBetweenCompactions: 99 },
      compactorTokenModel: {
        after: { slope: 0, intercept: 10000, residual: 0 },
        output: { slope: 0, intercept: 0, residual: 0 },
        samples: 3,
        minBefore: 100000,
        maxBefore: 600000,
        summaryInputCostPerToken: 0,
      },
    });
    // Summary itself is free in this hand fixture, not in the real experiment.
    // After NOW: write 10k, then 20k tails plus the previous prefix each ordinary call.
    expect(result.compactNowCost).toBeCloseTo(
      0.025 + 0.95 * 0.042 + 0.95 ** 2 * 0.046 + 0.95 ** 3 * 0.05,
    );
    expect(result.forecastCooldownBlocks).toBe(3);
  });
  it("settles prediction audit after actual successful results, not future fixture output", () => {
    const base = compactorCases()[0];
    if (!base) throw new Error("missing fixture");
    let settled = 0;
    const scenario = { ...base, steps: 45 };
    const run = runSession(
      scenario,
      createFoldPointStrategy(scenario, {
        learnedCompactorTokens: true,
        enforceForecastExecutionGates: true,
        runtimeSurvival: options,
        onCompactorPrediction: (a) => {
          expect(Number.isFinite(a.predictedCost)).toBe(true);
          expect(a.actualAfter).toBeGreaterThanOrEqual(0);
          settled++;
        },
      }),
    );
    expect(settled).toBeGreaterThan(0);
    expect(settled).toBe(run.metrics.successfulCompactionCount);
  });
  it("preserves previous bills, identical growth, 60% comparator and all negative outcomes", () => {
    const report = JSON.parse(
      readFileSync(
        new URL("../benchmarks/reports/execution-consistency.json", import.meta.url),
        "utf8",
      ),
    ) as ReturnType<typeof executionConsistencyReport>;
    const old = JSON.parse(
      readFileSync(new URL("../benchmarks/reports/compactor-model.json", import.meta.url), "utf8"),
    ) as ReturnType<typeof compactorModelReport>;
    expect(report.rows).toHaveLength(192);
    for (const row of report.rows) {
      const previous = old.rows.find((r) => r.profile === row.profile && r.id === row.id);
      expect(row.arms.previous?.cost).toBeCloseTo(previous?.arms.learned?.cost ?? NaN, 10);
      expect(row.arms.fixed60?.cost).toBeCloseTo(previous?.arms.fixed60?.cost ?? NaN, 10);
      expect(new Set(Object.values(row.arms).map((a) => a.fingerprint)).size).toBe(1);
      expect(Object.values(row.arms).every((a) => a.overflow === 0)).toBe(true);
    }
    expect(
      report.summary.every((s) => s.baseline === "fixed60" && s.wins + s.losses + s.ties === 8),
    ).toBe(true);
    expect(report.paidCalls).toBe(0);
    expect(
      readFileSync(new URL("../benchmarks/execution-consistency.md", import.meta.url), "utf8"),
    ).toBe(renderExecution(report));
  });
});
