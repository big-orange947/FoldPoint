import { describe, expect, it } from "vitest";
import { compactorCases } from "../benchmarks/compactor-model";
import { cycleExecutionCase } from "../benchmarks/cycle-execution";
import { estimateRuntimeSurvival, FoldPoint, type FoldPointInput } from "../src/index";

const input: FoldPointInput = {
  sessionId: "common-policy",
  timestamp: 1,
  contextTokens: 50000,
  reusablePrefixTokens: 40000,
  profile: {
    model: "synthetic",
    compactorId: "fixture",
    contextWindowTokens: 1000000,
    pricing: {
      inputPerMillion: 3,
      outputPerMillion: 15,
      cacheReadPerMillion: 0.3,
      cacheWritePerMillion: 3.75,
    },
    cachePolicy: { ttlMs: 60000 },
  },
};
const options = {
  continuationProbability: 0.9,
  maxImmediateLossRatio: 100,
  maxCalls: 3,
  probabilityStress: 0,
  retentionStress: 0,
  savingMarginRatio: 0,
  rolloutMode: "renewal" as const,
  stressWaitSelection: "paired-policy" as const,
  renewalComparison: "shared-wait-continuation" as const,
  compactorTokenModel: {
    after: { slope: 0, intercept: 20000, residual: 0 },
    output: { slope: 0, intercept: 2000, residual: 0 },
    samples: 3,
    minBefore: 50000,
    maxBefore: 200000,
    summaryInputCostPerToken: 3e-6,
  },
};
const baseline = () => {
  const b = new FoldPoint().decide(input);
  Object.assign(b.metrics, {
    guardedForceBoundaryTokens: 80000,
    estimatedGrowthTokensPerCall: 10000,
    estimatedCacheLaterCandidateTokens: 50000,
    estimatedCacheAliveProbability: 1,
    estimatedCacheLaterAliveProbability: 1,
    estimatedCurrentCallReplayCost: 0.042,
    estimatedPostCompactTokens: 20000,
  });
  return b;
};

describe("common WAIT continuation one-step policy evaluation", () => {
  it("hand reconciles three calls without borrowing a different NOW continuation", () => {
    const r = estimateRuntimeSurvival(input, baseline(), options);
    // WAIT: 50k current .042, then 50k prefix + 10k tail .045,
    // then 60k prefix + 10k tail .048. No safety event before 80k.
    expect(r.bestWaitCost).toBeCloseTo(0.042 + 0.9 * 0.045 + 0.81 * 0.048, 12);
    // NOW: summary .18, rebuild .075; 20k prefix+10k tail .036, then .039.
    expect(r.compactNowCost).toBeCloseTo(0.18 + 0.075 + 0.9 * 0.036 + 0.81 * 0.039, 12);
    expect(r.expectedSaving).toBeCloseTo(r.bestWaitCost - r.compactNowCost, 12);
    expect(r.stressedSaving).toBeCloseTo(r.expectedSaving, 12);
    expect(r.selectedRepeatBoundaryTokens).toBe(r.stressWaitPolicy?.repeatBoundaryTokens);
    expect(r.commonContinuation?.repeatBoundaryTokens).toBe(r.selectedRepeatBoundaryTokens);
  });
  it("only changes the NOW continuation; WAIT, tariffs and risk inputs stay frozen", () => {
    for (const context of [100000, 300000, 500000, 650000]) {
      const value = { ...input, contextTokens: context, reusablePrefixTokens: context - 10000 };
      const b = new FoldPoint().decide(value);
      b.metrics.estimatedGrowthTokensPerCall = 22000;
      const comparison = {
        ...options,
        continuationProbability: 0.98,
        retentionStress: 0.05,
        probabilityStress: 0.05,
        compactorTokenModel: {
          ...options.compactorTokenModel,
          after: { slope: 0.1, intercept: 20000, residual: 0 },
        },
      };
      const old = estimateRuntimeSurvival(value, b, {
        ...comparison,
        maxCalls: 128,
        renewalComparison: undefined,
      });
      const r = estimateRuntimeSurvival(value, b, { ...comparison, maxCalls: 128 });
      for (const key of [
        "bestWaitCost",
        "immediateLoss",
        "stressedImmediateLoss",
        "immediateLossBudget",
        "requiredSaving",
        "eligible",
        "assessedEndingLoss",
      ] as const)
        expect(r[key]).toBe(old[key]);
      expect(r.commonContinuation?.independentlyOptimizedNowCost).toBe(old.compactNowCost);
      expect(r.commonContinuation?.independentlyOptimizedStressedNowCost).toBe(
        old.stressWaitPolicy?.stressedNowCost,
      );
      expect(r.compactNowCost).toBeGreaterThanOrEqual(old.compactNowCost - 1e-12);
      expect(r.stressWaitPolicy?.repeatBoundaryTokens).toBe(r.selectedRepeatBoundaryTokens);
      expect(r.expectedSaving).toBeCloseTo(r.bestWaitCost - r.compactNowCost, 12);
      expect(old).not.toHaveProperty("commonContinuation");
    }
  });
  it("does not bypass eligibility or a zero risk allowance", () => {
    const b = baseline();
    for (const v of [
      { ...input, safeBoundary: false },
      { ...input, compactionAllowed: false },
      { ...input, runtimeStatus: "idle" as const },
    ])
      expect(estimateRuntimeSurvival(v, b, options).shouldCompact).toBe(false);
    expect(
      estimateRuntimeSurvival(input, b, { ...options, remainingRuntimeLossBudget: 0 })
        .runtimeRiskAllowed,
    ).toBe(false);
  });
  it("rejects incompatible or unknown comparison semantics", () => {
    for (const extra of [
      { renewalComparison: "unknown" as "shared-wait-continuation" },
      { rolloutMode: "safety" as const },
      { stressWaitSelection: undefined },
      { forecastPaybackGate: "single-cycle" as const },
    ])
      expect(() => estimateRuntimeSurvival(input, baseline(), { ...options, ...extra })).toThrow(
        RangeError,
      );
  });
  it("keeps the first decision independent of the evaluation endpoint and bills separate prewarm calls", () => {
    const base = compactorCases().find((s) => s.id.startsWith("heldout-floor-180-"));
    if (!base) throw new Error("missing fixture");
    const scenario = {
      ...base,
      steps: 8,
      startTokens: 500000,
      cycleBilling: { summarySharedPrefixRatio: 0.8, prewarmOutputTokens: 1 },
    };
    const first = cycleExecutionCase(
      scenario,
      "paired-policy",
      undefined,
      "shared-wait-continuation",
    );
    const second = cycleExecutionCase(
      { ...scenario, steps: 12 },
      "paired-policy",
      undefined,
      "shared-wait-continuation",
    );
    expect(first.historyCost).toBe(second.historyCost);
    expect(first.audit.checkpoints[0]).toEqual(second.audit.checkpoints[0]);
    expect(first.audit.checkpoints[0]?.commonContinuation).toBeDefined();
    for (const arm of [first.fixed60, first.dynamic]) {
      expect(arm.cost).toBeCloseTo(arm.ordinaryCost + arm.summaryCost + arm.prewarmCost, 10);
      expect(arm.totalRequests).toBe(8 + arm.summaryCalls + arm.prewarmCalls);
      expect(arm.prewarmCalls).toBe(arm.compactions.filter((c) => c.success).length);
    }
  });
});
