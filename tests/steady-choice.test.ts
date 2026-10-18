import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { stableCycleCandidates } from "../src/experimental-cycle";
import { estimateRuntimeSurvival, resolveUnitPrices } from "../src/index";
import type { runQualificationDivergence } from "../tools/qualification-divergence";
import { chooseSteadyCycle } from "../tools/steady-choice";

function fixture() {
  const r = JSON.parse(
    readFileSync("benchmarks/reports/qualification-divergence.json", "utf8"),
  ) as ReturnType<typeof runQualificationDivergence>;
  if (!r.selected.checkpoint) throw new Error("Missing fixture");
  const s = structuredClone(r.selected.checkpoint.snapshot);
  s.input.contextTokens = 600000;
  s.input.profile.pricing = {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  };
  Object.assign(s.baseline.metrics, {
    guardedForceBoundaryTokens: 700000,
    estimatedGrowthTokensPerCall: 10000,
    estimatedCacheLaterAliveProbability: 1,
  });
  s.options.compactorTokenModel = {
    after: { slope: 0, intercept: 20000, residual: 0 },
    output: { slope: 0, intercept: 2000, residual: 0 },
    samples: 3,
    minBefore: 100000,
    maxBefore: 600000,
    summaryInputCostPerToken: 3e-6,
  };
  s.options.executionConstraints = {
    hasAttempt: false,
    minCallsBetweenCompactions: 2,
    minReclaimTokens: 10000,
    minReclaimRatio: 0.1,
    softWindowTokens: 0,
  };
  s.options.cycleBilling = {};
  const e = estimateRuntimeSurvival(s.input, s.baseline, s.options);
  // Isolate ranking from independently tested risk calculations.
  Object.assign(e, {
    eligible: true,
    runtimeRiskAllowed: true,
    assessedEndingLoss: 0,
    immediateLossBudget: 1,
    probabilityOfUnmodeledTail: 0,
    expectedSaving: -100,
    shouldCompact: false,
  });
  return { s, e };
}
const keep = { action: "KEEP" as const };

it("minimizes complete stable-cycle fees without requiring the incumbent saving to be positive", () => {
  const { s, e } = fixture(),
    before = JSON.stringify(s);
  if (!s.options.compactorTokenModel) throw new Error("Missing model");
  const rows = stableCycleCandidates(
    resolveUnitPrices(s.input.profile.pricing),
    s.options.compactorTokenModel,
    10000,
    700000,
    {},
    3,
  );
  const best = rows.reduce((a, b) => (a.costPerOrdinaryCall <= b.costPerOrdinaryCall ? a : b));
  const chosen = chooseSteadyCycle(s, e, keep);
  expect(chosen.selected).toEqual(best);
  expect(chosen.decision.action).toBe("COMPACT");
  expect(chosen.selected?.before).toBeLessThanOrEqual(700000);
  expect(chosen.selected?.total).toBeCloseTo(
    best.summaryCost + best.prewarmCost + best.ordinaryCost,
    12,
  );
  expect(JSON.stringify(s)).toBe(before);
  const smaller = structuredClone(s);
  smaller.input.contextTokens = best.before - 1;
  expect(chooseSteadyCycle(smaller, e, keep).decision.action).toBe("KEEP");
});

it("scales fees but not cycle selection when all prices are scaled together", () => {
  const { s, e } = fixture(),
    first = chooseSteadyCycle(s, e, keep),
    scaled = structuredClone(s);
  const prices = scaled.input.profile.pricing;
  if (!prices) throw new Error("Missing prices");
  for (const k of [
    "inputPerMillion",
    "outputPerMillion",
    "cacheReadPerMillion",
    "cacheWritePerMillion",
  ] as const) {
    const n = prices[k];
    if (n !== undefined) prices[k] = n * 7;
  }
  if (!scaled.options.compactorTokenModel) throw new Error("Missing model");
  scaled.options.compactorTokenModel.summaryInputCostPerToken *= 7;
  const second = chooseSteadyCycle(scaled, e, keep);
  expect(second.selected?.before).toBe(first.selected?.before);
  expect(second.selected?.costPerOrdinaryCall).toBeCloseTo(
    (first.selected?.costPerOrdinaryCall ?? 0) * 7,
    12,
  );
});

it("charges summary output and optional prewarm rather than ignoring them in ranking", () => {
  const { s, e } = fixture(),
    fixed = chooseSteadyCycle(s, e, keep);
  const ratio = structuredClone(s);
  if (!ratio.options.compactorTokenModel) throw new Error("Missing model");
  ratio.options.compactorTokenModel.output = { slope: 0.002, intercept: 0, residual: 0 };
  expect(chooseSteadyCycle(ratio, e, keep).selected?.ordinaryCalls).not.toBe(
    fixed.selected?.ordinaryCalls,
  );
  const warmed = structuredClone(s);
  warmed.options.cycleBilling = { prewarmOutputTokens: 1 };
  const row = chooseSteadyCycle(warmed, e, keep).selected;
  expect(row?.prewarmCalls).toBe(1);
  expect(row?.prewarmCost).toBeGreaterThan(0);
  expect(row?.total).toBeCloseTo(
    (row?.summaryCost ?? 0) + (row?.ordinaryCost ?? 0) + (row?.prewarmCost ?? 0),
    12,
  );
});

it("preserves existing eligibility, ending-risk, tail and host FORCE decisions", () => {
  const { s, e } = fixture();
  for (const patch of [
    { eligible: false },
    { runtimeRiskAllowed: false },
    { assessedEndingLoss: 2 },
    { probabilityOfUnmodeledTail: 0.06 },
  ]) {
    expect(chooseSteadyCycle(s, { ...e, ...patch }, keep).decision.action).toBe("KEEP");
  }
  const force = structuredClone(s);
  force.baseline.action = "FORCE";
  expect(chooseSteadyCycle(force, { ...e, eligible: false }, keep).decision.action).toBe("FORCE");
});

it("falls back outside warm-cache support and never invents a non-shrinking or infeasible cycle", () => {
  const { s, e } = fixture(),
    cold = structuredClone(s);
  cold.baseline.metrics.estimatedCacheLaterAliveProbability = 0.5;
  const original = { action: "COMPACT" as const };
  expect(chooseSteadyCycle(cold, e, original).decision).toBe(original);
  const plain = structuredClone(s);
  if (!plain.input.profile.pricing) throw new Error("Missing prices");
  plain.input.profile.pricing.cacheReadPerMillion = 3;
  expect(chooseSteadyCycle(plain, e, original).decision).toBe(original);
  const zero = structuredClone(s);
  zero.baseline.metrics.estimatedGrowthTokensPerCall = 0;
  expect(chooseSteadyCycle(zero, e, original).reason).toBe("cycle-unsupported");
  const expanding = structuredClone(s);
  if (!expanding.options.compactorTokenModel) throw new Error("Missing model");
  expanding.options.compactorTokenModel.after.slope = 1;
  expect(chooseSteadyCycle(expanding, e, original).decision.action).toBe("KEEP");
  const small = structuredClone(s);
  small.baseline.metrics.guardedForceBoundaryTokens = 10000;
  expect(chooseSteadyCycle(small, e, original).reason).toBe("no-cycle");
});

it("filters candidates with execution cooldown, reclaim and soft-window requirements", () => {
  const { s, e } = fixture(),
    long = structuredClone(s);
  if (!long.options.executionConstraints) throw new Error("Missing constraints");
  long.options.executionConstraints.minCallsBetweenCompactions = 12;
  expect(chooseSteadyCycle(long, e, keep).selected?.ordinaryCalls).toBeGreaterThanOrEqual(13);
  const soft = structuredClone(s);
  if (!soft.options.executionConstraints) throw new Error("Missing constraints");
  soft.options.executionConstraints.softWindowTokens = 300000;
  expect(chooseSteadyCycle(soft, e, keep).selected?.before).toBeGreaterThanOrEqual(300000);
  soft.options.executionConstraints.minReclaimTokens = 1e9;
  expect(chooseSteadyCycle(soft, e, keep).decision.action).toBe("KEEP");
});
