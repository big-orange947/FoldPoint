import { describe, expect, it } from "vitest";
import { estimateRuntimeSurvival, FoldPoint, type FoldPointInput } from "../src/index";

const input: FoldPointInput = {
  sessionId: "paired",
  timestamp: 1,
  contextTokens: 500000,
  reusablePrefixTokens: 460000,
  profile: {
    model: "synthetic",
    compactorId: "fixture",
    contextWindowTokens: 1000000,
    pricing: {
      inputPerMillion: 0.3,
      outputPerMillion: 1.2,
      cacheReadPerMillion: 0.006,
      cacheWritePerMillion: 0.3,
    },
    cachePolicy: { ttlMs: 60000 },
  },
};
const options = {
  continuationProbability: 0.98,
  maxImmediateLossRatio: 1,
  maxCalls: 128,
  rolloutMode: "renewal" as const,
  endingRiskMode: "survival-weighted" as const,
  endingLossBudgetRatio: 1,
  savingMarginBasis: "timing" as const,
  compactorTokenModel: {
    after: { slope: 0.1, intercept: 20000, residual: 0 },
    output: { slope: 0, intercept: 2000, residual: 0 },
    samples: 3,
    minBefore: 100000,
    maxBefore: 600000,
    summaryInputCostPerToken: 3e-7,
  },
};

describe("paired nominal policy stress evaluation", () => {
  it("rejects unknown comparison semantics rather than silently selecting the old mode", () => {
    expect(() =>
      estimateRuntimeSurvival(input, new FoldPoint().decide(input), {
        ...options,
        stressWaitSelection: "unknown" as "paired-policy",
      }),
    ).toThrow(RangeError);
  });
  it("keeps nominal bills and all existing economic/risk inputs unchanged", () => {
    let observedDifference = false;
    for (const contextTokens of [150000, 300000, 500000, 650000])
      for (const growth of [10000, 22000, 41000]) {
        const value = { ...input, contextTokens, reusablePrefixTokens: contextTokens - growth };
        const baseline = new FoldPoint().decide(value);
        baseline.metrics.estimatedGrowthTokensPerCall = growth;
        const old = estimateRuntimeSurvival(value, baseline, options);
        const paired = estimateRuntimeSurvival(value, baseline, {
          ...options,
          stressWaitSelection: "paired-policy",
        });
        for (const field of [
          "compactNowCost",
          "bestWaitCost",
          "expectedSaving",
          "requiredSaving",
          "selectedRepeatBoundaryTokens",
          "immediateLossBudget",
          "assessedEndingLoss",
          "eligible",
          "runtimeRiskAllowed",
        ] as const)
          expect(paired[field]).toBe(old[field]);
        const policy = paired.stressWaitPolicy;
        if (!policy) throw new Error("missing selected WAIT audit");
        expect(policy.nominalCost).toBe(paired.bestWaitCost);
        expect(policy.stressedCost).toBeGreaterThanOrEqual(
          policy.independentlyOptimizedStressedCost - 1e-12,
        );
        expect(paired.stressedSaving).toBeCloseTo(policy.stressedCost - policy.stressedNowCost, 12);
        expect(old.stressedSaving).toBeCloseTo(
          policy.independentlyOptimizedStressedCost - policy.stressedNowCost,
          12,
        );
        if (paired.stressedSaving - old.stressedSaving > 1e-9) observedDifference = true;
        expect(old).not.toHaveProperty("stressWaitPolicy");
      }
    expect(observedDifference).toBe(true);
  });
  it("zero stress removes the selection difference", () => {
    const baseline = new FoldPoint().decide(input);
    const zero = { ...options, probabilityStress: 0, retentionStress: 0 };
    const old = estimateRuntimeSurvival(input, baseline, zero);
    const paired = estimateRuntimeSurvival(input, baseline, {
      ...zero,
      stressWaitSelection: "paired-policy",
    });
    expect(paired.stressedSaving).toBeCloseTo(old.stressedSaving, 12);
    expect(paired.shouldCompact).toBe(old.shouldCompact);
  });
  it("does not bypass disabled execution or immediate-ending risk", () => {
    for (const value of [
      { ...input, safeBoundary: false },
      { ...input, compactionAllowed: false },
    ])
      expect(
        estimateRuntimeSurvival(value, new FoldPoint().decide(value), {
          ...options,
          stressWaitSelection: "paired-policy",
        }).shouldCompact,
      ).toBe(false);
    const result = estimateRuntimeSurvival(input, new FoldPoint().decide(input), {
      ...options,
      stressWaitSelection: "paired-policy",
      remainingRuntimeLossBudget: 0,
    });
    expect(result.runtimeRiskAllowed).toBe(false);
    expect(result.shouldCompact).toBe(false);
  });
});
