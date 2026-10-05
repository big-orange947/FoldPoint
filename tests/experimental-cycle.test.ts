import { describe, expect, it } from "vitest";
import type { CompactorTokenModel } from "../src/experimental-compactor";
import {
  cycleBill,
  postCompactBill,
  stableCycleCandidates,
  summaryBill,
  thresholdCycleAverage,
} from "../src/experimental-cycle";
import { estimateRuntimeSurvival, FoldPoint, type FoldPointInput } from "../src/index";
import { resolveUnitPrices } from "../src/pricing";

const prices = resolveUnitPrices({
  inputPerMillion: 3,
  outputPerMillion: 15,
  cacheReadPerMillion: 0.3,
  cacheWritePerMillion: 3.75,
});
const model: CompactorTokenModel = {
  after: { slope: 0, intercept: 20000, residual: 0 },
  output: { slope: 0, intercept: 2000, residual: 0 },
  samples: 3,
  minBefore: 100000,
  maxBefore: 600000,
  summaryInputCostPerToken: 3e-6,
};

describe("experimental warm-cycle billing", () => {
  it("hand bills summaries, ordinary reads/tails and one prefix rebuild", () => {
    const row = cycleBill(prices, model, 20000, 3, 10000, {});
    expect(row.summaryCost).toBeCloseTo(0.18, 12);
    expect(row.ordinaryCost).toBeCloseTo(0.075 + 0.036 + 0.039, 12);
    expect(row.total).toBeCloseTo(0.33, 12);
    expect(row.costPerOrdinaryCall).toBeCloseTo(0.11, 12);
    expect(row.summaryCalls).toBe(1);
    expect(row.prewarmCalls).toBe(0);
  });
  it("summary cache sharing is explicit, not a silently free summary", () => {
    const row = cycleBill(prices, model, 20000, 3, 10000, { summarySharedPrefixRatio: 1 });
    expect(row.summaryCost).toBeCloseTo(0.012 + 0.03 + 0.03, 12);
    expect(row.total).toBeCloseTo(0.222, 12);
    expect(
      summaryBill(prices, model, 50000, 40000, 0, { summarySharedPrefixRatio: 1 }),
    ).toBeCloseTo(0.1875 + 0.03, 12);
  });
  it("prewarm is an extra billed request followed by an ordinary cache read", () => {
    const row = cycleBill(prices, model, 20000, 3, 10000, {
      summarySharedPrefixRatio: 1,
      prewarmOutputTokens: 1,
    });
    expect(row.prewarmCost).toBeCloseTo(0.075 + 0.000015, 12);
    expect(row.ordinaryCost).toBeCloseTo(0.006 + 0.036 + 0.039, 12);
    expect(row.total).toBeCloseTo(0.228015, 12);
    expect(row.ordinaryCalls + row.summaryCalls + row.prewarmCalls).toBe(5);
    expect(row.costPerOrdinaryCall).toBeCloseTo(row.total / 3, 12);
  });
  it("ordinary output always costs money and absent cache discount gives no fake write premium", () => {
    const plain = resolveUnitPrices({
      inputPerMillion: 3,
      outputPerMillion: 15,
      cacheReadPerMillion: 3,
      cacheWritePerMillion: 9,
    });
    const cost = postCompactBill(plain, 20000, false, { prewarmOutputTokens: 1 });
    expect(cost.prewarm).toBeCloseTo(0.060015, 12);
    expect(cost.ordinary).toBeCloseTo(0.06, 12);
    const a = cycleBill(prices, model, 20000, 3, 10000, {}, 1000);
    expect(a.total).toBeCloseTo(0.33 + 0.045, 12);
  });
  it("solves affine stable cycles without an oracle task endpoint", () => {
    const affine = { ...model, after: { slope: 0.1, intercept: 20000, residual: 0 } };
    const rows = stableCycleCandidates(prices, affine, 10000, 700000, {});
    expect(rows[0]?.before).toBeCloseTo(50000 / 0.9, 8);
    for (const row of rows) expect(row.after).toBeCloseTo(row.before * 0.1 + 20000, 8);
    expect(rows.every((r) => r.before <= 700000 && r.ordinaryCalls >= 3)).toBe(true);
  });
  it("threshold reference reconciles a constant-size three-call cycle", () => {
    const result = thresholdCycleAverage(prices, model, 10000, 50000, {});
    expect(result.ordinaryCalls).toBe(3000);
    expect(result.costPerOrdinaryCall).toBeCloseTo(0.11, 12);
  });
  it("threshold reference weights alternating cycle lengths by ordinary work calls", () => {
    const affine = { ...model, after: { slope: 0.5, intercept: 0, residual: 0 } };
    let after = 50000;
    let total = 0;
    let calls = 0;
    const lengths = new Set<number>();
    for (let i = 0; i < 1100; i++) {
      const n = Math.max(3, Math.ceil((100000 - after) / 12000));
      const row = cycleBill(prices, affine, after, n, 12000, {});
      if (i >= 100) {
        total += row.total;
        calls += n;
        lengths.add(n);
      }
      after = row.before * 0.5;
    }
    expect(lengths.size).toBeGreaterThan(1);
    const result = thresholdCycleAverage(prices, affine, 12000, 100000, {});
    expect(result.ordinaryCalls).toBe(calls);
    expect(result.costPerOrdinaryCall).toBeCloseTo(total / calls, 12);
  });
  it("rejects malformed contracts and non-shrinking reference models", () => {
    for (const billing of [
      { summarySharedPrefixRatio: NaN },
      { summarySharedPrefixRatio: 1.1 },
      { prewarmOutputTokens: -1 },
      { prewarmOutputTokens: 0.5 },
    ])
      expect(() => cycleBill(prices, model, 20000, 3, 10000, billing)).toThrow(RangeError);
    expect(() =>
      stableCycleCandidates(
        prices,
        { ...model, after: { slope: 1, intercept: 0, residual: 0 } },
        10000,
        700000,
        {},
      ),
    ).toThrow(RangeError);
    expect(() => cycleBill(prices, model, 20000, 0, 10000, {})).toThrow(RangeError);
    expect(() =>
      stableCycleCandidates(
        prices,
        { ...model, after: { slope: NaN, intercept: 0, residual: 0 } },
        10000,
        700000,
        {},
      ),
    ).toThrow(RangeError);
    expect(() => thresholdCycleAverage(prices, model, 10000, 50000, {}, 0)).toThrow(RangeError);
  });
  it("bills prewarm again on repeated future safety compactions", () => {
    const input: FoldPointInput = {
      sessionId: "future",
      timestamp: 1,
      contextTokens: 50000,
      reusablePrefixTokens: 40000,
      profile: {
        model: "test",
        compactorId: "test",
        contextWindowTokens: 1000000,
        pricing: {
          inputPerMillion: 3,
          outputPerMillion: 15,
          cacheReadPerMillion: 0.3,
          cacheWritePerMillion: 3.75,
        },
      },
    };
    const baseline = new FoldPoint().decide(input);
    baseline.metrics.guardedForceBoundaryTokens = 50000;
    baseline.metrics.estimatedGrowthTokensPerCall = 10000;
    const options = {
      continuationProbability: 0.9,
      maxImmediateLossRatio: 100,
      maxCalls: 4,
      retentionStress: 0,
      compactorTokenModel: model,
    };
    const plain = estimateRuntimeSurvival(input, baseline, { ...options, cycleBilling: {} });
    const warm = estimateRuntimeSurvival(input, baseline, {
      ...options,
      cycleBilling: { prewarmOutputTokens: 1 },
    });
    expect(warm.compactNowCost - plain.compactNowCost).toBeCloseTo(0.006015 * (1 + 0.9 ** 3), 12);
  });
  it("opt-in runtime charges cache-aware summary plus separate prewarm, without changing old behavior", () => {
    const input: FoldPointInput = {
      sessionId: "cycle",
      timestamp: 1,
      contextTokens: 50000,
      reusablePrefixTokens: 40000,
      profile: {
        model: "test",
        compactorId: "test",
        contextWindowTokens: 1000000,
        pricing: {
          inputPerMillion: 3,
          outputPerMillion: 15,
          cacheReadPerMillion: 0.3,
          cacheWritePerMillion: 3.75,
        },
      },
    };
    const baseline = new FoldPoint().decide(input);
    const options = {
      continuationProbability: 0,
      maxImmediateLossRatio: 100,
      maxCalls: 1,
      retentionStress: 0,
      compactorTokenModel: model,
    };
    const old = estimateRuntimeSurvival(input, baseline, options);
    const explicit = estimateRuntimeSurvival(input, baseline, { ...options, cycleBilling: {} });
    expect(explicit.compactNowCost).toBe(old.compactNowCost);
    const billing = { summarySharedPrefixRatio: 1, prewarmOutputTokens: 1 };
    const result = estimateRuntimeSurvival(input, baseline, { ...options, cycleBilling: billing });
    const expected =
      summaryBill(
        prices,
        model,
        50000,
        40000,
        baseline.metrics.estimatedCacheAliveProbability,
        billing,
      ) +
      0.075015 +
      0.006;
    expect(result.compactNowCost).toBeCloseTo(expected, 12);
    expect(() =>
      estimateRuntimeSurvival(input, baseline, {
        ...options,
        compactorTokenModel: undefined,
        cycleBilling: billing,
      }),
    ).toThrow(RangeError);
  });
});
