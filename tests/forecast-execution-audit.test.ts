import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { estimateRuntimeSurvival, type RuntimeForecastBill } from "../src/index";
import { affineCostCases, costLedger } from "../tools/affine-cost";
import { sourceHash } from "../tools/affine-holdout";
import {
  captureForecastBranch,
  comparePath,
  projectedState,
  renderForecastAudit,
  type runForecastAudit,
  selectForecastCells,
} from "../tools/forecast-execution-audit";
import { type buildOutputCostReport, createOutputCostStrategy } from "../tools/summary-output-cost";

const frozen = JSON.parse(
  readFileSync("benchmarks/reports/summary-output-cost.json", "utf8"),
) as ReturnType<typeof buildOutputCostReport>;
const report = () =>
  JSON.parse(
    readFileSync("benchmarks/reports/forecast-execution-audit.json", "utf8"),
  ) as ReturnType<typeof runForecastAudit>;
const fees = (b: { ordinaryInputCost: number; summaryCost: number; prewarmCost: number }) =>
  b.ordinaryInputCost + b.summaryCost + b.prewarmCost;

it("selects declared worst, best and unchanged controls from the frozen main result", () => {
  expect(sourceHash(readFileSync("benchmarks/reports/summary-output-cost.json", "utf8"))).toBe(
    "eca809fe2d5078f9e79d0a9d822c0dbee1bce3033b84f3343cb21fe5f3d5ec1e",
  );
  expect(
    selectForecastCells(frozen.rows).map(({ role, cell }) => [role, cell.profile, cell.steps]),
  ).toEqual([
    ["worst", "claude-opus-5.5-5m-price", 240],
    ["best", "claude-sonnet-5.5-5m-price", 240],
    ["unchanged", "deepseek-flash-peak", 240],
  ]);
  expect(report().rows.find((r) => r.role === "unchanged")).toMatchObject({
    status: "UNCHANGED",
    checkpoint: null,
  });
});

it("separates survival weighting, matched windows and ordinary output using a hand fixture", () => {
  const p: RuntimeForecastBill = {
    ordinaryInputCost: 4,
    summaryCost: 5,
    prewarmCost: 0,
    expectedOrdinaryCalls: 1.5,
    expectedSummaryCalls: 1,
    expectedPrewarmCalls: 0,
    steps: [
      {
        call: 0,
        survival: 1,
        compact: true,
        beforeTokens: 100,
        afterTokens: 10,
        ordinaryInputCost: 2,
        summaryCost: 5,
        prewarmCost: 0,
      },
      {
        call: 1,
        survival: 0.5,
        compact: false,
        beforeTokens: 20,
        afterTokens: 20,
        ordinaryInputCost: 4,
        summaryCost: 0,
        prewarmCost: 0,
      },
    ],
  };
  const actual = [
    {
      ordinaryInputCost: 3,
      ordinaryOutputCost: 100,
      summaryCost: 6,
      prewarmCost: 0,
      summaryCalls: 1,
      prewarmCalls: 0,
    },
    {
      ordinaryInputCost: 6,
      ordinaryOutputCost: 100,
      summaryCost: 0,
      prewarmCost: 0,
      summaryCalls: 0,
      prewarmCalls: 0,
    },
  ];
  const r = comparePath(p, actual, ["COMPACT", "KEEP"]);
  expect(r.weightedInputFeeGap).toBe(3);
  expect(r.rawInputFeeGap).toBe(4);
  expect(r.scheduleMismatchCalls).toEqual([]);
  expect(
    comparePath(
      p,
      actual.map((a) => ({ ...a, ordinaryOutputCost: 99999 })),
      ["KEEP", "KEEP"],
    ).weightedInputFeeGap,
  ).toBe(3);
  expect(comparePath(p, actual.slice(0, 1), ["COMPACT"]).matchedCalls).toBe(1);
  expect(() => comparePath(p, [], [])).toThrow(/No matched/);
});

it("captures read-only snapshots without changing a real short strategy bill or mutating past models", () => {
  const c = affineCostCases().find((c) => c.suite === "short");
  if (!c) throw new Error("missing short cell");
  const traced = captureForecastBranch(c.scenario, true);
  const original = createOutputCostStrategy(c.scenario, true);
  expect(traced.bill).toEqual(costLedger(c.scenario, original.strategy));
  expect(traced.snapshots[0]?.options.durationModel?.completedCalls).toBe(0);
  expect(traced.snapshots.at(-1)?.options.durationModel?.completedCalls).toBe(3);
  expect(traced.snapshots[0]?.options.compactorTokenModel?.minBefore).toBe(
    traced.snapshots[0]?.input.contextTokens,
  );
});

it("reconciles complete frozen bills and first-divergence forecast explanations on a shared state", () => {
  for (const r of report().rows) {
    const old = frozen.rows.find(
      (v) =>
        v.profile === r.profile &&
        v.fixture === r.fixture &&
        v.steps === r.steps &&
        v.suite === "main",
    );
    expect(r.legacyBill).toEqual(old?.arms.legacyOutputRatio);
    expect(r.candidateBill).toEqual(old?.arms.affineOutput);
    const c = r.checkpoint;
    if (!c) continue;
    expect(c.step).toBe(48);
    expect(c.legacy.snapshot.input).toEqual(c.candidate.snapshot.input);
    expect(c.legacy.snapshot.baseline).toEqual(c.candidate.snapshot.baseline);
    expect(c.legacy.action).not.toBe(c.candidate.action);
    expect(c.actualSuffixCostDelta).toBeCloseTo(r.candidateBill.cost - r.legacyBill.cost, 10);
    for (const a of ["legacy", "candidate"] as const) {
      const v = c[a],
        paths = v.estimate.forecastBills;
      if (!paths) throw new Error("missing explained path");
      const sum = (p: RuntimeForecastBill) =>
        p.steps.reduce(
          (s, e) => s + e.survival * (e.ordinaryInputCost + e.summaryCost + e.prewarmCost),
          0,
        );
      expect(sum(paths.now)).toBeCloseTo(v.estimate.compactNowCost, 9);
      expect(sum(paths.wait)).toBeCloseTo(v.estimate.bestWaitCost, 9);
      expect(v.comparison.weightedInputFeeGap).toBeCloseTo(
        fees(v.comparison.weightedActual) - fees(v.comparison.weightedForecast),
        10,
      );
      expect(paths.now.steps.map((s) => s.survival)).toEqual(
        paths.wait.steps.map((s) => s.survival),
      );
    }
    expect(c.legacy.estimate.forecastBills?.now.steps.map((s) => s.survival)).toEqual(
      c.candidate.estimate.forecastBills?.now.steps.map((s) => s.survival),
    );
  }
});

it("validates all sixteen original screens and exposes unapproved, unscreened planned actions without future data", () => {
  let matched = 0;
  for (const r of report().rows) {
    const c = r.checkpoint;
    if (!c) continue;
    for (const a of ["legacy", "candidate"] as const)
      for (const side of ["now", "wait"] as const) {
        const v = c[a].frozenState[side];
        expect(v.checks).toHaveLength(2);
        expect(v.unassessedAttempts).toBe(v.economicAttempts - v.checks.length);
        expect(v.screenValidation.every((s) => s.matched)).toBe(true);
        matched += v.screenValidation.length;
      }
  }
  expect(matched).toBe(16);
  const c = report().rows.find((r) => r.role === "worst")?.checkpoint;
  if (!c?.candidate.estimate.forecastBills) throw new Error("missing selected worst checkpoint");
  const path = c.candidate.estimate.forecastBills.now;
  expect(path.steps[10]?.compact).toBe(true);
  const before = JSON.stringify(c.candidate.snapshot);
  const state = projectedState(c.candidate.snapshot, path, 10);
  const rechecked = estimateRuntimeSurvival(state.input, state.baseline, state.options);
  expect(rechecked.eligible).toBe(true);
  expect(rechecked.shouldCompact).toBe(false);
  expect(state.options.durationModel?.completedCalls).toBe(58);
  if (state.options.compactorTokenModel) state.options.compactorTokenModel.output.slope = 999;
  expect(JSON.stringify(c.candidate.snapshot)).toBe(before);
  expect(() => projectedState(c.candidate.snapshot, path, 0)).toThrow(/Incomplete/);
});

it("reproduces the checked-in report and producer identity without claiming a policy fix", () => {
  const r = report();
  expect(renderForecastAudit(r)).toBe(
    readFileSync("benchmarks/forecast-execution-audit.md", "utf8"),
  );
  expect(r.sourceHash).toBe(sourceHash(readFileSync("tools/forecast-execution-audit.ts", "utf8")));
  expect(r.paidCalls).toBe(0);
  expect(r.planHash).toBe("51057c03f41112c847a9e730317115e32751e4260325f5fdfc11253c2c6547b4");
  expect(r.planHash).toBe(
    sourceHash(readFileSync("benchmarks/forecast-execution-plan.json", "utf8")),
  );
  expect(renderForecastAudit(r)).toContain("不构成代码缺陷");
  expect(renderForecastAudit(r)).toContain("不是完整递归求解");
});
