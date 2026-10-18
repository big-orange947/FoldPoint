/** Frozen first-fork accounting. No policy edits, live calls or future fixture feedback. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sumObservedBills } from "../benchmarks/forecast-attribution";
import {
  estimateRuntimeSurvival,
  type RuntimeForecastBill,
  type RuntimeSurvivalEstimate,
} from "../src/index";
import { affineCostCases, assertAffineCostSources } from "./affine-cost";
import { sourceHash } from "./affine-holdout";
import { comparePath, projectedState } from "./forecast-execution-audit";
import { captureBudgetBranch, type runBudgetFallback } from "./qualification-fallback";
import { estimateRuntimeSurvival as safetyEstimate } from "./qualification-safety-runtime";

type Branch = ReturnType<typeof captureBudgetBranch>;
type Snapshot = Branch["snapshots"][number];
type Selection = { profile: string; fixture: string; suite: string; steps: number };
const read = (path: string) => readFileSync(path, "utf8");
const same = (a: unknown, b: unknown) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("Frozen fork identity mismatch");
};
const close = (a: number, b: number) => {
  if (Math.abs(a - b) > 1e-8) throw new Error("Fork accounting mismatch");
};
const fees = (b: { ordinaryInputCost: number; summaryCost: number; prewarmCost: number }) =>
  b.ordinaryInputCost + b.summaryCost + b.prewarmCost;

export function forkAccounting(old: RuntimeSurvivalEstimate, next: RuntimeSurvivalEstimate) {
  if (!old.forecastBills || !next.forecastBills) throw new Error("Missing explained bills");
  const delta = (side: "now" | "wait") => {
    const a = old.forecastBills?.[side],
      b = next.forecastBills?.[side];
    if (!a || !b) throw new Error("Missing path");
    return {
      ordinaryInputCost: b.ordinaryInputCost - a.ordinaryInputCost,
      summaryCost: b.summaryCost - a.summaryCost,
      prewarmCost: b.prewarmCost - a.prewarmCost,
      total: fees(b) - fees(a),
      expectedSummaryCalls: b.expectedSummaryCalls - a.expectedSummaryCalls,
    };
  };
  const now = delta("now"),
    wait = delta("wait");
  const savingChange = next.expectedSaving - old.expectedSaving;
  close(wait.total - now.total, savingChange);
  for (const [e, side, cost] of [
    [old, "now", old.compactNowCost],
    [old, "wait", old.bestWaitCost],
    [next, "now", next.compactNowCost],
    [next, "wait", next.bestWaitCost],
  ] as const) {
    if (!e.forecastBills) throw new Error("Missing bills");
    close(fees(e.forecastBills[side]), cost);
  }
  return {
    now,
    wait,
    savingChange,
    requiredSavingChange: next.requiredSaving - old.requiredSaving,
  };
}

export function recheckProjected(s: Snapshot, path: RuntimeForecastBill) {
  return path.steps
    .filter(
      (row) => row.call > 0 && row.beforeTokens < s.baseline.metrics.guardedForceBoundaryTokens,
    )
    .slice(0, 12)
    .map((row) => {
      const local = projectedState(s, path, row.call);
      const inner = estimateRuntimeSurvival(local.input, local.baseline, {
        ...local.options,
        futureQualification: undefined,
      });
      const incumbent = estimateRuntimeSurvival(local.input, local.baseline, local.options);
      const candidate = safetyEstimate(local.input, local.baseline, local.options);
      return {
        call: row.call,
        context: row.beforeTokens,
        forecastCompact: row.compact,
        innerAllowed: inner.shouldCompact,
        incumbentAllowed: incumbent.shouldCompact,
        candidateAllowed: candidate.shouldCompact,
        candidateEligible: candidate.eligible,
        candidateSaving: candidate.expectedSaving,
        candidateStressedSaving: candidate.stressedSaving,
        requiredSaving: candidate.requiredSaving,
        completedCalls: local.options.durationModel?.completedCalls,
      };
    });
}

export function auditQualificationFork(
  selection: Selection,
  frozen: ReturnType<typeof runBudgetFallback>,
) {
  const c = affineCostCases().find(
    (c) =>
      c.profile === selection.profile &&
      c.fixture === selection.fixture &&
      c.suite === selection.suite &&
      c.scenario.steps === selection.steps,
  );
  const old = frozen.rows.find(
    (c) =>
      c.profile === selection.profile &&
      c.fixture === selection.fixture &&
      c.suite === selection.suite &&
      c.steps === selection.steps,
  );
  if (!c || !old) throw new Error("Declared cell unavailable");
  const incumbent = captureBudgetBranch(c.scenario, false),
    candidate = captureBudgetBranch(c.scenario, true);
  same(incumbent.bill, old.arms.incumbent);
  same(candidate.bill, old.arms.budgetSafety);
  const step = incumbent.actions.findIndex((a, i) => a !== candidate.actions[i]);
  const identity = {
    selection,
    baselineMatches: true,
    incumbentBill: incumbent.bill,
    candidateBill: candidate.bill,
  };
  if (step < 0) {
    same(incumbent.actions, candidate.actions);
    same(incumbent.bills, candidate.bills);
    return { ...identity, status: "UNCHANGED" as const, checkpoint: null };
  }
  same(incumbent.bills.slice(0, step), candidate.bills.slice(0, step));
  same(incumbent.snapshots.slice(0, step + 1), candidate.snapshots.slice(0, step + 1));
  const s = incumbent.snapshots[step];
  if (!s) throw new Error("Missing fork");
  const explain = (branch: Branch, safety: boolean) => {
    const estimate = (safety ? safetyEstimate : estimateRuntimeSurvival)(s.input, s.baseline, {
      ...s.options,
      explainBills: true,
    });
    const { forecastBills, ...unchanged } = estimate;
    same(unchanged, branch.estimates[step]);
    if (!forecastBills) throw new Error("Missing explanation");
    return { estimate, forecastBills };
  };
  const a = explain(incumbent, false),
    b = explain(candidate, true);
  const describe = (branch: Branch, explained: typeof a) => {
    const { estimate, forecastBills } = explained;
    const side = branch.actions[step] === "COMPACT" ? "now" : "wait";
    return {
      action: branch.actions[step],
      shouldCompact: estimate.shouldCompact,
      eligible: estimate.eligible,
      expectedSaving: estimate.expectedSaving,
      stressedSaving: estimate.stressedSaving,
      requiredSaving: estimate.requiredSaving,
      compactNowCost: estimate.compactNowCost,
      bestWaitCost: estimate.bestWaitCost,
      qualification: estimate.futureQualification,
      pathBills: {
        now: { ...forecastBills.now, steps: forecastBills.now.steps.slice(0, 13) },
        wait: { ...forecastBills.wait, steps: forecastBills.wait.steps.slice(0, 13) },
      },
      chosenComparison: comparePath(
        forecastBills[side],
        branch.bills.slice(step),
        branch.actions.slice(step),
      ),
      actualFirst12: branch.actions.slice(step, step + 12).map((action, i) => ({
        step: step + i,
        action,
        context: branch.snapshots[step + i]?.input.contextTokens,
        model: branch.snapshots[step + i]?.options.compactorTokenModel,
        bill: branch.bills[step + i],
      })),
    };
  };
  return {
    ...identity,
    status: "DIVERGED" as const,
    checkpoint: {
      step,
      snapshot: s,
      commonPrefixBill: sumObservedBills(incumbent.bills.slice(0, step)),
      incumbent: describe(incumbent, a),
      candidate: describe(candidate, b),
      accounting: forkAccounting(a.estimate, b.estimate),
      projectedRechecks: recheckProjected(s, b.forecastBills.now),
      actualTotalCostChange: candidate.bill.cost - incumbent.bill.cost,
      actualComponentChanges: {
        ordinary: candidate.bill.ordinary - incumbent.bill.ordinary,
        summary: candidate.bill.summary - incumbent.bill.summary,
        prewarm: candidate.bill.prewarm - incumbent.bill.prewarm,
      },
    },
  };
}

export function runQualificationDivergence() {
  assertAffineCostSources();
  const planText = read("benchmarks/qualification-divergence-plan.json");
  if (sourceHash(planText) !== "ff56b3f4f5a31cfee13aea61a1a840c6deb975edc3cbd17f829a7a4ab256ba93")
    throw new Error("Frozen fork plan changed");
  const frozenText = read("benchmarks/reports/qualification-fallback.json");
  if (sourceHash(frozenText) !== "28623bca2d3fd4e7b532eddf77e98fe76c63b26b093efd9aa1709f220be492ce")
    throw new Error("Frozen fallback results changed");
  const frozen = JSON.parse(frozenText) as ReturnType<typeof runBudgetFallback>;
  for (const [path, hash] of Object.entries(frozen.sourceHashes))
    if (sourceHash(read(path)) !== hash) throw new Error("Frozen fallback source changed");
  const plan = JSON.parse(planText) as { selection: Selection; control: Selection };
  return {
    runner: "foldpoint.qualification-divergence.v1",
    planCommit: "11c6ebb",
    baselineCommit: "bedb525",
    paidCalls: 0,
    planHash: sourceHash(planText),
    frozenResultHash: sourceHash(frozenText),
    sourceHash: sourceHash(read("tools/qualification-divergence.ts")),
    selected: auditQualificationFork(plan.selection, frozen),
    control: auditQualificationFork(plan.control, frozen),
  };
}

export function renderQualificationDivergence(r: ReturnType<typeof runQualificationDivergence>) {
  const c = r.selected.checkpoint;
  if (!c) throw new Error("Declared failure no longer diverges");
  const n = (v: number) => v.toFixed(6);
  return [
    "# 安全续程负结果：首分叉账单核对",
    "",
    "计划11c6ebb先冻结。只诊断已报告的37→71次摘要场景，另跑原动作不变对照；不修改算法或默认参数，付费调用0。",
    "",
    `首分叉：零基step ${c.step}，上下文 ${c.snapshot.input.contextTokens} tokens。输入、模型、选项及之前逐步账单全部一致。`,
    "",
    "| 方案 | 动作 | NOW费用 | WAIT费用 | 预期节省 | 压力节省 | 所需节省 |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...[
      ["旧续程", c.incumbent],
      ["安全续程", c.candidate],
    ].map(([label, v]) => {
      const x = v as typeof c.incumbent;
      return `| ${label} | ${x.action} | ${n(x.compactNowCost)} | ${n(x.bestWaitCost)} | ${n(x.expectedSaving)} | ${n(x.stressedSaving)} | ${n(x.requiredSaving)} |`;
    }),
    "",
    "| 新减旧的预测费用 | 普通输入 | 摘要 | 预热 | 合计 |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...(["now", "wait"] as const).map((side) => {
      const d = c.accounting[side];
      return `| ${side} | ${n(d.ordinaryInputCost)} | ${n(d.summaryCost)} | ${n(d.prewarmCost)} | ${n(d.total)} |`;
    }),
    "",
    `预期节省变化 = WAIT变化 − NOW变化 = ${n(c.accounting.savingChange)}；所需节省变化 ${n(c.accounting.requiredSavingChange)}。`,
    "",
    "## 定位结论",
    "",
    "- 首分叉不是摘要费用漏算，也不是模型已经学到不同数据：两边之前的输入、模型和账单完全相同。拒绝预算外压缩以后，两条预测路径都更贵，但WAIT上升更多，放大了立即压缩的相对收益。",
    "- 改变的是相对费用排序，并非总预测费用变得更乐观；安全候选的预测总费用反而更高。判断动作要看两边的差额，不能只看某一路账单。",
    "- 固定模型下，NOW路径的相对第3次调用预测KEEP，同一候选在该投影状态却重新选择COMPACT；实际分支也在step40再次压缩，但实际与投影上下文并不相同，不能混为同一个观测。",
    `- 在共同可观察的203步后缀，候选路径未加权预测摘要${c.candidate.chosenComparison.rawForecast.summaryCalls}次，真实执行${c.candidate.chosenComparison.rawActual.summaryCalls}次；这是续程与执行差异，不是同任务反事实收益。`,
    `- 完整真实费用变化：普通请求 ${n(c.actualComponentChanges.ordinary)}、摘要 ${n(c.actualComponentChanges.summary)}、预热 ${n(c.actualComponentChanges.prewarm)}，合计 ${n(c.actualTotalCostChange)}。更多摘要节省了一部分普通请求费，但没有抵消新增摘要费。`,
    "- 后续改进应先约束评估路径和实际可执行续程的一致性，再做费用对照；不能仅以更多预算、更保守拒绝或继续调保留率作为修复。本轮只定位，不声称已有新策略。",
    "",
    "## 冻结模型下重算未来状态",
    "",
    "| 相对调用 | 预测压缩 | 内层旧规则 | 部署旧规则 | 安全候选 | 候选符合执行门 |",
    "| ---: | --- | --- | --- | --- | --- |",
    ...c.projectedRechecks.map(
      (x) =>
        `| ${x.call} | ${x.forecastCompact} | ${x.innerAllowed} | ${x.incumbentAllowed} | ${x.candidateAllowed} | ${x.candidateEligible} |`,
    ),
    "",
    "## 边界",
    "",
    "- 两个完整费用分支逐项复现上轮账单；另一个对照的动作和逐步账单完全一致，不制造分叉。",
    "- 路径明细只展示前13步，pathBills顶层仍为完整预测窗口合计；chosenComparison按实际可观察后缀截断并使用相同生存权重。",
    "- 投影状态只复现预测器自己的假设，固定模型、价格和增长估计，按时间推进年龄；不是实际宿主轨迹或模型学习的反事实。",
    "- 真实前12步另列于JSON，包含当时模型与账单；不能把预测与真实续程差额全归因于一个因素。",
    "- 当前NOW、WAIT路径经过预算筛查，子检查却仍调用无筛查的旧规则；即使拒绝所有预算外尝试，也不证明前后策略一致。",
    "- 首分叉证明当时动作改变的算术来源，不能证明后续71次摘要全部由首个动作单独导致；完整分支含学习反馈与后续多次决策变化。",
    "- 普通输出从预测差值中抵消，但保留在完整实际费用；摘要输出、失败和缓存建立费用没有删除。",
    "- 这是已见合成流的定位报告，不是新收益或任务质量评测，不扩大冷缓存测试，不启动付费验证。",
    "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("usage: tsx tools/qualification-divergence.ts");
  const r = runQualificationDivergence();
  writeFileSync(
    "benchmarks/reports/qualification-divergence.json",
    `${JSON.stringify(r, null, 2)}\n`,
  );
  writeFileSync("benchmarks/qualification-divergence.md", renderQualificationDivergence(r));
  console.log(JSON.stringify(r.selected.checkpoint?.accounting, null, 2));
}
