import { describe, expect, it } from "vitest";
import { estimateRuntimeSurvival, FoldPoint, type FoldPointInput } from "../src/index";

const input: FoldPointInput = {
  sessionId: "future-rule",
  timestamp: 1,
  contextTokens: 500000,
  reusablePrefixTokens: 478000,
  safeBoundary: true,
  compactionAllowed: true,
  runtimeStatus: "active",
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
  continuationProbability: 0.98,
  maxImmediateLossRatio: 1,
  maxCalls: 128,
  rolloutMode: "renewal" as const,
  stressWaitSelection: "paired-policy" as const,
  endingRiskMode: "survival-weighted" as const,
  endingLossBudgetRatio: 1,
  savingMarginBasis: "timing" as const,
  durationModel: {
    completedCalls: 20,
    components: [
      { weight: 0.8, continuationProbability: 0.8 },
      { weight: 0.2, continuationProbability: 0.98 },
    ],
  },
  executionConstraints: {
    hasAttempt: false,
    minCallsBetweenCompactions: 2,
    minReclaimTokens: 10000,
    minReclaimRatio: 0.1,
    softWindowTokens: 0,
  },
  compactorTokenModel: {
    after: { slope: 0.1, intercept: 20000, residual: 1000 },
    output: { slope: 0.002, intercept: 1000, residual: 100 },
    samples: 3,
    minBefore: 100000,
    maxBefore: 700000,
    summaryInputCostPerToken: 3e-6,
  },
  cycleBilling: {},
};
function baseline() {
  const b = new FoldPoint().decide(input);
  Object.assign(b.metrics, {
    guardedForceBoundaryTokens: 678000,
    estimatedGrowthTokensPerCall: 22000,
    estimatedCacheLaterCandidateTokens: 500000,
    estimatedCacheAliveProbability: 1,
    estimatedCacheLaterAliveProbability: 1,
    estimatedCurrentCallReplayCost: 478000 * 0.3e-6 + 22000 * 3e-6,
    estimatedPostCompactTokens: 70000,
  });
  return b;
}
describe("bounded selected-path incumbent qualification", () => {
  it("uses at most N depth-one checks per branch and explicitly retains unassessed attempts", () => {
    const r = estimateRuntimeSurvival(input, baseline(), {
      ...options,
      futureQualification: { maxChecksPerPath: 2 },
      explainBills: true,
    });
    const q = r.futureQualification;
    if (!q || !r.forecastBills) throw new Error("missing qualification");
    for (const arm of [q.now, q.wait]) {
      expect(arm.checks.length).toBeGreaterThan(0);
      expect(arm.checks.length).toBeLessThanOrEqual(2);
      expect(new Set(arm.checks.map((c) => c.call)).size).toBe(arm.checks.length);
      for (const c of arm.checks) {
        expect(c.completedCalls).toBe(20 + c.call);
        if (c.allowed) {
          expect(c.expectedSaving).toBeGreaterThan(c.requiredSaving);
          expect(c.stressedSaving).toBeGreaterThan(c.requiredSaving);
        }
      }
    }
    for (const [screen, bill, fallback] of [
      [q.now, r.forecastBills.now, q.nowSafetyFallback],
      [q.wait, r.forecastBills.wait, q.waitSafetyFallback],
    ] as const)
      for (const check of fallback ? [] : screen.checks)
        expect(bill.steps[check.call]?.compact).toBe(check.allowed);
    expect(r.compactNowCost).toBeCloseTo(Math.min(q.qualifiedNowCost, q.safetyNowCost), 10);
    expect(r.bestWaitCost).toBeCloseTo(Math.min(q.qualifiedWaitCost, q.safetyWaitCost), 10);
    for (const [arm, cost] of [
      [r.forecastBills.now, r.compactNowCost],
      [r.forecastBills.wait, r.bestWaitCost],
    ] as const)
      expect(arm.ordinaryInputCost + arm.summaryCost + arm.prewarmCost).toBeCloseTo(cost, 10);
    expect(r.futureQualification?.now.checks.some((c) => !c.allowed)).toBe(true);
  });
  it("retains incumbent selected cost and never mutates caller inputs", () => {
    const b = baseline();
    const original = structuredClone(b);
    const opts = structuredClone(options);
    const old = estimateRuntimeSurvival(input, b, options);
    const r = estimateRuntimeSurvival(input, b, {
      ...options,
      futureQualification: { maxChecksPerPath: 2 },
    });
    expect(r.futureQualification?.incumbentNowCost).toBe(old.compactNowCost);
    expect(r.futureQualification?.incumbentWaitCost).toBe(old.bestWaitCost);
    expect(b).toEqual(original);
    expect(options).toEqual(opts);
    expect(old).not.toHaveProperty("futureQualification");
  });
  it("keeps current disabled/idle/unsafe/cooldown and safety gates intact", () => {
    const opts = { ...options, futureQualification: { maxChecksPerPath: 1 } };
    for (const changed of [
      { ...input, safeBoundary: false },
      { ...input, compactionAllowed: false },
      { ...input, runtimeStatus: "idle" as const },
    ])
      expect(estimateRuntimeSurvival(changed, baseline(), opts).shouldCompact).toBe(false);
    const b = baseline();
    b.reasons.push("COOLDOWN_ACTIVE");
    expect(estimateRuntimeSurvival(input, b, opts).shouldCompact).toBe(false);
    b.action = "FORCE";
    expect(estimateRuntimeSurvival(input, b, opts).shouldCompact).toBe(false);
  });
  it("rejects ambiguous combinations, unsupported budgets and unbounded depth", () => {
    for (const count of [0, 5, 1.5, NaN])
      expect(() =>
        estimateRuntimeSurvival(input, baseline(), {
          ...options,
          futureQualification: { maxChecksPerPath: count },
        }),
      ).toThrow(RangeError);
    for (const extra of [
      { rolloutMode: "safety" as const },
      { stressWaitSelection: undefined },
      { executionConstraints: undefined },
      { compactorTokenModel: undefined },
      { remainingRuntimeLossBudget: 0 },
      { renewalComparison: "shared-wait-continuation" as const },
      { forecastPaybackGate: "single-cycle" as const },
    ])
      expect(() =>
        estimateRuntimeSurvival(input, baseline(), {
          ...options,
          ...extra,
          futureQualification: { maxChecksPerPath: 2 },
        }),
      ).toThrow(RangeError);
  });
  it("does not query impossible future ages and preserves one-call costs", () => {
    const opts = {
      ...options,
      durationModel: { completedCalls: 0, components: [{ weight: 1, continuationProbability: 0 }] },
      futureQualification: { maxChecksPerPath: 2 },
    };
    const r = estimateRuntimeSurvival(input, baseline(), opts);
    expect(r.futureQualification?.now.checks).toHaveLength(0);
    expect(r.futureQualification?.wait.checks).toHaveLength(0);
    expect(r.expectedCallsIncludingCurrent).toBe(1);
  });
  it("keeps cached summaries and independent prewarm fees in qualified bill totals", () => {
    const r = estimateRuntimeSurvival(input, baseline(), {
      ...options,
      cycleBilling: { summarySharedPrefixRatio: 0.8, prewarmOutputTokens: 1 },
      futureQualification: { maxChecksPerPath: 1 },
      explainBills: true,
    });
    if (!r.forecastBills) throw new Error("missing bills");
    for (const [bill, cost] of [
      [r.forecastBills.now, r.compactNowCost],
      [r.forecastBills.wait, r.bestWaitCost],
    ] as const) {
      expect(bill.ordinaryInputCost + bill.summaryCost + bill.prewarmCost).toBeCloseTo(cost, 10);
      expect(bill.expectedPrewarmCalls).toBe(bill.expectedSummaryCalls);
    }
    expect(r.forecastBills.now.prewarmCost).toBeGreaterThan(0);
  });
  it("also accepts future attempts that clear the incumbent economic gates", () => {
    const value = {
      ...input,
      profile: {
        ...input.profile,
        pricing: {
          inputPerMillion: 3,
          outputPerMillion: 15,
          cacheReadPerMillion: 3,
          cacheWritePerMillion: 3,
        },
      },
    };
    const b = baseline();
    b.metrics.estimatedCurrentCallReplayCost = 1.5;
    const r = estimateRuntimeSurvival(value, b, {
      ...options,
      maxCalls: 256,
      futureQualification: { maxChecksPerPath: 2 },
    });
    const checks = [
      ...(r.futureQualification?.now.checks ?? []),
      ...(r.futureQualification?.wait.checks ?? []),
    ];
    expect(checks.some((c) => c.allowed)).toBe(true);
    for (const c of checks.filter((c) => c.allowed)) {
      expect(c.expectedSaving).toBeGreaterThan(c.requiredSaving);
      expect(c.stressedSaving).toBeGreaterThan(c.requiredSaving);
    }
  });
});
