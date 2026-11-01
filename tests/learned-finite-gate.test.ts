import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveUnitPrices } from "../src/pricing";
import { evaluateFiniteGate } from "../tools/finite-gate-eval";
import { executeLearnedReplay } from "../tools/learned-cycle-replay";
import { chooseWithFiniteGate } from "../tools/learned-finite-gate";
import { PiImmediateRetentionLearner } from "../tools/pi-retention-learner";

function fixture() {
  const binding = {
    profileBinding: "a".repeat(64),
    compactorBinding: "b".repeat(64),
    estimatorId: "host/v1",
  };
  const l = new PiImmediateRetentionLearner(binding, {
    beforeErrorTokens: 0,
    afterErrorTokens: 0,
    driftToleranceRatio: 0.05,
  });
  [100000, 350000, 700000].forEach((n, i) => {
    l.observe({
      v: 1,
      source: "pi-compaction-result-estimatedTokensAfter",
      binding: binding.profileBinding,
      compactorBinding: binding.compactorBinding,
      sequence: i + 1,
      beforeTokens: n,
      afterTokens: 30000,
    });
  });
  const retention = l.snapshot();
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
it("respects forced safety and rejects invalid or unbounded continuation assumptions", () => {
  const f = fixture();
  expect(() => chooseWithFiniteGate(f, 1.1)).toThrow();
  expect(chooseWithFiniteGate({ ...f, contextTokens: 700000 }, 0.98).action).toBe("FORCE");
  expect(chooseWithFiniteGate(f, 1)).toMatchObject({
    action: "KEEP",
    boundary: 600000,
    reason: "finite-risk-fallback",
    comparison: { candidate: null, tailProbability: 1 },
  });
  expect(chooseWithFiniteGate(f, 0)).toMatchObject({
    action: "KEEP",
    reason: "finite-risk-fallback",
    comparison: { tailProbability: 0 },
  });
});
it("does not look at the true task endpoint and retains cold-start fallback", () => {
  const w = {
    steps: 160,
    growth: 6000,
    readRatio: 0.02,
    law: "fixed" as const,
    history: "past-wide" as const,
  };
  const a = executeLearnedReplay(w, "finite"),
    b = executeLearnedReplay({ ...w, steps: 480 }, "finite");
  expect(b.decisions.slice(0, 160)).toEqual(a.decisions);
  const cold = executeLearnedReplay({ ...w, history: "cold" }, "finite");
  expect(cold.total).toBeCloseTo(
    executeLearnedReplay({ ...w, history: "cold" }, "fixed60").total,
    12,
  );
});
it("reports all predefined losses and separates synthetic cold and supplied-history worlds", () => {
  const r = evaluateFiniteGate();
  expect(r.summary[0]).toMatchObject({ history: "cold", count: 36, wins: 0, ties: 36, losses: 0 });
  expect(r.summary[1]).toMatchObject({
    history: "past-wide",
    count: 36,
    wins: 22,
    ties: 13,
    losses: 1,
  });
  expect(r).toMatchObject({ paidCalls: 0, realTask: false, policyChanged: false });
});

it("reports survival-assumption sensitivity without counting truncated 0.99 tails as measured wins", () => {
  expect(evaluateFiniteGate(0.9).summary[1]).toMatchObject({ wins: 15, ties: 21, losses: 0 });
  expect(evaluateFiniteGate(0.99).summary[1]).toMatchObject({ wins: 0, ties: 36, losses: 0 });
});

it("uses the current runtime age to update a mixture without using a future endpoint", () => {
  const f = fixture();
  const components = [
    { weight: 0.8, continuationProbability: 0.8 },
    { weight: 0.2, continuationProbability: 0.98 },
  ];
  const young = chooseWithFiniteGate(f, { completedCalls: 0, components });
  const older = chooseWithFiniteGate(f, { completedCalls: 100, components });
  if (!young.comparison || !older.comparison) throw new Error("missing comparison");
  expect(young.comparison.completedCalls).toBe(0);
  expect(older.comparison.completedCalls).toBe(100);
  expect(older.comparison.tailProbability).toBeGreaterThan(young.comparison.tailProbability);
  expect(
    chooseWithFiniteGate({ ...f, contextTokens: 700000 }, { completedCalls: 0, components }).action,
  ).toBe("FORCE");
});

it("keeps the hypothetical runtime mixture separate from the fixed-probability report", () => {
  const r = evaluateFiniteGate(0.98, "finite-mixture");
  expect(r.continuationProbability).toBeNull();
  expect(r.durationPrior).toContain("unvalidated");
  expect(r.summary[0]).toMatchObject({ wins: 0, ties: 36, losses: 0 });
  expect(r.summary[1]).toMatchObject({ wins: 22, ties: 13, losses: 1 });
});

it("rejects unsupported CLI modes without writing an output", () => {
  const out = join(mkdtempSync(join(tmpdir(), "finite-eval-")), "report.json");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "tools/finite-gate-eval.ts", "--out", out, "--unknown"],
    { encoding: "utf8", timeout: 10000 },
  );
  expect(result.status).not.toBe(0);
  expect(existsSync(out)).toBe(false);
});
