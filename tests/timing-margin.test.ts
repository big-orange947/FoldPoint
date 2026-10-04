import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRawFixedThresholdStrategy } from "../benchmarks/fixed-threshold";
import { runSession, simulatedCompactorOutput } from "../benchmarks/simulator";
import { renderTiming, timingCases, type timingMarginReport } from "../benchmarks/timing-margin";
import { estimateRuntimeSurvival, FoldPoint } from "../src/index";

describe("differential timing margin", () => {
  const input = {
    sessionId: "margin-test",
    timestamp: 1,
    contextTokens: 500000,
    reusablePrefixTokens: 480000,
    profile: {
      model: "test",
      compactorId: "test",
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
    maxCalls: 64,
    rolloutMode: "renewal" as const,
    endingRiskMode: "survival-weighted" as const,
    endingLossBudgetRatio: 1,
  };
  it("changes only the margin scale, not billed paths, risk, survival or pressure costs", () => {
    const baseline = new FoldPoint({ defaults: { compactOutputRatio: 0.002 } }).decide(input);
    baseline.metrics.estimatedGrowthTokensPerCall = 20000;
    const old = estimateRuntimeSurvival(input, baseline, options);
    const next = estimateRuntimeSurvival(input, baseline, {
      ...options,
      savingMarginBasis: "timing",
    });
    expect(next.compactNowCost).toBe(old.compactNowCost);
    expect(next.bestWaitCost).toBe(old.bestWaitCost);
    expect(next.stressedSaving).toBe(old.stressedSaving);
    expect(next.assessedEndingLoss).toBe(old.assessedEndingLoss);
    expect(next.waitOneAvailable).toBe(true);
    expect(next.savingMarginCostScale).toBeCloseTo(
      baseline.metrics.estimatedCurrentCallReplayCost +
        (20000 * baseline.metrics.estimatedCompactCallCost) / input.contextTokens,
    );
    expect(next.requiredSaving).toBeCloseTo(0.1 * next.savingMarginCostScale);
    expect(next.savingMarginCostScale).toBeLessThan(old.savingMarginCostScale);
    if (old.shouldCompact) expect(next.shouldCompact).toBe(true);
  });
  it("falls back without a feasible wait-one, and does not bypass risk or safety", () => {
    const baseline = new FoldPoint().decide(input);
    const e = estimateRuntimeSurvival(input, baseline, {
      ...options,
      maxCalls: 1,
      savingMarginBasis: "timing",
    });
    expect(e.waitOneAvailable).toBe(false);
    expect(e.savingMarginCostScale).toBe(baseline.metrics.estimatedCompactCallCost);
    expect(() =>
      estimateRuntimeSurvival(input, baseline, {
        ...options,
        rolloutMode: "safety",
        savingMarginBasis: "timing",
      }),
    ).toThrow(RangeError);
    const blocked = estimateRuntimeSurvival(input, baseline, {
      ...options,
      remainingRuntimeLossBudget: 0,
      savingMarginBasis: "timing",
    });
    expect(blocked.shouldCompact).toBe(false);
    expect(blocked.runtimeRiskAllowed).toBe(false);
  });
  it("keeps seen cases and freezes eight new combinations without endpoint hints", () => {
    const cases = timingCases();
    expect(cases).toHaveLength(79);
    expect(cases.filter((s) => s.id.startsWith("heldout-margin-")).length).toBe(8);
    expect(cases.filter((s) => s.id.startsWith("heldout-floor-")).length).toBe(8);
    for (const s of cases) expect(s.hostHorizon).toBeUndefined();
  });
  it("bills a fixed output floor even when the retained floor prevents shrinking", () => {
    const base = timingCases()[0];
    if (!base) throw new Error("Missing fixture");
    const scenario = {
      ...base,
      steps: 2,
      startTokens: 10000,
      growthPerStep: 5000,
      growthJitter: 0,
      pricing: { inputPerMillion: 2, outputPerMillion: 10 },
      compactor: {
        retentionRatio: 0.1,
        outputRatio: 0.002,
        successRate: 1,
        retainedFloorTokens: 50000,
        outputFloorTokens: 2000,
      },
    };
    expect(simulatedCompactorOutput(scenario, 20000)).toEqual({
      afterTokens: 20000,
      outputTokens: 2000,
    });
    expect(simulatedCompactorOutput(scenario, 600000)).toEqual({
      afterTokens: 60000,
      outputTokens: 2000,
    });
    const run = runSession(scenario, createRawFixedThresholdStrategy(0));
    expect(run.compactions).toHaveLength(2);
    for (const c of run.compactions) {
      expect(c.afterTokens).toBe(c.beforeTokens);
      expect(c.attemptCost).toBeCloseTo(c.beforeTokens * 2e-6 + 2000 * 10e-6, 12);
    }
    expect(() =>
      simulatedCompactorOutput(
        { ...scenario, compactor: { ...scenario.compactor, retainedFloorTokens: -1 } },
        20000,
      ),
    ).toThrow(RangeError);
  });
  it("reconciles complete fees, fair growth, failures and generated documentation", () => {
    const report = JSON.parse(
      readFileSync(new URL("../benchmarks/reports/timing-margin.json", import.meta.url), "utf8"),
    ) as ReturnType<typeof timingMarginReport>;
    expect(report.rows).toHaveLength(632);
    expect(report.paidCalls).toBe(0);
    expect(readFileSync(new URL("../benchmarks/timing-margin.md", import.meta.url), "utf8")).toBe(
      renderTiming(report),
    );
    for (const r of report.rows) {
      expect(new Set(Object.values(r.arms).map((a) => a.fingerprint)).size).toBe(1);
      for (const a of Object.values(r.arms)) {
        const b = a.costBreakdown;
        if (!b) throw new Error("Missing breakdown");
        expect(
          b.summaryCost +
            b.firstPostCompactInputCost +
            b.otherOrdinaryInputCost +
            b.ordinaryOutputCost,
        ).toBeCloseTo(a.cost, 9);
      }
    }
    for (const s of report.summary) {
      expect(s.wins + s.losses + s.ties).toBe(s.compared);
      expect(s.compared + s.excluded).toBe(s.cases);
    }
  });
});
