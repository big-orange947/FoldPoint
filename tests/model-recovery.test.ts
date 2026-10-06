import { describe, expect, it } from "vitest";
import { createFoldPointStrategy, runSession } from "../benchmarks/simulator";
import { warmLengthCases } from "../benchmarks/warm-length-seed";
import type { CompactorModelAvailability } from "../src/index";

describe("explicit simulator model-unavailability handling", () => {
  it.each([500000, 750000])(
    "keeps economic forecasts off and preserves safety at %i tokens",
    (startTokens) => {
      const c = warmLengthCases()[0];
      if (!c) throw new Error("missing fixture");
      const scenario = { ...c.scenario, steps: 1, startTokens, growthPerStep: 0, growthJitter: 0 };
      const states: CompactorModelAvailability[] = [];
      const base = createFoldPointStrategy(scenario, {
        learnedCompactorTokens: true,
        recoverCompactorModel: true,
        enforceForecastExecutionGates: true,
        onCompactorAvailability: (s) => states.push(s),
        runtimeSurvival: {
          continuationProbability: 0.95,
          maxImmediateLossRatio: 1,
          rolloutMode: "renewal",
          stressWaitSelection: "paired-policy",
          futureQualification: { maxChecksPerPath: 2 },
          cycleBilling: scenario.cycleBilling,
        },
        onSurvivalEstimate: () => {
          throw new Error("unavailable forecasts must not be fabricated");
        },
      });
      const run = runSession(scenario, base);
      expect(states[0]?.source).toBe("unavailable");
      expect(run.metrics.economicAttemptCount).toBe(0);
      expect(run.metrics.forcedAttemptCount).toBe(startTokens === 750000 ? 1 : 0);
      expect(run.metrics.overflowCount).toBe(0);
    },
  );
  it("requires a learner for explicit recovery", () => {
    const c = warmLengthCases()[0];
    if (!c) throw new Error("missing fixture");
    expect(() => createFoldPointStrategy(c.scenario, { recoverCompactorModel: true })).toThrow(
      /requires learnedCompactorTokens/,
    );
  });
  it("does not let an audit callback mutate the model used by the controller", () => {
    const c = warmLengthCases()[0];
    if (!c) throw new Error("missing fixture");
    let observedIntercept: number | undefined;
    const scenario = { ...c.scenario, steps: 1 };
    const strategy = createFoldPointStrategy(scenario, {
      learnedCompactorTokens: true,
      recoverCompactorModel: true,
      compactorHistory: [100000, 200000, 300000].map((beforeTokens) => ({
        beforeTokens,
        afterTokens: 25000,
        outputTokens: 2000,
        summaryInputCostPerToken: 2e-6,
      })),
      runtimeSurvival: { continuationProbability: 0.95, maxImmediateLossRatio: 1 },
      onCompactorAvailability: (s) => {
        if (s.model) s.model.after.intercept = 999999;
      },
      onSurvivalSnapshot: (s) => {
        observedIntercept = s.options.compactorTokenModel?.after.intercept;
      },
    });
    runSession(scenario, strategy);
    expect(observedIntercept).toBe(25000);
  });
});
