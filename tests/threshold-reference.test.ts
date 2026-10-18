import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createRawFixedThresholdStrategy } from "../benchmarks/fixed-threshold";
import { affineCostCases, costLedger } from "../tools/affine-cost";
import { sourceHash } from "../tools/affine-holdout";
import type { runCommittedContinuation } from "../tools/committed-continuation";
import {
  addLengthTransfer,
  compactLedger,
  executeThreshold,
  renderThresholdReference,
  type runThresholdReference,
  selectThreshold,
  type ThresholdRun,
} from "../tools/threshold-reference";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const report = () =>
  JSON.parse(read("benchmarks/reports/threshold-reference.json")) as ReturnType<
    typeof runThresholdReference
  >;
const sample = () => {
  const bill = report().rows[0]?.grid[0]?.bill;
  if (!bill) throw new Error("Missing grid fixture");
  return bill;
};

it("selects after execution, excludes invalid cheap runs, and breaks exact ties toward the smaller threshold", () => {
  const bill = sample();
  const grid: ThresholdRun[] = [
    {
      percentage: 70,
      status: "invalid",
      reason: "INPUT_EXCEEDS_WINDOW",
      bill: { ...bill, cost: 0 },
    },
    { percentage: 10, status: "eligible", reason: null, bill: { ...bill, cost: 2 } },
    { percentage: 5, status: "eligible", reason: null, bill: { ...bill, cost: 2 } },
    { percentage: 15, status: "eligible", reason: null, bill: { ...bill, cost: 3 } },
  ];
  const before = JSON.stringify(grid);
  expect(selectThreshold(grid)?.percentage).toBe(5);
  expect(JSON.stringify(grid)).toBe(before);
  expect(selectThreshold([grid[0] as ThresholdRun])).toBe(null);
  expect(selectThreshold([])).toBe(null);
});

it("reproduces both frozen controls including compaction sequence identities in all 24 cells", () => {
  const r = report();
  const frozen = JSON.parse(read("benchmarks/reports/committed-continuation.json")) as ReturnType<
    typeof runCommittedContinuation
  >;
  expect(r.rows).toHaveLength(24);
  for (const row of r.rows) {
    const old = frozen.rows.find(
      (x) =>
        x.profile === row.profile &&
        x.fixture === row.fixture &&
        x.steps === row.steps &&
        x.suite === row.suite,
    );
    if (!old) throw new Error("Missing frozen cell");
    expect(row.incumbent).toEqual(compactLedger(old.arms.incumbent));
    expect(row.fixed60).toEqual(compactLedger(old.arms.fixed60));
    expect(row.baselineMatches).toBe(true);
    expect(row.grid.find((x) => x.percentage === 60)?.bill).toEqual(row.fixed60);
  }
});

it("keeps every grid run and reconciles full component fees instead of retaining only winners", () => {
  const r = report();
  expect(r.thresholdPercentages).toEqual([5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70]);
  for (const row of r.rows) {
    expect(row.grid.map((x) => x.percentage)).toEqual(r.thresholdPercentages);
    const selected = selectThreshold(row.grid);
    expect(row.bestPercentage).toBe(selected?.percentage ?? null);
    expect(row.bestCost).toBe(selected?.bill?.cost ?? null);
    expect(row.bestCost).toBeLessThanOrEqual(row.fixed60.cost);
    for (const g of row.grid) {
      if (!g.bill) {
        expect(g.status).toBe("invalid");
        expect(g.reason).not.toBe(null);
        continue;
      }
      expect(g.bill.cost).toBeCloseTo(g.bill.ordinary + g.bill.summary + g.bill.prewarm, 10);
      expect(g.bill.fingerprint).toBe(row.fixed60.fingerprint);
      if (g.status === "eligible") {
        expect(g.bill.overflow).toBe(0);
        expect(g.bill.inputWithinWindow).toBe(true);
      }
    }
  }
});

it("keeps denominators and boundary-optimum flags honest", () => {
  const r = report();
  for (const g of r.groups) {
    const rows = r.rows.filter((x) => `${x.profile}/${x.suite}` === g.key);
    const valid = rows.filter((x) => x.bestCost !== null);
    expect(g.cases).toBe(rows.length);
    expect(g.eligibleCells).toBe(valid.length);
    expect(g.meanIncumbentVsGrid).toBeCloseTo(
      valid.reduce((s, x) => s + x.incumbent.cost / (x.bestCost as number) - 1, 0) / valid.length,
      12,
    );
    expect(g.meanGridSavingVsFixed60).toBeCloseTo(
      valid.reduce((s, x) => s + 1 - (x.bestCost as number) / x.fixed60.cost, 0) / valid.length,
      12,
    );
    expect(g.boundaryBest).toBe(
      valid.filter((x) => x.bestPercentage === 5 || x.bestPercentage === 70).length,
    );
  }
});

it("takes transfer choices from the other length, not the target winner, without calling it independent heldout", () => {
  const r = report();
  expect(addLengthTransfer(r.rows)).toEqual(r.rows);
  for (const row of r.rows) {
    if (row.suite !== "main") {
      expect(row.transfer).toBe(null);
      continue;
    }
    const other = r.rows.find(
      (x) =>
        x.profile === row.profile &&
        x.fixture === row.fixture &&
        x.suite === "main" &&
        x.steps !== row.steps,
    );
    expect(row.transfer?.fromSteps).toBe(other?.steps);
    expect(row.transfer?.percentage).toBe(other?.bestPercentage);
    expect(row.transfer?.cost).toBe(
      row.grid.find((x) => x.percentage === other?.bestPercentage)?.bill?.cost,
    );
    expect(row.transfer?.dependentPrefixDiagnostic).toBe(true);
  }
});

it("runs a fixed policy identically on shared prefixes without knowing the eventual endpoint", () => {
  const c = affineCostCases()[0];
  if (!c) throw new Error("Missing case");
  const a = costLedger({ ...c.scenario, steps: 60 }, createRawFixedThresholdStrategy(0.2));
  const b = costLedger({ ...c.scenario, steps: 120 }, createRawFixedThresholdStrategy(0.2));
  const sort = (x: typeof a.compactions) => [...x].sort((p, q) => p.step - q.step);
  expect(sort(a.compactions)).toEqual(sort(b.compactions.filter((x) => x.step < 60)));
});

it("retains an overflowing fixture as invalid rather than presenting its partial bill as a cheap winner", () => {
  const c = affineCostCases()[0];
  if (!c) throw new Error("Missing case");
  const result = executeThreshold(
    { ...c, scenario: { ...c.scenario, steps: 2, contextWindowTokens: 1000, startTokens: 500000 } },
    70,
  );
  expect(result.status).toBe("invalid");
  expect(result.reason).not.toBe(null);
  expect(selectThreshold([result])).toBe(null);
});

it("pins source and preregistered report while explicitly rejecting global-optimality and deployment claims", () => {
  const r = report();
  expect(r.paidCalls).toBe(0);
  expect(r.planCommit).toBe("929b413");
  expect(r.planHash).toBe("bd04feff8e342db46e20ac0aa1f467898f4a945997dc79a877da2361dd556569");
  expect(r.planHash).toBe(sourceHash(read("benchmarks/threshold-reference-plan.json")));
  expect(r.sourceHash).toBe(sourceHash(read("tools/threshold-reference.ts")));
  expect(r.frozenResultHash).toBe(
    sourceHash(read("benchmarks/reports/committed-continuation.json")),
  );
  expect(renderThresholdReference(r)).toBe(read("benchmarks/threshold-reference.md"));
  expect(renderThresholdReference(r)).toContain("不是全局最优");
  expect(renderThresholdReference(r)).toContain("没有冷却");
});
