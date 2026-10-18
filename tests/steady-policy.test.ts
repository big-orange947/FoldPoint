import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { affineCostCases } from "../tools/affine-cost";
import { sourceHash } from "../tools/affine-holdout";
import type { runBudgetFallback } from "../tools/qualification-fallback";
import {
  captureSteadyBranch,
  renderSteadyPolicy,
  type runSteadyPolicy,
} from "../tools/steady-policy";
import { compactLedger, type runThresholdReference } from "../tools/threshold-reference";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const report = () =>
  JSON.parse(read("benchmarks/reports/steady-policy.json")) as ReturnType<typeof runSteadyPolicy>;

it("reproduces all frozen controls and reconciles complete fees with identical offered growth", () => {
  const r = report(),
    frozen = JSON.parse(read("benchmarks/reports/qualification-fallback.json")) as ReturnType<
      typeof runBudgetFallback
    >;
  expect(r.rows).toHaveLength(24);
  for (const row of r.rows) {
    const old = frozen.rows.find(
      (v) =>
        v.profile === row.profile &&
        v.fixture === row.fixture &&
        v.suite === row.suite &&
        v.steps === row.steps,
    );
    if (!old) throw new Error("Missing control");
    expect(row.baselineMatches).toBe(true);
    expect(row.arms.incumbent).toEqual(compactLedger(old.arms.incumbent));
    expect(row.arms.fixed60).toEqual(compactLedger(old.arms.fixed60));
    expect(new Set(Object.values(row.arms).map((a) => a.fingerprint)).size).toBe(1);
    for (const bill of Object.values(row.arms)) {
      expect(bill.cost).toBeCloseTo(bill.ordinary + bill.summary + bill.prewarm, 10);
      expect(bill.inputWithinWindow).toBe(true);
      expect(bill.overflow).toBe(0);
    }
  }
});

it("makes online decisions independent of the eventual session endpoint with ratio and fitted output", () => {
  const c = affineCostCases().find(
    (v) => v.profile === "claude-sonnet-5.5-5m-price" && v.suite === "main",
  );
  if (!c) throw new Error("Missing scenario");
  for (const output of [false, true]) {
    const short = captureSteadyBranch({ ...c.scenario, steps: 24 }, output);
    const long = captureSteadyBranch({ ...c.scenario, steps: 48 }, output);
    expect(short.actions).toEqual(long.actions.slice(0, 24));
    expect(short.snapshots).toEqual(long.snapshots.slice(0, 24));
    expect(short.choices).toEqual(long.choices.slice(0, 24));
    short.snapshots.forEach((s, i) => {
      expect(s.options.durationModel?.completedCalls).toBe(i);
      if (!output) expect(s.options.compactorTokenModel?.output.intercept).toBe(0);
    });
    short.choices.forEach((v, i) => {
      if (v.selected)
        expect(v.selected.before).toBeLessThanOrEqual(
          short.snapshots[i]?.baseline.metrics.guardedForceBoundaryTokens ?? 0,
        );
    });
  }
});

it("keeps hindsight grid references out of the controller and computes group outcomes with correct denominators", () => {
  const r = report(),
    reference = JSON.parse(read("benchmarks/reports/threshold-reference.json")) as ReturnType<
      typeof runThresholdReference
    >;
  for (const row of r.rows) {
    const ref = reference.rows.find(
      (v) =>
        v.profile === row.profile &&
        v.fixture === row.fixture &&
        v.steps === row.steps &&
        v.suite === row.suite,
    );
    expect(row.reference.bestCost).toBe(ref?.bestCost);
    expect(row.diagnostics.output.decisions).toBe(row.steps);
    expect(row.diagnostics.ratio.decisions).toBe(row.steps);
    expect(Object.values(row.diagnostics.output.reasons).reduce((s, n) => s + n, 0)).toBe(
      row.steps,
    );
  }
  for (const g of r.groups) {
    const cells = r.rows.filter((v) => `${v.profile}/${v.suite}` === g.key);
    expect(g.cases).toBe(cells.length);
    expect(g.outputVsIncumbent).toBeCloseTo(
      cells.reduce((s, v) => s + v.arms.steadyOutput.cost / v.arms.incumbent.cost - 1, 0) /
        cells.length,
      12,
    );
    expect(g.outputVsRatio).toBeCloseTo(
      cells.reduce((s, v) => s + v.arms.steadyOutput.cost / v.arms.steadyRatio.cost - 1, 0) /
        cells.length,
      12,
    );
  }
  expect(
    r.rows.filter((v) => v.arms.steadyOutput.cost < v.arms.incumbent.cost - 1e-9),
  ).toHaveLength(18);
  expect(
    r.rows.filter((v) => v.arms.steadyOutput.cost > v.arms.incumbent.cost + 1e-9),
  ).toHaveLength(4);
  expect(r.groups.find((g) => g.key === "deepseek-flash-peak/main")).toMatchObject({
    wins: 1,
    losses: 3,
  });
  expect(
    r.groups.find((g) => g.key === "claude-opus-5.5-5m-price/failure")?.outputVsIncumbent,
  ).toBeGreaterThan(0);
  expect(read("tools/steady-choice.ts")).not.toContain("threshold-reference");
  expect(read("tools/steady-choice.ts")).not.toContain("fixture");
});

it("pins the frozen plan, sources and report without changing defaults or claiming a quality guarantee", () => {
  const r = report();
  expect(r.planCommit).toBe("09f25a2");
  expect(r.paidCalls).toBe(0);
  expect(r.planHash).toBe("91a0063b903da477cc5c72cfd55f4865fec10074d0862c32f776dfc214071d48");
  expect(r.planHash).toBe(sourceHash(read("benchmarks/steady-policy-plan.json")));
  expect(r.referenceHash).toBe(sourceHash(read("benchmarks/reports/threshold-reference.json")));
  for (const [p, h] of Object.entries(r.sourceHashes)) expect(sourceHash(read(p))).toBe(h);
  expect(renderSteadyPolicy(r)).toBe(read("benchmarks/steady-policy.md"));
  expect(renderSteadyPolicy(r)).toContain("它不保证短任务回本");
  expect(renderSteadyPolicy(r)).toContain("不推广SDK/Pi默认策略");
});
