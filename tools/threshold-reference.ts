/** Evaluator-only hindsight grid. No chosen threshold enters the online controller. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRawFixedThresholdStrategy } from "../benchmarks/fixed-threshold";
import { affineCostCases, assertAffineCostSources, costLedger } from "./affine-cost";
import { sourceHash } from "./affine-holdout";
import type { runCommittedContinuation } from "./committed-continuation";
import { captureBudgetBranch } from "./qualification-fallback";

type Ledger = ReturnType<typeof costLedger>;
export function compactLedger(b: Ledger) {
  const { compactions, ...fees } = b;
  return { ...fees, compactionFingerprint: sourceHash(JSON.stringify(compactions)) };
}
export type ThresholdRun = {
  percentage: number;
  status: "eligible" | "invalid";
  reason: null | "INPUT_EXCEEDS_WINDOW" | "OVERFLOW" | "BILL_OR_RECOVERY_UNACCOUNTED";
  bill: ReturnType<typeof compactLedger> | null;
};
export function executeThreshold(
  c: ReturnType<typeof affineCostCases>[number],
  percentage: number,
): ThresholdRun {
  try {
    const b = costLedger(c.scenario, createRawFixedThresholdStrategy(percentage / 100));
    const reason = !b.inputWithinWindow ? "INPUT_EXCEEDS_WINDOW" : b.overflow ? "OVERFLOW" : null;
    return { percentage, status: reason ? "invalid" : "eligible", reason, bill: compactLedger(b) };
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "Full bill does not reconcile or overflow recovery is unaccounted"
    )
      throw error;
    return { percentage, status: "invalid", reason: "BILL_OR_RECOVERY_UNACCOUNTED", bill: null };
  }
}
export function selectThreshold(grid: readonly ThresholdRun[]) {
  return (
    [...grid]
      .filter((v) => v.status === "eligible" && v.bill !== null)
      .sort(
        (a, b) =>
          (a.bill?.cost ?? Infinity) - (b.bill?.cost ?? Infinity) || a.percentage - b.percentage,
      )[0] ?? null
  );
}
const gap = (cost: number, reference: number) => cost / reference - 1;
function evaluateThresholds(
  c: ReturnType<typeof affineCostCases>[number],
  percentages: number[],
  frozen: ReturnType<typeof runCommittedContinuation>,
) {
  const control = frozen.rows.find(
    (v) =>
      v.profile === c.profile &&
      v.fixture === c.fixture &&
      v.suite === c.suite &&
      v.steps === c.scenario.steps,
  );
  if (!control) throw new Error("Frozen threshold control unavailable");
  if (c.scenario.hostHorizon !== undefined) throw new Error("Endpoint leaked into controller");
  const incumbent = captureBudgetBranch(c.scenario, false).bill;
  const fixed60 = costLedger(c.scenario, createRawFixedThresholdStrategy(0.6));
  if (
    JSON.stringify(incumbent) !== JSON.stringify(control.arms.incumbent) ||
    JSON.stringify(fixed60) !== JSON.stringify(control.arms.fixed60)
  )
    throw new Error("Frozen threshold control ledger mismatch");
  const grid = percentages.map((p) => executeThreshold(c, p));
  for (const v of grid) {
    if (v.bill && v.bill.fingerprint !== fixed60.fingerprint)
      throw new Error("Growth stream differs");
  }
  const sixty = grid.find((v) => v.percentage === 60);
  if (!sixty?.bill || JSON.stringify(sixty.bill) !== JSON.stringify(compactLedger(fixed60)))
    throw new Error("Grid60 differs from baseline60");
  const best = selectThreshold(grid);
  return {
    profile: c.profile,
    fixture: c.fixture,
    suite: c.suite,
    steps: c.scenario.steps,
    baselineMatches: true,
    incumbent: compactLedger(incumbent),
    fixed60: compactLedger(fixed60),
    grid,
    bestPercentage: best?.percentage ?? null,
    bestCost: best?.bill?.cost ?? null,
    boundaryBest: best
      ? best.percentage === percentages[0] || best.percentage === percentages.at(-1)
      : null,
    incumbentVsGrid: best?.bill ? gap(incumbent.cost, best.bill.cost) : null,
    fixed60VsGrid: best?.bill ? gap(fixed60.cost, best.bill.cost) : null,
    gridSavingVsFixed60: best?.bill ? 1 - best.bill.cost / fixed60.cost : null,
  };
}

export function addLengthTransfer(rows: ReturnType<typeof evaluateThresholds>[]) {
  return rows.map((row) => {
    if (row.suite !== "main") return { ...row, transfer: null };
    const other = rows.find(
      (r) =>
        r.suite === "main" &&
        r.profile === row.profile &&
        r.fixture === row.fixture &&
        r.steps !== row.steps,
    );
    if (!other) throw new Error("Missing preregistered other length");
    const run = row.grid.find((v) => v.percentage === other.bestPercentage);
    const transfer =
      run?.status === "eligible" && run.bill
        ? {
            fromSteps: other.steps,
            percentage: run.percentage,
            cost: run.bill.cost,
            vsFixed60: gap(run.bill.cost, row.fixed60.cost),
            vsOwnGrid: row.bestCost !== null ? gap(run.bill.cost, row.bestCost) : null,
            dependentPrefixDiagnostic: true,
          }
        : null;
    return { ...row, transfer };
  });
}

export function runThresholdReference(onProgress?: (message: string) => void) {
  assertAffineCostSources();
  const planText = readFileSync("benchmarks/threshold-reference-plan.json", "utf8");
  if (sourceHash(planText) !== "bd04feff8e342db46e20ac0aa1f467898f4a945997dc79a877da2361dd556569")
    throw new Error("Frozen threshold plan changed");
  const frozenText = readFileSync("benchmarks/reports/committed-continuation.json", "utf8");
  if (sourceHash(frozenText) !== "344e6139de92857bff43ca9863cce52691ce78274a9f48786e111e6318f5cf26")
    throw new Error("Frozen commitment report changed");
  const frozen = JSON.parse(frozenText) as ReturnType<typeof runCommittedContinuation>;
  for (const [p, h] of Object.entries(frozen.sourceHashes))
    if (sourceHash(readFileSync(p, "utf8")) !== h) throw new Error("Frozen source changed");
  const plan = JSON.parse(planText) as { thresholdPercentages: number[] };
  const rows = addLengthTransfer(
    affineCostCases().map((c) => {
      const v = evaluateThresholds(c, plan.thresholdPercentages, frozen);
      onProgress?.(`${c.profile}/${c.suite}/${c.scenario.steps}: grid complete`);
      return v;
    }),
  );
  return {
    runner: "foldpoint.threshold-reference.v1",
    planCommit: "929b413",
    baselineCommit: "5ca25a0",
    paidCalls: 0,
    planHash: sourceHash(planText),
    frozenResultHash: sourceHash(frozenText),
    sourceHash: sourceHash(readFileSync("tools/threshold-reference.ts", "utf8")),
    thresholdPercentages: plan.thresholdPercentages,
    rows,
    groups: [...new Set(rows.map((v) => `${v.profile}/${v.suite}`))].map((key) => {
      const cells = rows.filter((v) => `${v.profile}/${v.suite}` === key);
      const valid = cells.filter((v) => v.bestCost !== null);
      return {
        key,
        cases: cells.length,
        eligibleCells: valid.length,
        invalidRuns: cells.reduce(
          (s, v) => s + v.grid.filter((g) => g.status === "invalid").length,
          0,
        ),
        meanIncumbentVsGrid: valid.length
          ? valid.reduce((s, v) => s + (v.incumbentVsGrid ?? 0), 0) / valid.length
          : null,
        meanFixed60VsGrid: valid.length
          ? valid.reduce((s, v) => s + (v.fixed60VsGrid ?? 0), 0) / valid.length
          : null,
        meanGridSavingVsFixed60: valid.length
          ? valid.reduce((s, v) => s + (v.gridSavingVsFixed60 ?? 0), 0) / valid.length
          : null,
        boundaryBest: valid.filter((v) => v.boundaryBest).length,
      };
    }),
  };
}

export function renderThresholdReference(r: ReturnType<typeof runThresholdReference>) {
  const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(2)}%`);
  return [
    "# 固定阈值网格：费用机会参考",
    "",
    "计划929b413先冻结。24格既有场景，每格实际执行5%到70%、间隔5个百分点的14个raw策略；外部及付费调用0。",
    "",
    "| 价格/分组 | 可选格 | 原算法高于网格最低 | 固定60高于网格最低 | 网格最低相对固定60省 | 边缘最优格 |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...r.groups.map(
      (g) =>
        `| ${g.key} | ${g.eligibleCells}/${g.cases} | ${pct(g.meanIncumbentVsGrid)} | ${pct(g.meanFixed60VsGrid)} | ${pct(g.meanGridSavingVsFixed60)} | ${g.boundaryBest} |`,
    ),
    "",
    "每格先计算比例，再组内等权平均。不同分母不能互换：高于最低费用比例不等于相对原账单的可节省比例。",
    "",
    "| 价格/分组/fixture | 长度 | 固定60费用 | 原算法费用 | 网格最低费用 | 事后阈值 | 边缘 | 另一长度所选阈值在本格费用 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |",
    ...r.rows.map(
      (v) =>
        `| ${v.profile}/${v.suite}/${v.fixture} | ${v.steps} | ${v.fixed60.cost.toFixed(6)} | ${v.incumbent.cost.toFixed(6)} | ${v.bestCost?.toFixed(6) ?? "—"} | ${v.bestPercentage ?? "—"}% | ${v.boundaryBest} | ${v.transfer?.cost.toFixed(6) ?? "—"} |`,
    ),
    "",
    "## 解释边界",
    "",
    "- 最低费用只是这14个已执行策略中的事后最小值，不是全局最优、最优费用下界或在线可获得的收益保证；边缘最优说明网格截断可能重要，但本轮不追着结果扩大网格。",
    "- 阈值策略运行中只看当前利用率。评测器在全部执行结束后才选择最佳值，选择结果不进入原算法，也不以模型名/fixture特判部署。",
    "- raw策略与原固定60控制一致，没有冷却、最小回收或安全余量规则。窗口内只代表输入没越界，不代表任务质量、输出余量或完整宿主安全条件合格；不能直接推广最便宜阈值。",
    "- 普通请求输入输出、成功/失败摘要、缓存重建及显式预热都计费；JSON保留每个阈值的费用分解、计数和压缩序列指纹，不仅存胜出者。无效运行保留原因且不得胜出。",
    "- 旧算法和固定60完整账单重新执行并逐项复现；压缩序列只为节省报告体积转成哈希，序列本身仍可由相同命令重建。",
    "- 跨长度诊断用同价格/fixture另一长度选出的阈值，读取本格对应已执行账单；两长度同seed且共享前缀，不是独立留出，更不是新泛化成绩。",
    "- 只覆盖已见暖缓存合成流，价格是冻结仿真参数，不是当前供应商报价；不证明真实模型质量，没有默认/SDK/Pi改动，也不启动付费试验。",
    "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("usage: tsx tools/threshold-reference.ts");
  const r = runThresholdReference(console.log);
  writeFileSync("benchmarks/reports/threshold-reference.json", `${JSON.stringify(r, null, 2)}\n`);
  writeFileSync("benchmarks/threshold-reference.md", renderThresholdReference(r));
  console.log(JSON.stringify(r.groups, null, 2));
}
