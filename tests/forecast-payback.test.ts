import { describe, expect, it } from "vitest";
import { estimateRuntimeSurvival, FoldPoint, type FoldPointInput } from "../src/index";

const input: FoldPointInput = {
  sessionId: "payback",
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
const options = {
  continuationProbability: 0.9,
  maxImmediateLossRatio: 100,
  maxCalls: 8,
  retentionStress: 0,
  probabilityStress: 0,
  savingMarginRatio: 0,
  compactorTokenModel: {
    after: { slope: 0, intercept: 20000, residual: 0 },
    output: { slope: 0, intercept: 2000, residual: 0 },
    samples: 3,
    minBefore: 50000,
    maxBefore: 200000,
    summaryInputCostPerToken: 3e-6,
  },
};

describe("single-cycle necessary forecast payback gate", () => {
  it("hand reconciles discounted savings only BEFORE the next KEEP safety action", () => {
    const old = estimateRuntimeSurvival(input, baseline(), options);
    const gate = estimateRuntimeSurvival(input, baseline(), {
      ...options,
      forecastPaybackGate: "single-cycle",
    });
    expect(gate.cyclePayback?.horizonCalls).toBe(3);
    expect(gate.cyclePayback?.nominalSaving).toBeCloseTo(
      0.042 - 0.18 - 0.075 + 0.009 * (0.9 + 0.81),
      12,
    );
    expect(gate.cyclePayback?.stressedSaving).toBe(gate.cyclePayback?.nominalSaving);
    expect(gate.cyclePayback?.allowed).toBe(false);
    expect(gate.shouldCompact).toBe(false);
    expect(gate.forecastPaybackBlocks).toBeGreaterThan(0);
    expect(old.waitOneAvailable).toBe(true);
    expect(gate.waitOneAvailable).toBe(false);
    expect(old).not.toHaveProperty("cyclePayback");
  });
  it("does not automatically reject a positive single-cycle bill", () => {
    const modified = {
      ...input,
      profile: {
        ...input.profile,
        pricing: {
          inputPerMillion: 3,
          outputPerMillion: 15,
          cacheWritePerMillion: 3.75,
          cacheReadPerMillion: 1,
        },
      },
    };
    const b = baseline();
    b.metrics.estimatedCurrentCallReplayCost = 0.07;
    const gate = estimateRuntimeSurvival(modified, b, {
      ...options,
      compactorTokenModel: { ...options.compactorTokenModel, summaryInputCostPerToken: 0 },
      forecastPaybackGate: "single-cycle",
    });
    expect(gate.cyclePayback?.nominalSaving).toBeCloseTo(0.07 - 0.03 - 0.075 + 0.03 * 1.71, 12);
    expect(gate.cyclePayback?.allowed).toBe(true);
  });
  it("single-call cycle cannot borrow a future saving", () => {
    const b = baseline();
    b.metrics.guardedForceBoundaryTokens = 51000;
    const gate = estimateRuntimeSurvival(input, b, {
      ...options,
      forecastPaybackGate: "single-cycle",
    });
    expect(gate.cyclePayback?.horizonCalls).toBe(1);
    expect(gate.cyclePayback?.nominalSaving).toBeCloseTo(0.042 - 0.18 - 0.075, 12);
  });
  it("charges the first appended request correctly when the summary leaves no readable prefix", () => {
    const zero = {
      ...options.compactorTokenModel,
      after: { slope: 0, intercept: 0, residual: 0 },
      output: { slope: 0, intercept: 0, residual: 0 },
    };
    const gate = estimateRuntimeSurvival(input, baseline(), {
      ...options,
      compactorTokenModel: zero,
      forecastPaybackGate: "single-cycle",
    });
    expect(gate.cyclePayback?.nominalSaving).toBeCloseTo(
      0.042 - 0.15 + 0.015 * 1.71 - 0.0075 * 0.9,
      12,
    );
  });
  it("keeps the complete counterfactual NOW summary bill and does not bypass execution eligibility", () => {
    const gate = estimateRuntimeSurvival(input, baseline(), {
      ...options,
      maxCalls: 1,
      forecastPaybackGate: "single-cycle",
    });
    expect(gate.compactNowCost).toBeCloseTo(0.18 + 0.075, 12);
    const unsafe = { ...input, safeBoundary: false };
    expect(
      estimateRuntimeSurvival(unsafe, baseline(), {
        ...options,
        forecastPaybackGate: "single-cycle",
      }).shouldCompact,
    ).toBe(false);
    expect(() =>
      estimateRuntimeSurvival(input, baseline(), {
        ...options,
        forecastPaybackGate: "unknown" as "single-cycle",
      }),
    ).toThrow(RangeError);
  });
});
