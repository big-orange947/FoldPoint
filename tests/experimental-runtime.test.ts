import { describe, expect, it } from "vitest";
import {
  estimateRuntimeSurvival,
  FoldPoint,
  type FoldPointInput,
  RuntimeContinuationLearner,
  RuntimeRiskBudget,
} from "../src/index";

const decideFoldPoint = (value: FoldPointInput) => new FoldPoint().decide(value);

const input: FoldPointInput = {
  sessionId: "test",
  timestamp: 1,
  contextTokens: 500_000,
  profile: {
    model: "test",
    compactorId: "test",
    contextWindowTokens: 1_000_000,
    pricing: { inputPerMillion: 1, outputPerMillion: 1, cacheReadPerMillion: 0.1 },
  },
};
const options = { continuationProbability: 0.9, maxImmediateLossRatio: 3, maxCalls: 8 };

describe("experimental geometric runtime survival", () => {
  it("renewal is bounded and preserves one-request billing with no future knowledge", () => {
    const baseline = decideFoldPoint(input);
    const old = estimateRuntimeSurvival(input, baseline, {
      ...options,
      continuationProbability: 0,
    });
    const next = estimateRuntimeSurvival(input, baseline, {
      ...options,
      continuationProbability: 0,
      rolloutMode: "renewal",
    });
    expect(next.rolloutCandidates).toBe(16);
    expect(next.compactNowCost).toBe(old.compactNowCost);
    expect(next.bestWaitCost).toBe(old.bestWaitCost);
    expect(next.selectedRepeatBoundaryTokens).toBeLessThanOrEqual(
      baseline.metrics.guardedForceBoundaryTokens,
    );
    expect(next.expectedSaving).toBe(next.bestWaitCost - next.compactNowCost);
  });
  it("requires explicit weighted-risk allowance and exposes the changed contract", () => {
    const baseline = decideFoldPoint(input);
    expect(() =>
      estimateRuntimeSurvival(input, baseline, { ...options, endingRiskMode: "survival-weighted" }),
    ).toThrow(RangeError);
    const weighted = estimateRuntimeSurvival(input, baseline, {
      ...options,
      endingRiskMode: "survival-weighted",
      endingLossBudgetRatio: 1,
    });
    expect(weighted.assessedEndingLoss).toBeCloseTo(
      Math.max(0.1 * weighted.immediateLoss, 0.15 * weighted.stressedImmediateLoss),
    );
    const ended = estimateRuntimeSurvival(input, baseline, {
      ...options,
      continuationProbability: 0,
      endingRiskMode: "survival-weighted",
      endingLossBudgetRatio: 1,
    });
    expect(ended.assessedEndingLoss).toBe(
      Math.max(ended.immediateLoss, ended.stressedImmediateLoss),
    );
    for (const endingLossBudgetRatio of [-1, 1.1, NaN])
      expect(() =>
        estimateRuntimeSurvival(input, baseline, {
          ...options,
          endingRiskMode: "survival-weighted",
          endingLossBudgetRatio,
        }),
      ).toThrow(RangeError);
  });
  it("weighted renewal does not bypass cumulative risk or unsafe eligibility", () => {
    const extra = {
      ...options,
      rolloutMode: "renewal" as const,
      endingRiskMode: "survival-weighted" as const,
      endingLossBudgetRatio: 1,
    };
    const result = estimateRuntimeSurvival(input, decideFoldPoint(input), {
      ...extra,
      remainingRuntimeLossBudget: 0,
    });
    expect(result.runtimeRiskAllowed).toBe(false);
    expect(result.shouldCompact).toBe(false);
    const unsafe = { ...input, safeBoundary: false };
    expect(estimateRuntimeSurvival(unsafe, decideFoldPoint(unsafe), extra).eligible).toBe(false);
  });
  it("at q=0 compares exactly one request, including summary and rebuild", () => {
    const baseline = decideFoldPoint(input);
    const result = estimateRuntimeSurvival(input, baseline, {
      ...options,
      continuationProbability: 0,
    });
    const m = baseline.metrics;
    expect(result.keepThenForceCost).toBe(m.estimatedCurrentCallReplayCost);
    expect(result.compactNowCost).toBe(
      m.estimatedCompactCallCost + m.estimatedFirstPostCompactReplayCost,
    );
    expect(result.expectedSaving).toBe(result.keepThenForceCost - result.compactNowCost);
    expect(result.shouldCompact).toBe(false);
    expect(result.probabilityReachForce).toBe(0);
  });
  it("weights calls by q^i, not by a mean horizon", () => {
    const baseline = decideFoldPoint(input);
    const m = {
      ...baseline.metrics,
      estimatedGrowthTokensPerCall: 0,
      estimatedCacheLaterCandidateTokens: 0,
      estimatedCacheLaterAliveProbability: 0,
    };
    const result = estimateRuntimeSurvival(
      input,
      { ...baseline, metrics: m },
      { ...options, maxCalls: 3, continuationProbability: 0.5 },
    );
    expect(result.keepThenForceCost).toBeCloseTo(0.5 * (1 + 0.5 + 0.25));
    expect(result.probabilityOfUnmodeledTail).toBe(0.125);
    expect(result.compactNowCost).toBeCloseTo(
      m.estimatedCompactCallCost + m.estimatedFirstPostCompactReplayCost * 1.75,
    );
  });
  it("bills a larger deferred summary when growth reaches the boundary", () => {
    const baseline = decideFoldPoint(input);
    const decision = {
      ...baseline,
      metrics: {
        ...baseline.metrics,
        guardedForceBoundaryTokens: 600_000,
        estimatedGrowthTokensPerCall: 100_000,
        estimatedCompactCallCost: 0.5,
        estimatedPostCompactTokens: 50_000,
        estimatedCacheLaterCandidateTokens: 0,
        estimatedCacheLaterAliveProbability: 0,
      },
    };
    const result = estimateRuntimeSurvival(input, decision, {
      ...options,
      maxCalls: 2,
      continuationProbability: 0.5,
    });
    expect(result.keepThenForceCost).toBeCloseTo(0.5 + 0.5 * (0.6 + 0.06));
    expect(result.probabilityReachForce).toBe(0.5);
  });
  it("respects eligibility, safety and the immediate-ending loss budget", () => {
    const baseline = decideFoldPoint(input);
    const noBudget = estimateRuntimeSurvival(input, baseline, {
      ...options,
      maxImmediateLossRatio: 0,
    });
    expect(noBudget.immediateLoss).toBeGreaterThan(0);
    expect(noBudget.shouldCompact).toBe(false);
    for (const changed of [
      { runtimeStatus: "idle" as const },
      { compactionAllowed: false },
      { safeBoundary: false },
    ]) {
      const next = { ...input, ...changed };
      expect(estimateRuntimeSurvival(next, decideFoldPoint(next), options).eligible).toBe(false);
    }
    const forced = { ...input, contextTokens: 750_000 };
    expect(decideFoldPoint(forced).action).toBe("FORCE");
    expect(estimateRuntimeSurvival(forced, decideFoldPoint(forced), options).shouldCompact).toBe(
      false,
    );
    const blocked = { ...baseline, reasons: ["COOLDOWN_ACTIVE" as const] };
    expect(estimateRuntimeSurvival(input, blocked, options).eligible).toBe(false);
  });
  it("is pure, bounded, and rejects invalid parameters", () => {
    const baseline = decideFoldPoint(input);
    const before = JSON.stringify({ input, baseline, options });
    expect(estimateRuntimeSurvival(input, baseline, options)).toEqual(
      estimateRuntimeSurvival(input, baseline, options),
    );
    expect(JSON.stringify({ input, baseline, options })).toBe(before);
    for (const value of [-1, 1, Number.NaN, Infinity])
      expect(() =>
        estimateRuntimeSurvival(input, baseline, { ...options, continuationProbability: value }),
      ).toThrow(RangeError);
    for (const maxCalls of [0, 257, 1.5])
      expect(() => estimateRuntimeSurvival(input, baseline, { ...options, maxCalls })).toThrow(
        RangeError,
      );
  });
  it("learns transitions only, handles right censoring, and requires explicit priors", () => {
    const learner = new RuntimeContinuationLearner(0.5, 2);
    learner.observeRuntime(4, true);
    expect(learner.report()).toEqual({ continued: 3, ended: 1, continuationProbability: 4 / 6 });
    learner.observeRuntime(3, false);
    expect(learner.report()).toEqual({ continued: 5, ended: 1, continuationProbability: 6 / 8 });
    learner.observeRuntime(0, true);
    expect(learner.report().ended).toBe(1);
    expect(() => learner.observeRuntime(-1, true)).toThrow(RangeError);
    expect(() => new RuntimeContinuationLearner(0.5, 0)).toThrow(RangeError);
  });
  it("does not turn a cache discount without prefix evidence into write premium", () => {
    const next = {
      ...input,
      profile: {
        ...input.profile,
        pricing: {
          inputPerMillion: 1,
          outputPerMillion: 1,
          cacheReadPerMillion: 0.1,
          cacheWritePerMillion: 10,
        },
      },
    };
    const baseline = decideFoldPoint(next);
    const result = estimateRuntimeSurvival(next, baseline, {
      ...options,
      continuationProbability: 0,
    });
    expect(result.compactNowCost).toBeCloseTo(
      baseline.metrics.estimatedCompactCallCost +
        baseline.metrics.estimatedFirstPostCompactReplayCost,
    );
  });
  it("refuses to treat a large omitted survival tail as an ended runtime", () => {
    const baseline = decideFoldPoint(input);
    const result = estimateRuntimeSurvival(input, baseline, {
      ...options,
      continuationProbability: 0.99,
      maxCalls: 64,
    });
    expect(result.probabilityOfUnmodeledTail).toBeGreaterThan(0.5);
    expect(result.shouldCompact).toBe(false);
  });
  it("can trigger when even the immediate request pays back", () => {
    const baseline = decideFoldPoint(input);
    const decision = {
      ...baseline,
      metrics: {
        ...baseline.metrics,
        estimatedCompactCallCost: 0.01,
      },
    };
    const result = estimateRuntimeSurvival(input, decision, {
      ...options,
      continuationProbability: 0,
      maxImmediateLossRatio: 0,
    });
    expect(result.immediateLoss).toBe(0);
    expect(result.stressedImmediateLoss).toBe(0);
    expect(result.shouldCompact).toBe(true);
  });
  it("prices repeated safety compactions rather than keeping NOW small forever", () => {
    const baseline = decideFoldPoint(input);
    const decision = {
      ...baseline,
      metrics: {
        ...baseline.metrics,
        estimatedCompactCallCost: 0.5,
        estimatedGrowthTokensPerCall: 200_000,
        guardedForceBoundaryTokens: 100_000,
        estimatedCacheLaterCandidateTokens: 0,
        estimatedCacheLaterAliveProbability: 0,
      },
    };
    const result = estimateRuntimeSurvival(input, decision, {
      ...options,
      continuationProbability: 0.5,
      maxCalls: 3,
    });
    expect(result.compactNowCost).toBeCloseTo(
      0.5 + 0.05 + 0.5 * (0.25 + 0.025) + 0.25 * (0.225 + 0.0225),
    );
    expect(result.keepThenForceCost).toBeCloseTo(0.5 + 0.5 * (0.7 + 0.07) + 0.25 * (0.27 + 0.027));
  });
  it("compares waiting one call against force-only waiting with exact weighted billing", () => {
    const baseline = decideFoldPoint(input);
    const decision = {
      ...baseline,
      metrics: {
        ...baseline.metrics,
        estimatedCompactCallCost: 0.5,
        estimatedCacheLaterCandidateTokens: 0,
        estimatedCacheLaterAliveProbability: 0,
        estimatedGrowthTokensPerCall: 0,
      },
    };
    const result = estimateRuntimeSurvival(input, decision, {
      ...options,
      continuationProbability: 0.5,
      maxCalls: 3,
    });
    expect(result.waitOneAvailable).toBe(true);
    expect(result.waitOneThenCompactCost).toBeCloseTo(0.5 + 0.5 * (0.5 + 0.05) + 0.25 * 0.05);
    expect(result.bestWaitCost).toBeCloseTo(result.waitOneThenCompactCost);
    const old = estimateRuntimeSurvival(input, decision, {
      ...options,
      continuationProbability: 0.5,
      maxCalls: 3,
      allowWaitOne: false,
    });
    expect(result.expectedSaving).toBeLessThan(old.expectedSaving);
    expect(old.bestWaitCost).toBe(old.keepThenForceCost);
  });
  it("checks prospective waiting risk and cumulative budget without changing safety", () => {
    const baseline = decideFoldPoint(input);
    const blocked = estimateRuntimeSurvival(input, baseline, {
      ...options,
      remainingRuntimeLossBudget: 0,
    });
    expect(blocked.runtimeRiskAllowed).toBe(false);
    expect(blocked.waitOneAvailable).toBe(false);
    expect(blocked.shouldCompact).toBe(false);
    const allowed = estimateRuntimeSurvival(input, baseline, {
      ...options,
      remainingRuntimeLossBudget: 1,
    });
    expect(allowed.runtimeRiskAllowed).toBe(true);
    for (const budget of [-1, NaN, Infinity])
      expect(() =>
        estimateRuntimeSurvival(input, baseline, {
          ...options,
          remainingRuntimeLossBudget: budget,
        }),
      ).toThrow(RangeError);
  });
  it("preserves q=0 and single-call semantics for the new wait alternative", () => {
    const baseline = decideFoldPoint(input);
    const onlyOne = estimateRuntimeSurvival(input, baseline, { ...options, maxCalls: 1 });
    expect(onlyOne.waitOneAvailable).toBe(false);
    expect(onlyOne.bestWaitCost).toBe(onlyOne.keepThenForceCost);
    const ended = estimateRuntimeSurvival(input, baseline, {
      ...options,
      continuationProbability: 0,
    });
    expect(ended.waitOneThenCompactCost).toBe(ended.keepThenForceCost);
  });
  it("charges runtime risk cumulatively without refunds and exposes failed cost overruns", () => {
    const ledger = new RuntimeRiskBudget(1);
    ledger.charge(0.3);
    ledger.charge(0.4);
    expect(ledger.report().remaining).toBeCloseTo(0.3);
    expect(ledger.report().spent).toBeCloseTo(0.7);
    expect(ledger.report().overBudget).toBe(false);
    ledger.charge(1);
    expect(ledger.report()).toEqual({ budget: 1, spent: 1.7, remaining: 0, overBudget: true });
    expect(new RuntimeRiskBudget(1).report().spent).toBe(0);
    expect(() => ledger.charge(-1)).toThrow(RangeError);
    expect(() => new RuntimeRiskBudget(Infinity)).toThrow(RangeError);
  });
  it("adding a feasible wait option cannot increase NOW's claimed advantage", () => {
    const baseline = decideFoldPoint(input);
    for (const growth of [0, 10_000, 100_000])
      for (const q of [0.5, 0.8, 0.95]) {
        const decision = {
          ...baseline,
          metrics: { ...baseline.metrics, estimatedGrowthTokensPerCall: growth },
        };
        const common = { continuationProbability: q, maxImmediateLossRatio: 3 };
        const before = estimateRuntimeSurvival(input, decision, { ...common, allowWaitOne: false });
        const after = estimateRuntimeSurvival(input, decision, common);
        expect(after.expectedSaving).toBeLessThanOrEqual(before.expectedSaving + 1e-12);
        expect(after.stressedSaving).toBeLessThanOrEqual(before.stressedSaving + 1e-12);
        if (after.shouldCompact) expect(before.shouldCompact).toBe(true);
      }
  });
});
