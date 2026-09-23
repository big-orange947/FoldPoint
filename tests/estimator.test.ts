import { describe, expect, it } from "vitest";
import { computeBreakEvenCalls, decideFoldPoint, tokenOnlyPricing } from "../src/index";
import {
  BASE_TIMESTAMP,
  decideWith,
  expectAllMetricsFinite,
  HISTORY,
  makeInput,
  makeLearning,
  makeProfile,
  makeSession,
  profileWithCacheTtl,
  SESSION_HISTORY,
} from "./helpers";

describe("17.1 basic decisions", () => {
  it("1. low utilization with no meaningful gain -> KEEP", () => {
    const decision = decideWith({ contextTokens: 20_000, cachedTokens: 0 });

    expect(decision.action).toBe("KEEP");
    expect(decision.reasons).toContain("NO_POSITIVE_SAVING");
    expect(decision.metrics.utilization).toBeCloseTo(0.1, 10);
  });

  it("2. hard window ratio reached -> FORCE", () => {
    const decision = decideWith({ contextTokens: 185_000, cachedTokens: 180_000 });

    expect(decision.action).toBe("FORCE");
    expect(decision.reasons).toContain("HARD_WINDOW_RATIO");
    expect(decision.reasons).not.toContain("RESERVE_TOKENS_REACHED");
  });

  it("3. remaining window below the reserve -> FORCE", () => {
    const decision = decideWith(
      { contextTokens: 195_000, cachedTokens: 0 },
      {},
      {},
      {
        defaults: { hardWindowRatio: 0.99 },
      },
    );

    expect(decision.action).toBe("FORCE");
    expect(decision.reasons).toContain("RESERVE_TOKENS_REACHED");
    expect(decision.reasons).not.toContain("HARD_WINDOW_RATIO");
  });

  it("4. positive saving that repays inside the horizon -> COMPACT", () => {
    const decision = decideWith(
      {
        contextTokens: 150_000,
        cachedTokens: 140_000,
        idleMs: 600_000,
        profile: profileWithCacheTtl(300_000),
      },
      HISTORY,
      SESSION_HISTORY,
    );

    expect(decision.action).toBe("COMPACT");
    expect(decision.reasons).toContain("ECONOMIC_TRIGGER");
    expect(decision.reasons).toContain("BREAK_EVEN_WITHIN_HORIZON");
    expect(decision.reasons).toContain("CACHE_LIKELY_EXPIRED");
    expect(decision.metrics.breakEvenCalls).not.toBeNull();
    expect(decision.metrics.breakEvenCalls ?? 0).toBeLessThanOrEqual(
      decision.metrics.effectiveHorizonCalls,
    );
    expect(decision.metrics.adjustedNetSaving).toBeGreaterThan(0);
  });

  it("5. a compaction that can never repay itself -> KEEP", () => {
    const decision = decideWith(
      {
        contextTokens: 150_000,
        cachedTokens: 150_000,
        idleMs: 0,
        profile: profileWithCacheTtl(600_000),
      },
      { ...HISTORY, retentionSamples: 3, retentionRatioEma: 1, cacheCoverageRatioEma: 1 },
      SESSION_HISTORY,
      { defaults: { minReclaimTokens: 0, minReclaimRatio: 0 } },
    );

    expect(decision.metrics.estimatedReclaimTokens).toBe(0);
    expect(decision.metrics.estimatedSavingPerFutureCall).toBeLessThanOrEqual(0);
    expect(decision.metrics.breakEvenCalls).toBeNull();
    expect(decision.action).toBe("KEEP");
    expect(decision.reasons).toContain("NO_BREAK_EVEN");
  });
});

describe("decision output shape", () => {
  it("returns full metrics and a machine-readable reason list in every branch", () => {
    const decisions = [
      decideWith({ contextTokens: 20_000 }, {}, {}),
      decideWith(
        {
          contextTokens: 150_000,
          cachedTokens: 140_000,
          idleMs: 600_000,
          profile: profileWithCacheTtl(300_000),
        },
        HISTORY,
        SESSION_HISTORY,
      ),
      decideWith({ contextTokens: 195_000 }, {}, {}),
    ];

    expect(decisions.map((decision) => decision.action)).toEqual(["KEEP", "COMPACT", "FORCE"]);

    for (const decision of decisions) {
      expect(Array.isArray(decision.reasons)).toBe(true);
      expect(decision.reasons.length).toBeGreaterThan(0);
      expect(decision.confidence).toBeGreaterThanOrEqual(0);
      expect(decision.confidence).toBeLessThanOrEqual(1);
      expectAllMetricsFinite(decision);
      for (const reason of decision.reasons) {
        expect(typeof reason).toBe("string");
      }
    }
  });

  it("only returns nextCheckAtTokens for KEEP, and always above the current context", () => {
    const keep = decideWith({ contextTokens: 20_000 });
    const compact = decideWith(
      {
        contextTokens: 150_000,
        cachedTokens: 140_000,
        idleMs: 600_000,
        profile: profileWithCacheTtl(300_000),
      },
      HISTORY,
      SESSION_HISTORY,
    );
    const force = decideWith({ contextTokens: 195_000 });

    expect(keep.nextCheckAtTokens).toBeGreaterThan(20_000);
    expect(compact.nextCheckAtTokens).toBeUndefined();
    expect(force.nextCheckAtTokens).toBeUndefined();
  });

  it("does not mutate the states it is given", () => {
    const learning = makeLearning(HISTORY);
    const session = makeSession(SESSION_HISTORY);
    const input = makeInput({ contextTokens: 150_000, cachedTokens: 140_000 });
    const learningBefore = JSON.stringify(learning);
    const sessionBefore = JSON.stringify(session);

    decideFoldPoint(input, learning, session);

    expect(JSON.stringify(learning)).toBe(learningBefore);
    expect(JSON.stringify(session)).toBe(sessionBefore);
  });
});

describe("compaction call cost from usage ratios", () => {
  it("uses the cold-start usage ratios when nothing was learned", () => {
    const decision = decideWith({ contextTokens: 100_000, cachedTokens: 0 }, {}, {});

    // 100k prompt tokens at the input price + 12% output tokens at the output price.
    const expected = 100_000 * (3 / 1_000_000) + 12_000 * (15 / 1_000_000);
    expect(decision.metrics.estimatedCompactCallCost).toBeCloseTo(expected, 12);
  });

  it("scales a learned usage ratio to the current context instead of reusing an amount", () => {
    const learned = {
      compactPromptSamples: 2,
      compactPromptRatioEma: 1,
      compactOutputSamples: 2,
      compactOutputRatioEma: 0.1,
    };

    const small = decideWith({ contextTokens: 10_000, cachedTokens: 0 }, learned, {});
    const large = decideWith({ contextTokens: 100_000, cachedTokens: 0 }, learned, {});

    expect(small.metrics.estimatedCompactCallCost).toBeCloseTo(
      10_000 * (3 / 1_000_000) + 1_000 * (15 / 1_000_000),
      12,
    );
    expect(large.metrics.estimatedCompactCallCost).toBeCloseTo(
      small.metrics.estimatedCompactCallCost * 10,
      12,
    );
  });

  it("prices the compaction prompt at the current prices on every call", () => {
    const learned = {
      compactPromptSamples: 2,
      compactPromptRatioEma: 1,
      compactOutputSamples: 2,
      compactOutputRatioEma: 0.1,
    };
    const cheapProfile = makeProfile({ pricing: { inputPerMillion: 1, outputPerMillion: 5 } });
    const priceyProfile = makeProfile({ pricing: { inputPerMillion: 10, outputPerMillion: 50 } });

    const cheap = decideWith(
      { contextTokens: 100_000, cachedTokens: 0, profile: cheapProfile },
      learned,
      {},
    );
    const pricey = decideWith(
      { contextTokens: 100_000, cachedTokens: 0, profile: priceyProfile },
      learned,
      {},
    );

    expect(cheap.metrics.estimatedCompactCallCost).toBeCloseTo(
      100_000 * (1 / 1_000_000) + 10_000 * (5 / 1_000_000),
      12,
    );
    expect(pricey.metrics.estimatedCompactCallCost).toBeCloseTo(
      cheap.metrics.estimatedCompactCallCost * 10,
      12,
    );
  });

  it("applies the learned actual-cost scale to the modeled cost", () => {
    const learned = {
      compactPromptSamples: 2,
      compactPromptRatioEma: 1,
      compactOutputSamples: 2,
      compactOutputRatioEma: 0.1,
      compactCostScaleSamples: 2,
      compactCostScaleEma: 2,
    };
    const decision = decideWith({ contextTokens: 100_000, cachedTokens: 0 }, learned, {});

    const modeled = 100_000 * (3 / 1_000_000) + 10_000 * (15 / 1_000_000);
    expect(decision.metrics.estimatedCompactCallCost).toBeCloseTo(modeled * 2, 12);
  });

  it("falls back to normalized token cost when no price is configured", () => {
    const decision = decideFoldPoint(
      makeInput({
        profile: makeProfile({ pricing: undefined }),
        contextTokens: 100_000,
        cachedTokens: 50_000,
      }),
      makeLearning(HISTORY),
      makeSession(SESSION_HISTORY),
    );

    expectAllMetricsFinite(decision);
    expect(decision.metrics.estimatedKeepCost).toBeGreaterThan(0);
    expect(tokenOnlyPricing().inputPerMillion).toBe(1_000_000);
  });
});

describe("break-even algebra", () => {
  it("17.4 solves N * C = K + F + (N - 1) * L exactly", () => {
    const input = {
      currentReplayCost: 5,
      compactCallCost: 10,
      firstPostCompactReplayCost: 4,
      laterPostCompactReplayCost: 2,
    };

    const breakEven = computeBreakEvenCalls(input);

    expect(breakEven).toBe(4);
    // Keep(4) = 4 * 5 = 20, Compact(4) = 10 + 4 + 3 * 2 = 20.
    expect(4 * input.currentReplayCost).toBe(20);
    expect(
      input.compactCallCost +
        input.firstPostCompactReplayCost +
        3 * input.laterPostCompactReplayCost,
    ).toBe(20);
  });

  it("17.4 has the right sign on both sides of the break-even point", () => {
    const input = {
      currentReplayCost: 5,
      compactCallCost: 10,
      firstPostCompactReplayCost: 4,
      laterPostCompactReplayCost: 2,
    };
    const keepCost = (calls: number) => calls * input.currentReplayCost;
    const compactCost = (calls: number) =>
      input.compactCallCost +
      input.firstPostCompactReplayCost +
      (calls - 1) * input.laterPostCompactReplayCost;

    expect(compactCost(3)).toBeGreaterThan(keepCost(3));
    expect(compactCost(5)).toBeLessThan(keepCost(5));
    expect(compactCost(4)).toBe(keepCost(4));
  });

  it("returns null when there is no positive per-call saving", () => {
    expect(
      computeBreakEvenCalls({
        currentReplayCost: 2,
        compactCallCost: 10,
        firstPostCompactReplayCost: 4,
        laterPostCompactReplayCost: 2,
      }),
    ).toBeNull();
    expect(
      computeBreakEvenCalls({
        currentReplayCost: 2,
        compactCallCost: 10,
        firstPostCompactReplayCost: 4,
        laterPostCompactReplayCost: 5,
      }),
    ).toBeNull();
  });

  it("returns 0 when compacting is already not more expensive before the first call", () => {
    expect(
      computeBreakEvenCalls({
        currentReplayCost: 5,
        compactCallCost: 1,
        firstPostCompactReplayCost: 1,
        laterPostCompactReplayCost: 4,
      }),
    ).toBe(0);
  });
});

describe("confidence", () => {
  it("starts at the floor with no samples and grows with evidence", () => {
    const fresh = decideWith({ contextTokens: 100_000 }, {}, {});
    const learned = decideWith({ contextTokens: 100_000 }, HISTORY, SESSION_HISTORY);

    expect(fresh.confidence).toBeCloseTo(0.35, 10);
    expect(learned.confidence).toBeGreaterThan(fresh.confidence);
    expect(learned.confidence).toBeLessThanOrEqual(1);
  });

  it("counts compaction usage samples as evidence", () => {
    const withoutUsage = decideWith(
      { contextTokens: 100_000 },
      { compactPromptSamples: 0, compactOutputSamples: 0 },
      {},
    );
    const withUsage = decideWith(
      { contextTokens: 100_000 },
      { compactPromptSamples: 4, compactOutputSamples: 4 },
      {},
    );

    expect(withUsage.confidence).toBeGreaterThan(withoutUsage.confidence);
  });
});

describe("soft-window quick-payback policy guard", () => {
  it("caps the effective horizon below the soft window and relaxes it above", () => {
    const belowSoft = decideWith(
      { contextTokens: 100_000, cachedTokens: 0 },
      HISTORY,
      SESSION_HISTORY,
    );
    const aboveSoft = decideWith(
      { contextTokens: 150_000, cachedTokens: 0 },
      HISTORY,
      SESSION_HISTORY,
    );

    expect(belowSoft.metrics.utilization).toBeLessThan(0.65);
    expect(belowSoft.metrics.expectedFutureCalls).toBe(10);
    expect(belowSoft.metrics.effectiveHorizonCalls).toBe(3);
    expect(aboveSoft.metrics.effectiveHorizonCalls).toBe(10);
  });

  it("doubles the uncertainty penalty below the soft window", () => {
    const belowSoft = decideWith(
      { contextTokens: 150_000, cachedTokens: 0 },
      HISTORY,
      SESSION_HISTORY,
      {
        defaults: { softWindowRatio: 0.8 },
      },
    );
    const aboveSoft = decideWith(
      { contextTokens: 150_000, cachedTokens: 0 },
      HISTORY,
      SESSION_HISTORY,
      {
        defaults: { softWindowRatio: 0.5 },
      },
    );

    expect(belowSoft.metrics.estimatedNetSaving).toBeCloseTo(
      aboveSoft.metrics.estimatedNetSaving,
      12,
    );
    expect(belowSoft.metrics.adjustedNetSaving).toBeLessThan(aboveSoft.metrics.adjustedNetSaving);
  });

  it("does not use a context-regrowth heuristic any more", () => {
    const decision = decideWith(
      { contextTokens: 150_000, cachedTokens: 0 },
      HISTORY,
      SESSION_HISTORY,
    );

    expect("callsUntilRefill" in decision.metrics).toBe(false);
    expect(decision.metrics.effectiveHorizonCalls).toBe(decision.metrics.expectedFutureCalls);
  });

  it("derives idle time from the session state when the host does not provide it", () => {
    const decision = decideWith(
      {
        contextTokens: 100_000,
        cachedTokens: 90_000,
        timestamp: BASE_TIMESTAMP + 5_000,
        profile: profileWithCacheTtl(60_000),
      },
      HISTORY,
      { ...SESSION_HISTORY, lastRequestAt: BASE_TIMESTAMP },
    );

    expect(decision.metrics.estimatedCacheAliveProbability).toBe(1);
  });
});
