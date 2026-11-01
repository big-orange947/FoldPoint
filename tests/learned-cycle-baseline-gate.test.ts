import { expect, it } from "vitest";
import { resolveUnitPrices } from "../src/pricing";
import { chooseWithBaselineGate } from "../tools/learned-cycle-baseline-gate";
import { executeLearnedReplay, type LearnedReplayWorld } from "../tools/learned-cycle-replay";
import { PiImmediateRetentionLearner } from "../tools/pi-retention-learner";

function fixture() {
  const binding = {
    profileBinding: "a".repeat(64),
    compactorBinding: "b".repeat(64),
    estimatorId: "host/v1",
  };
  const learner = new PiImmediateRetentionLearner(binding, {
    beforeErrorTokens: 0,
    afterErrorTokens: 0,
    driftToleranceRatio: 0.05,
  });
  [100000, 350000, 700000].forEach((x, i) => {
    learner.observe({
      v: 1,
      source: "pi-compaction-result-estimatedTokensAfter",
      binding: binding.profileBinding,
      compactorBinding: binding.compactorBinding,
      sequence: i + 1,
      beforeTokens: x,
      afterTokens: 30000,
    });
  });
  const retention = learner.snapshot();
  return {
    contextTokens: 550000,
    growthTokens: 20000,
    prices: resolveUnitPrices({
      inputPerMillion: 0.3,
      outputPerMillion: 1.2,
      cacheReadPerMillion: 0.006,
    }),
    billingModel: {
      after: { slope: 0.1, intercept: 20000, residual: 0 },
      output: { slope: 0.002, intercept: 100, residual: 0 },
      samples: 0,
      minBefore: 0,
      maxBefore: 700000,
      summaryInputCostPerToken: 0.3e-6,
    },
    retention,
    expectedBasis: retention.basis,
    softBoundary: 500000,
    fallbackBoundary: 600000,
    forceBoundary: 700000,
  };
}
it("compares threshold-cycle projections on the same model and billing basis", () => {
  const r = chooseWithBaselineGate(fixture());
  expect(r.comparison).toMatchObject({ isForecast: true, isConfidenceInterval: false });
  if (r.usedLearnedModel) expect(r.comparison?.candidate).toBeLessThan(r.comparison?.baseline ?? 0);
  else expect(r.boundary).toBe(600000);
});
it("preserves safety and rejects a baseline requiring unsupported extrapolation", () => {
  const f = fixture();
  expect(chooseWithBaselineGate({ ...f, contextTokens: 700000 }).action).toBe("FORCE");
  expect(
    chooseWithBaselineGate({ ...f, retention: { ...f.retention, maxBefore: 590000 } }),
  ).toMatchObject({ boundary: 600000, usedLearnedModel: false });
});

it.each(["fixed", "ratio", "affine"] as const)(
  "exposes the finite-task loss for %s rather than calling a long-run forecast a realized win",
  (law) => {
    const world: LearnedReplayWorld = {
      steps: 160,
      growth: 6000,
      readRatio: 0.02,
      law,
      history: "past-wide",
    };
    const baseline = executeLearnedReplay(world, "fixed60");
    const gated = executeLearnedReplay(world, "gated");
    expect(gated.compactions).toBe(2);
    expect(baseline.compactions).toBe(1);
    expect(gated.total).toBeGreaterThan(baseline.total);
  },
);
