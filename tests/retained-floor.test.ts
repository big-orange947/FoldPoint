import { expect, it } from "vitest";
import type { CompactorTokenModel } from "../src/experimental-compactor";
import { postCompactBill, stableCycleCandidates, summaryBill } from "../src/experimental-cycle";
import { costOfCall, resolveUnitPrices } from "../src/pricing";
import { predictRetainedFloor, retainedFloorCycles } from "../tools/retained-floor";
import { auditRetainedFloor } from "../tools/retained-floor-audit";

const retention = { totalRatio: 0.1, recentBudgetTokens: 20000 };
const model: CompactorTokenModel = {
  after: { slope: 0.1, intercept: 20000, residual: 0 },
  output: { slope: 0.002, intercept: 100, residual: 0 },
  samples: 0,
  minBefore: 0,
  maxBefore: 700000,
  summaryInputCostPerToken: 3e-6,
};

it("treats 10% as TOTAL retention, not an extra summary added to the recent budget", () => {
  expect(predictRetainedFloor(retention, 250000)).toBe(25000);
  expect(predictRetainedFloor(retention, 100000)).toBe(20000);
  expect(predictRetainedFloor(retention, 10000)).toBe(10000);
  expect(predictRetainedFloor(retention, 0)).toBe(0);
  expect(predictRetainedFloor(retention, 200000)).toBe(20000);
});

it("keeps monotonic size predictions across both branches without inventing contraction below budget", () => {
  let previous = 0;
  for (let before = 0; before <= 1000000; before += 1000) {
    const after = predictRetainedFloor(retention, before);
    expect(after).toBeGreaterThanOrEqual(previous);
    expect(after).toBeLessThanOrEqual(before);
    previous = after;
  }
});

it("solves both piecewise cycle branches and agrees with iterative recurrence across a broad grid", () => {
  const prices = resolveUnitPrices({
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
  });
  let floorBranch = 0;
  let ratioBranch = 0;
  for (const ratio of [0, 0.05, 0.1, 0.3, 0.8])
    for (const budget of [0, 2000, 20000, 100000])
      for (const growth of [1000, 10000, 50000]) {
        const prior = { totalRatio: ratio, recentBudgetTokens: budget };
        for (const row of retainedFloorCycles(prices, model, prior, growth, 700000, {})) {
          expect(row.after).toBeCloseTo(predictRetainedFloor(prior, row.before), 6);
          let a = 0;
          for (let step = 0; step < 200; step++)
            a = predictRetainedFloor(prior, a + row.ordinaryCalls * growth);
          expect(a).toBeCloseTo(row.after, 5);
          expect(row.before).toBeLessThanOrEqual(700000);
          if (row.after === budget) floorBranch++;
          else ratioBranch++;
        }
      }
  expect(floorBranch).toBeGreaterThan(0);
  expect(ratioBranch).toBeGreaterThan(0);
});

it("reconciles explicit per-call bills including summary output, prefix rebuild and optional prewarm", () => {
  for (const readRatio of [0.01, 0.1, 1]) {
    const prices = resolveUnitPrices({
      inputPerMillion: 3,
      outputPerMillion: 15,
      cacheReadPerMillion: 3 * readRatio,
      cacheWritePerMillion: 3.75,
    });
    for (const billing of [{}, { summarySharedPrefixRatio: 1 }, { prewarmOutputTokens: 1 }])
      for (const row of retainedFloorCycles(prices, model, retention, 10000, 700000, billing)) {
        const first = postCompactBill(prices, row.after, prices.hasCacheDiscount, billing);
        let ordinary = first.ordinary;
        for (let i = 1; i < row.ordinaryCalls; i++)
          ordinary += costOfCall(prices, row.after + i * 10000, {
            prefixTokens: row.after + (i - 1) * 10000,
            aliveProbability: 1,
            cachingInPlay: prices.hasCacheDiscount,
          });
        const summary = summaryBill(prices, model, row.before, row.before - 10000, 1, billing);
        expect(row.summaryCost).toBeCloseTo(summary, 10);
        expect(row.total).toBeCloseTo(ordinary + first.prewarm + summary, 10);
        expect(row.summaryCalls).toBe(1);
      }
  }
});

it("reduces exactly to affine ratio-only or constant-budget cycles in their respective limits", () => {
  const prices = resolveUnitPrices({ inputPerMillion: 3, outputPerMillion: 15 });
  for (const prior of [
    { totalRatio: 0.1, recentBudgetTokens: 0 },
    { totalRatio: 0, recentBudgetTokens: 20000 },
  ]) {
    const affine = {
      ...model,
      after: { slope: prior.totalRatio, intercept: prior.recentBudgetTokens, residual: 0 },
    };
    const rows = retainedFloorCycles(prices, model, prior, 10000, 700000, {});
    const old = stableCycleCandidates(prices, affine, 10000, 700000, {});
    expect(rows.length).toBe(old.length);
    rows.forEach((row, i) => {
      const reference = old[i];
      if (!reference) throw new Error("missing reference cycle");
      expect(row.before).toBeCloseTo(reference.before, 7);
      expect(row.total).toBeCloseTo(reference.total, 10);
    });
  }
});

it("does not depend on an unrelated old after affine fit or mutate its billing model", () => {
  const prices = resolveUnitPrices({ inputPerMillion: 3, outputPerMillion: 15 });
  const original = structuredClone(model);
  const rows = retainedFloorCycles(prices, model, retention, 10000, 700000, {});
  expect(
    retainedFloorCycles(
      prices,
      { ...model, after: { slope: 0.9, intercept: 99999, residual: 50 } },
      retention,
      10000,
      700000,
      {},
    ),
  ).toEqual(rows);
  expect(model).toEqual(original);
});

it("rejects unsupported bounds and priors rather than silently repairing them", () => {
  const prices = resolveUnitPrices({ inputPerMillion: 3, outputPerMillion: 15 });
  for (const ratio of [-1, 1, NaN, Infinity])
    expect(() => predictRetainedFloor({ ...retention, totalRatio: ratio }, 100000)).toThrow();
  for (const budget of [-1, 1.5, Infinity])
    expect(() =>
      predictRetainedFloor({ ...retention, recentBudgetTokens: budget }, 100000),
    ).toThrow();
  for (const growth of [0, -1, NaN])
    expect(() => retainedFloorCycles(prices, model, retention, growth, 700000, {})).toThrow();
  expect(retainedFloorCycles(prices, model, retention, 10000, 10000, {})).toEqual([]);
});

it("keeps unsupported cycle horizons explicit and never labels forecast differences realized savings", () => {
  const report = auditRetainedFloor();
  expect(report).toEqual(auditRetainedFloor());
  expect(report).toMatchObject({ paidCalls: 0, policyChanged: false, executedTask: false });
  expect(report.cells).toHaveLength(32);
  expect(report.cells.filter((c) => !c.legacy || !c.revised)).toHaveLength(8);
  for (const cell of report.cells) {
    if (!cell.legacy || !cell.revised) {
      expect(cell.growth).toBe(1000); // 256-call bound cannot reach the common 500k window.
      expect(cell.boundaryDelta).toBeNull();
    }
    for (const row of [cell.legacy, cell.revised])
      if (row) {
        expect(row.before).toBeGreaterThanOrEqual(500000);
        expect(row.before).toBeLessThanOrEqual(700000);
        expect(row.total).toBeCloseTo(row.summaryCost + row.prewarmCost + row.ordinaryCost, 12);
      }
  }
});

it("does not pretend an overlapping prior is universally more accurate than an additive compactor", () => {
  const before = 250000;
  // A host that reports summary-only ratio plus an independently retained tail has additive semantics.
  const additiveHost = 0.1 * before + 20000;
  expect(Math.abs(predictRetainedFloor(retention, before) - additiveHost)).toBe(20000);
  // For a TOTAL-ratio host the opposite is true. Compatibility/semantics must be explicit.
  const totalRatioHost = 0.1 * before;
  expect(predictRetainedFloor(retention, before)).toBe(totalRatioHost);
});
