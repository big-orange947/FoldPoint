import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { resolveUnitPrices } from "../src/pricing";
import { chooseSupportedCycle, type LearnedCycleInput } from "../tools/learned-cycle-choice";
import {
  executeLearnedReplay,
  type LearnedReplayWorld,
  runLearnedReplay,
} from "../tools/learned-cycle-replay";
import { PiImmediateRetentionLearner } from "../tools/pi-retention-learner";

const binding = {
  profileBinding: "a".repeat(64),
  compactorBinding: "b".repeat(64),
  estimatorId: "host/v1",
};
const make = () =>
  new PiImmediateRetentionLearner(binding, {
    beforeErrorTokens: 0,
    afterErrorTokens: 0,
    driftToleranceRatio: 0.05,
  });
const observe = (m: PiImmediateRetentionLearner, sequence: number, before: number, after = 30000) =>
  m.observe({
    v: 1,
    source: "pi-compaction-result-estimatedTokensAfter",
    binding: binding.profileBinding,
    compactorBinding: binding.compactorBinding,
    sequence,
    beforeTokens: before,
    afterTokens: after,
  });
function fixture(warm = true): LearnedCycleInput {
  const m = make();
  if (warm)
    [100000, 350000, 700000].forEach((x, i) => {
      observe(m, i + 1, x);
    });
  const retention = m.snapshot();
  return {
    contextTokens: 550000,
    growthTokens: 20000,
    prices: resolveUnitPrices({
      inputPerMillion: 0.3,
      outputPerMillion: 1.2,
      cacheReadPerMillion: 0.006,
    }),
    billingModel: {
      after: { slope: 0.9, intercept: 99999, residual: 0 },
      output: { slope: 0.002, intercept: 100, residual: 0 },
      samples: 0,
      minBefore: 0,
      maxBefore: 1,
      summaryInputCostPerToken: 0.3e-6,
    },
    retention,
    expectedBasis: retention.basis,
    softBoundary: 500000,
    fallbackBoundary: 600000,
    forceBoundary: 700000,
  };
}

it("explicitly falls back to fixed60 for unidentified models and preserves 70% safety", () => {
  const f = fixture(false);
  expect(chooseSupportedCycle(f)).toMatchObject({
    action: "KEEP",
    boundary: 600000,
    usedLearnedModel: false,
    reason: "unidentified-retention",
  });
  expect(chooseSupportedCycle({ ...f, contextTokens: 610000 }).action).toBe("COMPACT");
  expect(
    chooseSupportedCycle({ ...f, contextTokens: 700000, expectedBasis: "wrong" }),
  ).toMatchObject({ action: "FORCE", reason: "safety" });
});

it("uses learned retention instead of a billing model's legacy/cold after prior", () => {
  const f = fixture();
  const result = chooseSupportedCycle(f);
  expect(result.usedLearnedModel).toBe(true);
  expect(result.boundary).toBeGreaterThanOrEqual(500000);
  expect(result.boundary).toBeLessThanOrEqual(700000);
  expect(
    chooseSupportedCycle({
      ...f,
      billingModel: { ...f.billingModel, after: { slope: 0.1, intercept: 20000, residual: 50000 } },
    }),
  ).toEqual(result);
});

it("requires supported current size, a supported fallback comparator and compatible metadata", () => {
  const f = fixture();
  expect(chooseSupportedCycle({ ...f, expectedBasis: "wrong" }).reason).toBe("incompatible-model");
  expect(chooseSupportedCycle({ ...f, growthTokens: undefined }).reason).toBe("unknown-growth");
  expect(
    chooseSupportedCycle({ ...f, retention: { ...f.retention, maxBefore: 590000 } }).reason,
  ).toBe("unsupported-fallback-comparator");
  expect(
    chooseSupportedCycle({
      ...f,
      contextTokens: 680000,
      retention: { ...f.retention, maxBefore: 650000 },
    }).reason,
  ).toBe("current-size-outside-range");
  expect(() => chooseSupportedCycle({ ...f, fallbackBoundary: 710000 })).toThrow();
});

it("does not claim that residual uncertainty guarantees shrinking or permits a stale drift fit", () => {
  const f = fixture();
  if (!f.retention.model) throw new Error("missing model");
  expect(
    chooseSupportedCycle({
      ...f,
      retention: { ...f.retention, model: { ...f.retention.model, envelope: 1000000 } },
    }).reason,
  ).toBe("no-supported-cycle");
  const m = make();
  [100000, 350000, 700000].forEach((x, i) => {
    observe(m, i + 1, x);
  });
  observe(m, 4, 400000, 90000);
  const state = m.snapshot();
  expect(chooseSupportedCycle({ ...f, retention: state, expectedBasis: state.basis }).reason).toBe(
    "unidentified-retention",
  );
});

it("keeps all cold synthetic executions equal to fixed60, without fabricated savings", () => {
  const report = runLearnedReplay();
  expect(report.summary[0]).toMatchObject({
    history: "cold",
    cells: 36,
    wins: 0,
    ties: 36,
    losses: 0,
    relativeDifference: 0,
    learnedDecisions: 0,
  });
  for (const c of report.cells) {
    expect(c.supported.offeredGrowth).toBe(c.baseline.offeredGrowth);
    expect(c.supported.ordinaryCalls).toBe(c.baseline.ordinaryCalls);
    expect(c.supported.total).toBeCloseTo(c.supported.ordinaryCost + c.supported.summaryCost, 10);
    expect(c.supported.maxPrompt).toBeLessThan(700000);
    if (c.world.history === "cold") {
      expect(
        c.supported.actions.map(({ step, before, after }) => ({ step, before, after })),
      ).toEqual(c.baseline.actions.map(({ step, before, after }) => ({ step, before, after })));
    }
  }
  expect(report.summary[1]?.losses).toBeGreaterThan(0);
  const recorded = JSON.parse(
    readFileSync("benchmarks/reports/learned-cycle-replay-20261026.json", "utf8"),
  );
  expect(report.summary).toEqual(recorded.summary);
});

it("does not read a future endpoint, and reconciles an independent executed full bill", () => {
  const world: LearnedReplayWorld = {
    steps: 160,
    growth: 22000,
    readRatio: 0.02,
    law: "fixed",
    history: "past-wide",
  };
  const run = executeLearnedReplay(world, "supported");
  const long = executeLearnedReplay({ ...world, steps: 480 }, "supported");
  expect(long.decisions.slice(0, world.steps)).toEqual(run.decisions);
  expect(long.actions.filter((a) => a.step < world.steps)).toEqual(run.actions);
  let context = 100000,
    prefix = 100000,
    ordinary = 0,
    summary = 0;
  for (let step = 0; step < world.steps; step++) {
    const action = run.actions.find((a) => a.step === step);
    if (action) {
      expect(action.before).toBe(context);
      summary += context * 0.3e-6 + Math.ceil(context * 0.002 + 100) * 1.2e-6;
      context = action.after;
      prefix = 0;
    }
    ordinary += prefix * 0.006e-6 + (context - prefix) * 0.3e-6 + 300 * 1.2e-6;
    prefix = context;
    context += Math.round(world.growth * ([0.8, 1, 1.2, 0.9, 1.1][step % 5] ?? 1));
  }
  expect(run.ordinaryCost).toBeCloseTo(ordinary, 10);
  expect(run.summaryCost).toBeCloseTo(summary, 10);
});
