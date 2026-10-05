import { describe, expect, it } from "vitest";
import { createRawFixedThresholdStrategy } from "../benchmarks/fixed-threshold";
import { SCENARIOS, type Scenario } from "../benchmarks/scenarios";
import { createFoldPointStrategy, runSession } from "../benchmarks/simulator";

const base = SCENARIOS[0];
if (!base) throw new Error("missing fixture");
const scenario: Scenario = {
  ...base,
  id: "hand-cycle",
  contextWindowTokens: 100000,
  steps: 2,
  startTokens: 20000,
  growthPerStep: 10000,
  growthJitter: 0,
  outputTokens: 0,
  idleMs: 1000,
  pricing: {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  cachePolicy: { ttlMs: 60000 },
  compactor: {
    retentionRatio: 0,
    retainedFloorTokens: 20000,
    outputRatio: 0,
    outputFloorTokens: 2000,
    successRate: 1,
  },
};

describe("complete simulator cycle billing", () => {
  it("rejects a forecast contract inconsistent with the simulator provider contract", () => {
    expect(() =>
      createFoldPointStrategy(scenario, {
        runtimeSurvival: {
          continuationProbability: 0.9,
          maxImmediateLossRatio: 1,
          cycleBilling: { summarySharedPrefixRatio: 0.8 },
        },
      }),
    ).toThrow(RangeError);
  });
  it("learns the tariff separately from summary cache usage, avoiding a second discount", () => {
    const prior = [100000, 200000, 300000].map((beforeTokens) => ({
      beforeTokens,
      afterTokens: 20000,
      outputTokens: 2000,
      summaryInputCostPerToken: 3e-6,
    }));
    const s = { ...scenario, startTokens: 68000, cycleBilling: { summarySharedPrefixRatio: 1 } };
    const predictions: { predictedCost: number; actualCost: number }[] = [];
    const base = createFoldPointStrategy(s, {
      learnedCompactorTokens: true,
      compactorHistory: prior,
      verifiedAppendOnlyPrefix: true,
      omitRequestCacheEvidence: true,
      runtimeSurvival: {
        continuationProbability: 0.9,
        maxImmediateLossRatio: 1,
        cycleBilling: s.cycleBilling,
      },
      onCompactorPrediction: (a) => predictions.push(a),
    });
    // Dispatch every attempt solely to exercise feedback; this is not an evaluated policy.
    runSession(s, {
      ...base,
      decide: (r) => {
        base.decide(r);
        return { action: "FORCE" };
      },
    });
    expect(predictions[1]?.predictedCost).toBeCloseTo(0.066, 12);
    expect(predictions[1]?.actualCost).toBeCloseTo(0.066, 12);
  });
  it("bills actual shared summary plus prewarm then an ordinary read, with a reconciling shadow", () => {
    const s = {
      ...scenario,
      cycleBilling: { summarySharedPrefixRatio: 1, prewarmOutputTokens: 1 },
    };
    let ordinary = 0,
      summary = 0,
      warm = 0;
    const strategy = {
      ...createRawFixedThresholdStrategy(0.4),
      onRequest: (e: { cost: number }) => {
        ordinary += e.cost;
      },
      onCompaction: (e: { cost: number; summaryInputCostPerToken?: number }) => {
        summary += e.cost;
        expect(e.summaryInputCostPerToken).toBe(3e-6);
      },
      onPrewarm: (e: { cost: number }) => {
        warm += e.cost;
      },
    };
    const run = runSession(s, strategy);
    expect(summary).toBeCloseTo(0.069, 12);
    expect(warm).toBeCloseTo(0.075015, 12);
    expect(ordinary).toBeCloseTo(0.1125 + 0.006, 12);
    expect(run.metrics.totalSimulatedCost).toBeCloseTo(0.262515, 12);
    expect(run.metrics.totalSimulatedCost).toBeCloseTo(summary + warm + ordinary, 12);
    expect(run.extraRequests).toEqual({ prewarmCount: 1, prewarmCost: warm });
    expect(run.compactions[0]?.realizedSaving).toBeCloseTo(0.039 - 0.069 - 0.075015 - 0.006, 12);
  });
  it("failed summaries are charged but do not create a prewarm or reset ordinary cache", () => {
    const run = runSession(
      {
        ...scenario,
        compactor: { ...scenario.compactor, successRate: 0 },
        cycleBilling: { summarySharedPrefixRatio: 1, prewarmOutputTokens: 1 },
      },
      createRawFixedThresholdStrategy(0.4),
    );
    expect(run.metrics.totalSimulatedCost).toBeCloseTo(0.1125 + 0.069 + 0.039, 12);
    expect(run.extraRequests?.prewarmCount).toBe(0);
    expect(run.compactions[0]?.realizedSaving).toBeNull();
  });
  it("TTL-expired summaries pay writes, not a fictitious shared-prefix hit", () => {
    const run = runSession(
      { ...scenario, idleMs: 90000, cycleBilling: { summarySharedPrefixRatio: 1 } },
      createRawFixedThresholdStrategy(0.4),
    );
    expect(run.compactions[0]?.attemptCost).toBeCloseTo(40000 * 3.75e-6 + 2000 * 15e-6, 12);
  });
  it("empty billing contract preserves historical bills without new requests", () => {
    const old = runSession(scenario, createRawFixedThresholdStrategy(0.4));
    const explicit = runSession(
      { ...scenario, cycleBilling: {} },
      createRawFixedThresholdStrategy(0.4),
    );
    expect(explicit.metrics.totalSimulatedCost).toBe(old.metrics.totalSimulatedCost);
    expect(explicit.compactions).toEqual(old.compactions);
    expect(old).not.toHaveProperty("extraRequests");
  });
  it("prewarm does not count as ordinary work or a duration continuation", () => {
    const prior = [100000, 200000, 300000].map((beforeTokens) => ({
      beforeTokens,
      afterTokens: 20000,
      outputTokens: 2000,
      summaryInputCostPerToken: 3e-6,
    }));
    const ages: number[] = [];
    const s = {
      ...scenario,
      cycleBilling: { summarySharedPrefixRatio: 1, prewarmOutputTokens: 1 },
      startTokens: 68000,
      steps: 4,
    };
    runSession(
      s,
      createFoldPointStrategy(s, {
        learnedCompactorTokens: true,
        compactorHistory: prior,
        warmCoreFromHistory: true,
        verifiedAppendOnlyPrefix: true,
        omitRequestCacheEvidence: true,
        runtimeSurvival: {
          continuationProbability: 0.9,
          maxImmediateLossRatio: 1,
          compactorTokenModel: undefined,
          cycleBilling: s.cycleBilling,
          durationModel: {
            completedCalls: 0,
            components: [
              { weight: 0.8, continuationProbability: 0.8 },
              { weight: 0.2, continuationProbability: 0.98 },
            ],
          },
        },
        onSurvivalEstimate: (e) => ages.push(e.expectedCallsIncludingCurrent),
      }),
    );
    expect(ages).toHaveLength(4);
    expect(ages[0]).toBeCloseTo(14);
    expect(ages[1]).toBeCloseTo((0.8 * 0.8 * 5 + 0.2 * 0.98 * 50) / (0.8 * 0.8 + 0.2 * 0.98));
  });
});
