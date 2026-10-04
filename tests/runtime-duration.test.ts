import { describe, expect, it } from "vitest";
import { DURATION_PRIOR } from "../benchmarks/duration-mixture";
import { createFoldPointStrategy, runSession } from "../benchmarks/simulator";
import { warmCases } from "../benchmarks/warm-renewal";
import { estimateRuntimeDuration, estimateRuntimeSurvival, FoldPoint } from "../src/index";

describe("conditional runtime duration", () => {
  it("extending an unseen task endpoint cannot change its already observed action prefix", () => {
    const base = warmCases()[0];
    if (!base) throw new Error("Missing fixture");
    const common = { ...base, startTokens: 520000, growthPerStep: 35000, growthJitter: 0 };
    const options = {
      verifiedAppendOnlyPrefix: true,
      omitRequestCacheEvidence: true,
      runtimeSurvival: {
        continuationProbability: 0.95,
        maxImmediateLossRatio: 1,
        maxCalls: 256,
        rolloutMode: "renewal" as const,
        endingRiskMode: "survival-weighted" as const,
        endingLossBudgetRatio: 1,
        durationModel: { completedCalls: 0, components: DURATION_PRIOR },
      },
    };
    const short = { ...common, steps: 10 };
    const long = { ...common, steps: 20 };
    const a = runSession(short, createFoldPointStrategy(short, options));
    const b = runSession(long, createFoldPointStrategy(long, options));
    expect(
      b.compactions.filter((c) => c.step < 10).map((c) => [c.step, c.action, c.beforeTokens]),
    ).toEqual(a.compactions.map((c) => [c.step, c.action, c.beforeTokens]));
  });
  it("matches hand-computed conditional survival, not current q to the kth power", () => {
    const components = [
      { weight: 1, continuationProbability: 0.5 },
      { weight: 1, continuationProbability: 0.9 },
    ];
    const e = estimateRuntimeDuration({ completedCalls: 2, components }, 8, 0);
    const slow = 0.81 / 1.06;
    expect(e.posterior[1]).toBeCloseTo(slow);
    expect(e.survival[0]).toBeCloseTo(1);
    expect(e.survival[2]).toBeCloseTo((1 - slow) * 0.25 + slow * 0.81);
    expect(e.survival[2]).not.toBeCloseTo((e.survival[1] ?? 0) ** 2, 5);
    expect(e.expectedCallsIncludingCurrent).toBeCloseTo((1 - slow) * 2 + slow * 10);
    expect(e.stressedSurvival).toEqual(e.survival);
  });
  it("is stable under long histories, validates priors and shifts stress to shorter durations", () => {
    for (const completedCalls of [0, 5, 50, 100000]) {
      const e = estimateRuntimeDuration({ completedCalls, components: DURATION_PRIOR }, 256);
      expect(e.posterior.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
      for (let i = 0; i <= 256; i++) {
        expect(e.survival[i]).toBeGreaterThanOrEqual(0);
        expect(e.stressedSurvival[i] ?? Infinity).toBeLessThanOrEqual((e.survival[i] ?? 0) + 1e-12);
      }
    }
    expect(() =>
      estimateRuntimeDuration({ completedCalls: -1, components: DURATION_PRIOR }),
    ).toThrow(RangeError);
    for (const components of [
      [],
      [{ weight: 0, continuationProbability: 0.5 }],
      [{ weight: 1, continuationProbability: 1 }],
      [{ weight: 1, continuationProbability: NaN }],
    ])
      expect(() => estimateRuntimeDuration({ completedCalls: 0, components })).toThrow(RangeError);
    expect(() =>
      estimateRuntimeDuration({
        completedCalls: 1,
        components: [{ weight: 1, continuationProbability: 0 }],
      }),
    ).toThrow(RangeError);
  });
  it("single-component unstressed mode preserves geometric costs and tail", () => {
    const input = {
      sessionId: "duration-test",
      timestamp: 1,
      contextTokens: 500000,
      profile: {
        model: "test",
        compactorId: "test",
        contextWindowTokens: 1000000,
        pricing: { inputPerMillion: 1, outputPerMillion: 4, cacheReadPerMillion: 0.1 },
      },
    };
    const baseline = new FoldPoint().decide(input);
    const options = {
      continuationProbability: 0.9,
      maxImmediateLossRatio: 1,
      maxCalls: 64,
      probabilityStress: 0,
    };
    const old = estimateRuntimeSurvival(input, baseline, options);
    const next = estimateRuntimeSurvival(input, baseline, {
      ...options,
      durationModel: {
        completedCalls: 10,
        components: [{ weight: 1, continuationProbability: 0.9 }],
      },
    });
    expect(next.compactNowCost).toBeCloseTo(old.compactNowCost, 12);
    expect(next.bestWaitCost).toBeCloseTo(old.bestWaitCost, 12);
    expect(next.probabilityOfUnmodeledTail).toBeCloseTo(old.probabilityOfUnmodeledTail, 12);
    expect(next.shouldCompact).toBe(old.shouldCompact);
  });
  it("constant age is an explicit ablation, and a long omitted tail still blocks", () => {
    const base = warmCases()[0];
    if (!base) throw new Error("Missing fixture");
    const actual: number[] = [];
    runSession(
      { ...base, steps: 5 },
      createFoldPointStrategy(base, {
        advanceDurationAge: false,
        runtimeSurvival: {
          continuationProbability: 0.95,
          maxImmediateLossRatio: 1,
          durationModel: { completedCalls: 0, components: DURATION_PRIOR },
        },
        onSurvivalEstimate: (e) => actual.push(e.continuationProbabilityNext),
      }),
    );
    expect(actual).toHaveLength(5);
    for (const q of actual) expect(q).toBeCloseTo(0.836);
    const input = {
      sessionId: "tail",
      timestamp: 1,
      contextTokens: 500000,
      profile: {
        model: "test",
        compactorId: "test",
        contextWindowTokens: 1000000,
        pricing: { inputPerMillion: 1, outputPerMillion: 4 },
      },
    };
    const e = estimateRuntimeSurvival(input, new FoldPoint().decide(input), {
      continuationProbability: 0.95,
      maxImmediateLossRatio: 1,
      maxCalls: 64,
      durationModel: {
        completedCalls: 100,
        components: [{ weight: 1, continuationProbability: 0.999 }],
      },
    });
    expect(e.probabilityOfUnmodeledTail).toBeGreaterThan(0.9);
    expect(e.shouldCompact).toBe(false);
  });
  it("simulator advances age on ordinary requests only, not summaries or read-only decisions", () => {
    const base = warmCases()[0];
    if (!base) throw new Error("Missing fixture");
    const scenario = {
      ...base,
      startTokens: 600000,
      growthPerStep: 100000,
      growthJitter: 0,
      steps: 6,
    };
    const actual: number[] = [];
    runSession(
      scenario,
      createFoldPointStrategy(scenario, {
        verifiedAppendOnlyPrefix: true,
        omitRequestCacheEvidence: true,
        runtimeSurvival: {
          continuationProbability: 0.95,
          maxImmediateLossRatio: 1,
          durationModel: { completedCalls: 0, components: DURATION_PRIOR },
        },
        onSurvivalEstimate: (e) => actual.push(e.continuationProbabilityNext),
      }),
    );
    expect(actual).toHaveLength(6);
    for (let i = 0; i < actual.length; i++)
      expect(actual[i]).toBeCloseTo(
        estimateRuntimeDuration({ completedCalls: i, components: DURATION_PRIOR }).survival[1] ?? 0,
      );
  });
});
