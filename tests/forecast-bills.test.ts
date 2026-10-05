import { describe, expect, it } from "vitest";
import { estimateRuntimeSurvival, FoldPoint, type FoldPointInput } from "../src/index";

const input: FoldPointInput = {
  sessionId: "bill-audit",
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
  compactorTokenModel: {
    after: { slope: 0, intercept: 20000, residual: 0 },
    output: { slope: 0, intercept: 2000, residual: 0 },
    samples: 3,
    minBefore: 50000,
    maxBefore: 200000,
    summaryInputCostPerToken: 3e-6,
  },
};
function baseline() {
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
}
describe("optional selected-policy bill explanations", () => {
  it("does not change any existing estimate or decision field", () => {
    const original = estimateRuntimeSurvival(input, baseline(), options);
    const { forecastBills, ...explained } = estimateRuntimeSurvival(input, baseline(), {
      ...options,
      explainBills: true,
    });
    expect(explained).toEqual(original);
    expect(original).not.toHaveProperty("forecastBills");
    expect(forecastBills).toBeDefined();
  });
  it("hand reconciles summaries, replay and survival weights separately", () => {
    const r = estimateRuntimeSurvival(input, baseline(), { ...options, explainBills: true });
    const bills = r.forecastBills;
    if (!bills) throw new Error("missing bills");
    expect(bills.now.summaryCost).toBeCloseTo(0.18, 12);
    expect(bills.now.ordinaryInputCost).toBeCloseTo(0.075 + 0.9 * 0.036 + 0.81 * 0.039, 12);
    expect(bills.wait.ordinaryInputCost).toBeCloseTo(0.042 + 0.9 * 0.045 + 0.81 * 0.048, 12);
    for (const [name, expected] of [
      ["now", r.compactNowCost],
      ["wait", r.bestWaitCost],
    ] as const) {
      const b = bills[name];
      expect(b.ordinaryInputCost + b.summaryCost + b.prewarmCost).toBeCloseTo(expected, 12);
      expect(b.expectedOrdinaryCalls).toBeCloseTo(1 + 0.9 + 0.81, 12);
      for (const key of ["ordinaryInputCost", "summaryCost", "prewarmCost"] as const)
        expect(b.steps.reduce((n, s) => n + s.survival * s[key], 0)).toBeCloseTo(b[key], 12);
    }
  });
  it("charges a separate prewarm request without advancing ordinary-call survival", () => {
    const r = estimateRuntimeSurvival(input, baseline(), {
      ...options,
      explainBills: true,
      cycleBilling: { summarySharedPrefixRatio: 0.8, prewarmOutputTokens: 1 },
    });
    const b = r.forecastBills?.now;
    if (!b) throw new Error("missing bill");
    expect(b.prewarmCost).toBeCloseTo(20000 * 3.75e-6 + 15e-6, 12);
    expect(b.expectedPrewarmCalls).toBe(1);
    expect(b.expectedSummaryCalls).toBe(1);
    expect(b.expectedOrdinaryCalls).toBeCloseTo(2.71, 12);
    expect(b.ordinaryInputCost + b.summaryCost + b.prewarmCost).toBeCloseTo(r.compactNowCost, 12);
  });
  it("keeps stressed and common-continuation choices unchanged and explains selected nominal WAIT", () => {
    const opts = {
      ...options,
      probabilityStress: 0.05,
      retentionStress: 0.05,
      renewalComparison: "shared-wait-continuation" as const,
    };
    const old = estimateRuntimeSurvival(input, baseline(), opts);
    const { forecastBills, ...r } = estimateRuntimeSurvival(input, baseline(), {
      ...opts,
      explainBills: true,
    });
    expect(r).toEqual(old);
    expect(forecastBills?.wait.summaryCost).toBe(0);
  });
  it("rejects ambiguous or invalid explanation semantics", () => {
    expect(() =>
      estimateRuntimeSurvival(input, baseline(), {
        ...options,
        explainBills: true,
        stressWaitSelection: undefined,
      }),
    ).toThrow(RangeError);
    expect(() =>
      estimateRuntimeSurvival(input, baseline(), {
        ...options,
        explainBills: "yes" as unknown as boolean,
      }),
    ).toThrow(RangeError);
  });
});
