import { describe, expect, it } from "vitest";
import {
  decideFoldPoint,
  FoldPoint,
  type FoldPointDecision,
  type FoldPointProfileState,
  resolveDefaults,
} from "../src/index";
import {
  BASE_TIMESTAMP,
  decideWith,
  expectAllMetricsFinite,
  HISTORY,
  makeInput,
  makeProfile,
  makeState,
} from "./helpers";

function sweep(values: number[], build: (value: number) => FoldPointDecision): FoldPointDecision[] {
  return values.map((value) => build(value));
}

describe("17.5 numeric edges", () => {
  it("25. handles an empty context", () => {
    const decision = decideWith({ contextTokens: 0, cachedTokens: 0 });

    expectAllMetricsFinite(decision);
    expect(decision.metrics.utilization).toBe(0);
    expect(decision.metrics.remainingTokens).toBe(200_000);
    expect(decision.action).toBe("KEEP");
    expect(decision.reasons).toContain("INSUFFICIENT_RECLAIM_TOKENS");
  });

  it("26. handles a context with no cached tokens", () => {
    const decision = decideWith({ contextTokens: 100_000, cachedTokens: 0 }, HISTORY);

    expectAllMetricsFinite(decision);
    expect(decision.metrics.estimatedKeepCost).toBeCloseTo(
      decision.metrics.expectedFutureCalls * 100_000 * (3 / 1_000_000),
      12,
    );
    expect(decision.metrics.estimatedSavingPerFutureCall).toBeGreaterThan(0);
  });

  it("27. handles a fully cached context", () => {
    const decision = decideWith({ contextTokens: 100_000, cachedTokens: 100_000 }, HISTORY);

    expectAllMetricsFinite(decision);
    expect(decision.metrics.estimatedCacheSurvival).toBeGreaterThan(0);
    expect(["KEEP", "COMPACT", "FORCE"]).toContain(decision.action);
  });

  it("28. forces when the context fills the window", () => {
    const decision = decideWith({ contextTokens: 200_000, cachedTokens: 0 });

    expect(decision.action).toBe("FORCE");
    expect(decision.reasons).toContain("HARD_WINDOW_RATIO");
    expect(decision.reasons).toContain("RESERVE_TOKENS_REACHED");
    expect(decision.metrics.remainingTokens).toBe(0);
    expectAllMetricsFinite(decision);
  });

  it("29. survives extreme prices without overflow", () => {
    const profile = makeProfile({
      pricing: { inputPerMillion: 1e15, outputPerMillion: 1e15, cacheReadPerMillion: 1e14 },
    });
    const decision = decideFoldPoint(
      makeInput({ profile, contextTokens: 100_000, cachedTokens: 50_000 }),
      makeState(HISTORY),
    );

    expectAllMetricsFinite(decision);
    expect(Number.isFinite(decision.metrics.estimatedNetSaving)).toBe(true);
  });

  it("30. survives a zero price without dividing by zero", () => {
    const profile = makeProfile({ pricing: { inputPerMillion: 0, outputPerMillion: 0 } });
    const decision = decideFoldPoint(
      makeInput({ profile, contextTokens: 100_000, cachedTokens: 50_000 }),
      makeState(HISTORY),
    );

    expectAllMetricsFinite(decision);
    expect(decision.metrics.estimatedSavingPerFutureCall).toBe(0);
    expect(decision.metrics.breakEvenCalls).toBeNull();
    expect(decision.action).toBe("KEEP");
  });

  it("31. reports no break-even when the per-call saving is not positive", () => {
    const decision = decideWith(
      { contextTokens: 100_000, cachedTokens: 100_000 },
      { ...HISTORY, retentionRatioEma: 1, retentionSamples: 2, cacheHitRatioEma: 1 },
      { defaults: { minReclaimTokens: 0, minReclaimRatio: 0 } },
    );

    expect(decision.metrics.estimatedSavingPerFutureCall).toBeLessThanOrEqual(0);
    expect(decision.metrics.breakEvenCalls).toBeNull();
  });

  it("32. throws on illegal input instead of silently repairing it", () => {
    const invalidInputs = [
      { contextTokens: -1 },
      { cachedTokens: -1 },
      { timestamp: -1 },
      { idleMs: -1 },
      { expectedFutureCalls: 0.5 },
      { contextTokens: Number.NaN },
      { profile: makeProfile({ contextWindowTokens: 0 }) },
      { profile: makeProfile({ pricing: { inputPerMillion: -1, outputPerMillion: 15 } }) },
      { profile: makeProfile({ model: "" }) },
      { profile: makeProfile({ compactorId: "" }) },
      { safeBoundary: "yes" as unknown as boolean },
      { compactionAllowed: "no" as unknown as boolean },
    ];

    for (const overrides of invalidInputs) {
      expect(
        () => decideFoldPoint(makeInput(overrides), makeState(HISTORY)),
        JSON.stringify(overrides),
      ).toThrow(RangeError);
    }
  });

  it("32b. throws on illegal options", () => {
    const invalidOptions = [
      { defaults: { emaAlpha: 0 } },
      { defaults: { emaAlpha: 1.5 } },
      { defaults: { softWindowRatio: 1.2 } },
      { defaults: { hardWindowRatio: 0.5 } },
      { defaults: { minReclaimTokens: -1 } },
      { defaults: { expectedFutureCalls: 0 } },
      { defaults: { softWindowPenaltyMultiplier: 0.5 } },
      { defaults: { notARealDefault: 1 } as never },
    ];

    for (const options of invalidOptions) {
      expect(
        () => decideWith({ contextTokens: 100_000 }, HISTORY, options),
        JSON.stringify(options),
      ).toThrow(RangeError);
    }
  });

  it("33. throws when cachedTokens exceed contextTokens", () => {
    expect(() => decideWith({ contextTokens: 100_000, cachedTokens: 100_001 })).toThrow(RangeError);
  });

  it("34. is deterministic for identical input and state", () => {
    const input = makeInput({
      contextTokens: 150_000,
      cachedTokens: 140_000,
      idleMs: 600_000,
      profile: makeProfile({ cachePolicy: { ttlMs: 300_000 } }),
    });
    const state = makeState(HISTORY);

    const first = decideFoldPoint(input, state);
    const second = decideFoldPoint(input, state);
    const third = decideFoldPoint({ ...input }, { ...state });

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(state).toEqual(makeState(HISTORY));
  });
});

describe("17.6 monotonicity", () => {
  it("35. a larger context never lowers window pressure", () => {
    const decisions = sweep(
      [10_000, 50_000, 100_000, 150_000, 180_000, 190_000, 199_999, 200_000],
      (contextTokens) => decideWith({ contextTokens, cachedTokens: 0 }, HISTORY),
    );

    for (let index = 1; index < decisions.length; index += 1) {
      const previous = decisions[index - 1];
      const current = decisions[index];
      if (!previous || !current) {
        throw new Error("missing decision");
      }
      expect(current.metrics.utilization).toBeGreaterThanOrEqual(previous.metrics.utilization);
      expect(current.metrics.remainingTokens).toBeLessThanOrEqual(previous.metrics.remainingTokens);
      if (previous.action === "FORCE") {
        expect(current.action).toBe("FORCE");
      }
    }
  });

  it("36. more cached tokens never make keeping the context more expensive", () => {
    const decisions = sweep([0, 20_000, 60_000, 100_000, 140_000, 150_000], (cachedTokens) =>
      decideWith({ contextTokens: 150_000, cachedTokens }, HISTORY),
    );

    for (let index = 1; index < decisions.length; index += 1) {
      const previous = decisions[index - 1];
      const current = decisions[index];
      if (!previous || !current) {
        throw new Error("missing decision");
      }
      expect(current.metrics.estimatedKeepCost).toBeLessThanOrEqual(
        previous.metrics.estimatedKeepCost,
      );
    }
  });

  it("37. a worse retention ratio never makes compaction more attractive", () => {
    const decisions = sweep([0.1, 0.25, 0.4, 0.6, 0.8, 0.95, 1], (retentionRatioEma) =>
      decideWith(
        { contextTokens: 150_000, cachedTokens: 40_000 },
        { ...HISTORY, retentionSamples: 2, retentionRatioEma },
      ),
    );

    for (let index = 1; index < decisions.length; index += 1) {
      const previous = decisions[index - 1];
      const current = decisions[index];
      if (!previous || !current) {
        throw new Error("missing decision");
      }
      expect(current.metrics.estimatedReclaimTokens).toBeLessThanOrEqual(
        previous.metrics.estimatedReclaimTokens,
      );
      expect(current.metrics.estimatedNetSaving).toBeLessThanOrEqual(
        previous.metrics.estimatedNetSaving,
      );
    }
  });

  it("38. a higher compaction cost never lowers the break-even call count", () => {
    const decisions = sweep([0.01, 0.05, 0.2, 0.5, 1, 5], (compactionCostEma) =>
      decideWith(
        { contextTokens: 150_000, cachedTokens: 40_000 },
        { ...HISTORY, compactionCostSamples: 3, compactionCostEma },
      ),
    );

    for (let index = 1; index < decisions.length; index += 1) {
      const previous = decisions[index - 1];
      const current = decisions[index];
      if (!previous || !current) {
        throw new Error("missing decision");
      }
      expect(previous.metrics.breakEvenCalls).not.toBeNull();
      expect(current.metrics.breakEvenCalls).not.toBeNull();
      expect(current.metrics.breakEvenCalls ?? 0).toBeGreaterThanOrEqual(
        previous.metrics.breakEvenCalls ?? 0,
      );
    }
  });

  it("39. a longer horizon never makes a positive-saving compaction harder to trigger", () => {
    const decisions = sweep([1, 2, 4, 8, 16, 64], (horizon) =>
      decideWith(
        { contextTokens: 150_000, cachedTokens: 40_000 },
        { ...HISTORY, horizonSamples: 2, reuseHorizonEma: horizon },
      ),
    );

    for (let index = 1; index < decisions.length; index += 1) {
      const previous = decisions[index - 1];
      const current = decisions[index];
      if (!previous || !current) {
        throw new Error("missing decision");
      }
      expect(current.metrics.adjustedNetSaving).toBeGreaterThanOrEqual(
        previous.metrics.adjustedNetSaving,
      );
      if (previous.action === "COMPACT") {
        expect(current.action).toBe("COMPACT");
      }
    }
  });

  it("40. idle time past the TTL never raises cache survival", () => {
    const profile = makeProfile({ cachePolicy: { ttlMs: 60_000 } });
    const decisions = sweep([0, 1_000, 30_000, 59_999, 60_000, 120_000, 600_000], (idleMs) =>
      decideWith({ contextTokens: 150_000, cachedTokens: 140_000, idleMs, profile }, HISTORY),
    );

    for (let index = 1; index < decisions.length; index += 1) {
      const previous = decisions[index - 1];
      const current = decisions[index];
      if (!previous || !current) {
        throw new Error("missing decision");
      }
      expect(current.metrics.estimatedCacheSurvival).toBeLessThanOrEqual(
        previous.metrics.estimatedCacheSurvival,
      );
    }
  });

  it("41. a higher minimum reclaim never increases the number of COMPACT decisions", () => {
    const thresholds = [0, 1_000, 4_096, 16_384, 50_000, 100_000, 112_000, 112_500, 200_000];
    const actions = thresholds.map(
      (minReclaimTokens) =>
        decideWith(
          {
            contextTokens: 150_000,
            cachedTokens: 140_000,
            idleMs: 600_000,
            profile: makeProfile({ cachePolicy: { ttlMs: 300_000 } }),
          },
          HISTORY,
          { defaults: { minReclaimTokens } },
        ).action,
    );

    const compactCounts = actions.map((action) => (action === "COMPACT" ? 1 : 0));
    for (let index = 1; index < compactCounts.length; index += 1) {
      expect(compactCounts[index] ?? 0).toBeLessThanOrEqual(compactCounts[index - 1] ?? 0);
    }
    expect(compactCounts[0]).toBe(1);
    expect(compactCounts[compactCounts.length - 1]).toBe(0);
  });

  it("keeps every metric finite across a wide parameter sweep", () => {
    const stateVariants: Partial<FoldPointProfileState>[] = [
      {},
      { retentionSamples: 1, retentionRatioEma: 0.05 },
      { retentionSamples: 9, retentionRatioEma: 1 },
      { cacheSamples: 4, cacheHitRatioEma: 1 },
      { horizonSamples: 4, reuseHorizonEma: 50 },
      { compactionCostSamples: 4, compactionCostEma: 0 },
      HISTORY,
    ];
    const contextTokens = [0, 1, 1_000, 99_999, 150_000, 199_999, 200_000, 250_000];
    const cachedTokens = [0, 1, 50_000, 199_999, 250_000];

    for (const state of stateVariants) {
      for (const context of contextTokens) {
        for (const cached of cachedTokens) {
          const decision = decideWith(
            { contextTokens: context, cachedTokens: Math.min(cached, context) },
            state,
          );
          expectAllMetricsFinite(decision);
        }
      }
    }
  });
});

describe("horizon caps and growth learning", () => {
  it("caps the effective horizon below the soft window", () => {
    const belowSoft = decideWith({ contextTokens: 100_000, cachedTokens: 0 }, HISTORY);
    const aboveSoft = decideWith({ contextTokens: 150_000, cachedTokens: 0 }, HISTORY);

    expect(belowSoft.metrics.utilization).toBeLessThan(0.65);
    expect(belowSoft.metrics.expectedFutureCalls).toBe(10);
    expect(belowSoft.metrics.effectiveHorizonCalls).toBe(3);
    expect(aboveSoft.metrics.effectiveHorizonCalls).toBe(10);
  });

  it("caps the effective horizon by the time the context needs to regrow", () => {
    const decision = decideWith(
      { contextTokens: 150_000, cachedTokens: 0 },
      {
        ...HISTORY,
        retentionSamples: 3,
        retentionRatioEma: 0.4,
        growthSamples: 4,
        growthPerCallEma: 30_000,
      },
    );

    // 60% of 150k is reclaimed, and 30k is added per call: the context is back in 3 calls.
    expect(decision.metrics.callsUntilRefill).toBeCloseTo(3, 6);
    expect(decision.metrics.effectiveHorizonCalls).toBeCloseTo(3, 6);
  });

  it("does not cap the horizon when the context is not growing", () => {
    const decision = decideWith(
      { contextTokens: 150_000, cachedTokens: 0 },
      { ...HISTORY, growthSamples: 5, growthPerCallEma: 0 },
    );

    expect(decision.metrics.callsUntilRefill).toBeNull();
    expect(decision.metrics.effectiveHorizonCalls).toBe(10);
  });

  it("learns the growth rate from request observations and ignores shrinking prompts", () => {
    const foldPoint = new FoldPoint();
    const profile = makeProfile();

    foldPoint.observeRequest(profile, { timestamp: BASE_TIMESTAMP, promptTokens: 100_000 });
    expect(foldPoint.getProfileState(profile).growthSamples).toBe(0);

    foldPoint.observeRequest(profile, { timestamp: BASE_TIMESTAMP + 1, promptTokens: 110_000 });
    expect(foldPoint.getProfileState(profile).growthSamples).toBe(1);
    expect(foldPoint.getProfileState(profile).growthPerCallEma).toBeCloseTo(2_500, 6);

    // A compaction shrank the prompt: that says nothing about the growth rate.
    foldPoint.observeRequest(profile, { timestamp: BASE_TIMESTAMP + 2, promptTokens: 40_000 });
    expect(foldPoint.getProfileState(profile).growthSamples).toBe(1);
    expect(foldPoint.getProfileState(profile).lastPromptTokens).toBe(40_000);
  });

  it("memoizes and freezes the resolved defaults", () => {
    expect(resolveDefaults()).toBe(resolveDefaults());
    expect(Object.isFrozen(resolveDefaults())).toBe(true);
    expect(resolveDefaults({ emaAlpha: 0.5 })).not.toBe(resolveDefaults());
  });
});
