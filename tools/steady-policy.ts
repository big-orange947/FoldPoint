/** Online steady-cycle objective with isolated output-model ablation. Research only. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DURATION_PRIOR } from "../benchmarks/duration-mixture";
import { createRawFixedThresholdStrategy, type Strategy } from "../benchmarks/fixed-threshold";
import { sumObservedBills } from "../benchmarks/forecast-attribution";
import type { Scenario } from "../benchmarks/scenarios";
import { createFoldPointStrategy } from "../benchmarks/simulator";
import {
  type CompactorTokenModel,
  type RuntimeSurvivalEstimate,
  resolveUnitPrices,
} from "../src/index";
import { affineCostCases, assertAffineCostSources, costLedger, hostFeedback } from "./affine-cost";
import { sourceHash } from "./affine-holdout";
import { captureBudgetBranch, type runBudgetFallback } from "./qualification-fallback";
import { chooseSteadyCycle } from "./steady-choice";
import { SummaryOutputLearner } from "./summary-output";
import { compactLedger, type runThresholdReference } from "./threshold-reference";
import { UncertainAffineFeedback } from "./uncertain-affine-feedback";

type Snapshot = Parameters<
  NonNullable<NonNullable<Parameters<typeof createFoldPointStrategy>[1]>["onSurvivalSnapshot"]>
>[0];
const blank = () => ({
  ordinaryInputCost: 0,
  ordinaryOutputCost: 0,
  summaryCost: 0,
  prewarmCost: 0,
  summaryCalls: 0,
  prewarmCalls: 0,
});
const total = (b: ReturnType<typeof blank>) => b.ordinaryInputCost + b.summaryCost + b.prewarmCost;
const close = (a: number, b: number) => {
  if (Math.abs(a - b) > 1e-8) throw new Error("Full ledger reconciliation failed");
};

export function captureSteadyBranch(scenario: Scenario, affineOutput: boolean) {
  const choices: ReturnType<typeof chooseSteadyCycle>[] = [];
  const after = new UncertainAffineFeedback("cost-host/v1");
  const output = new SummaryOutputLearner("output-host/v1");
  let sequence = 0;
  let model: CompactorTokenModel;
  let pendingSnapshot: Snapshot | undefined;
  let pendingEstimate: RuntimeSurvivalEstimate | undefined;
  const snapshots: Snapshot[] = [];
  const estimates: RuntimeSurvivalEstimate[] = [];
  const actions: string[] = [];
  const bills = Array.from({ length: scenario.steps }, blank);
  const prices = resolveUnitPrices(scenario.pricing);
  const base = createFoldPointStrategy(scenario, {
    omitRequestCacheEvidence: true,
    verifiedAppendOnlyPrefix: true,
    enforceForecastExecutionGates: true,
    defaults: { compactOutputRatio: 0.002 },
    runtimeSurvival: {
      continuationProbability: 0.95,
      maxImmediateLossRatio: 1,
      maxCalls: 256,
      rolloutMode: "renewal",
      endingRiskMode: "survival-weighted",
      endingLossBudgetRatio: 1,
      savingMarginBasis: "timing",
      durationModel: { completedCalls: 0, components: DURATION_PRIOR },
      cycleBilling: scenario.cycleBilling,
      stressWaitSelection: "paired-policy",
      futureQualification: { maxChecksPerPath: 2 },
      get compactorTokenModel() {
        return model;
      },
    },
    onSurvivalSnapshot: (s) => {
      pendingSnapshot = structuredClone(s);
    },
    onSurvivalEstimate: (e) => {
      pendingEstimate = structuredClone(e);
    },
  });
  const strategy: Strategy = {
    ...base,
    decide(r) {
      const point = after.predict(r.contextTokens)?.pointTokens ?? r.contextTokens * 0.1;
      const state = after.snapshot(),
        fit = state.model,
        out = output.snapshot();
      model = {
        after: {
          slope: fit?.slope ?? point / r.contextTokens,
          intercept: fit?.floor ?? 0,
          residual: 0,
        },
        output: {
          slope: affineOutput ? out.slope : out.legacyRatio,
          intercept: affineOutput ? out.intercept : 0,
          residual: 0,
        },
        samples: state.acceptedApproximate,
        minBefore: fit?.minBefore ?? r.contextTokens,
        maxBefore: fit?.maxBefore ?? r.contextTokens,
        summaryInputCostPerToken: prices.inputPerToken,
      };
      pendingSnapshot = undefined;
      pendingEstimate = undefined;
      let decision = base.decide(r);
      if (!pendingSnapshot || !pendingEstimate) throw new Error("Missing frozen metadata snapshot");
      // Synchronous hook assigns these; TypeScript does not follow callback writes.
      const snapshot = pendingSnapshot as Snapshot;
      const choice = chooseSteadyCycle(
        snapshot,
        pendingEstimate as RuntimeSurvivalEstimate,
        decision,
      );
      choices.push(choice);
      decision = choice.decision;
      snapshots.push(pendingSnapshot);
      estimates.push(pendingEstimate);
      actions.push(decision.action);
      return decision;
    },
    onRequest(e) {
      const b = bills[e.step];
      if (!b) throw new Error("Missing ordinary bill");
      b.ordinaryOutputCost += e.outputTokens * prices.outputPerToken;
      b.ordinaryInputCost += e.cost - e.outputTokens * prices.outputPerToken;
      base.onRequest?.(e);
    },
    onCompaction(e) {
      const b = bills[e.step];
      if (!b) throw new Error("Missing summary bill");
      b.summaryCost += e.cost;
      b.summaryCalls++;
      const feedback = hostFeedback(e, ++sequence);
      after.observe(feedback);
      output.observe({
        sequence,
        beforeTokens: e.beforeTokens,
        beforeErrorTokens: feedback.beforeErrorTokens,
        outputTokens: e.outputTokens,
        success: e.success,
      });
      base.onCompaction?.({ ...e, afterTokens: feedback.afterTokens });
    },
    onPrewarm(e) {
      const b = bills[e.step];
      if (!b) throw new Error("Missing prewarm bill");
      b.prewarmCost += e.cost;
      b.prewarmCalls++;
      base.onPrewarm?.(e);
    },
  };
  const bill = costLedger(scenario, strategy);
  close(total(sumObservedBills(bills)) + sumObservedBills(bills).ordinaryOutputCost, bill.cost);
  return { bill, snapshots, estimates, actions, bills, choices, outputModel: output.snapshot() };
}

export function evaluateSteadyPolicy(c: ReturnType<typeof affineCostCases>[number]) {
  const frozen = JSON.parse(
    readFileSync("benchmarks/reports/qualification-fallback.json", "utf8"),
  ) as ReturnType<typeof runBudgetFallback>;
  const old = frozen.rows.find(
    (v) =>
      v.profile === c.profile &&
      v.fixture === c.fixture &&
      v.suite === c.suite &&
      v.steps === c.scenario.steps,
  );
  if (!old || c.scenario.hostHorizon !== undefined)
    throw new Error("Missing control or endpoint leak");
  const incumbent = captureBudgetBranch(c.scenario, false).bill;
  const fixed60 = costLedger(c.scenario, createRawFixedThresholdStrategy(0.6));
  if (
    JSON.stringify(incumbent) !== JSON.stringify(old.arms.incumbent) ||
    JSON.stringify(fixed60) !== JSON.stringify(old.arms.fixed60)
  )
    throw new Error("Steady control full ledger mismatch");
  const ratio = captureSteadyBranch(c.scenario, false),
    output = captureSteadyBranch(c.scenario, true);
  const arms = {
    fixed60: compactLedger(fixed60),
    incumbent: compactLedger(incumbent),
    steadyRatio: compactLedger(ratio.bill),
    steadyOutput: compactLedger(output.bill),
  };
  if (new Set(Object.values(arms).map((v) => v.fingerprint)).size !== 1)
    throw new Error("Growth stream mismatch");
  const diagnostics = (b: typeof ratio) => {
    const bounds = b.choices.flatMap((v) => (v.selected ? [v.selected.before] : []));
    return {
      decisions: b.actions.length,
      economic: b.actions.filter((a) => a === "COMPACT").length,
      force: b.actions.filter((a) => a === "FORCE").length,
      reasons: Object.fromEntries(
        [...new Set(b.choices.map((v) => v.reason))].map((key) => [
          key,
          b.choices.filter((v) => v.reason === key).length,
        ]),
      ),
      boundaryMin: bounds.length ? Math.min(...bounds) : null,
      boundaryMax: bounds.length ? Math.max(...bounds) : null,
      outputModel: b.outputModel,
    };
  };
  // Hindsight reference is read only AFTER all online arms have finished.
  const reference = JSON.parse(
    readFileSync("benchmarks/reports/threshold-reference.json", "utf8"),
  ) as ReturnType<typeof runThresholdReference>;
  const ref = reference.rows.find(
    (v) =>
      v.profile === c.profile &&
      v.fixture === c.fixture &&
      v.suite === c.suite &&
      v.steps === c.scenario.steps,
  );
  if (!ref) throw new Error("Missing hindsight evaluation cell");
  return {
    profile: c.profile,
    fixture: c.fixture,
    suite: c.suite,
    steps: c.scenario.steps,
    baselineMatches: true,
    arms,
    diagnostics: { ratio: diagnostics(ratio), output: diagnostics(output) },
    reference: {
      bestPercentage: ref.bestPercentage,
      bestCost: ref.bestCost,
      outputVsGrid: ref.bestCost !== null ? arms.steadyOutput.cost / ref.bestCost - 1 : null,
    },
  };
}

export function runSteadyPolicy(onProgress?: (message: string) => void) {
  assertAffineCostSources();
  const plan = readFileSync("benchmarks/steady-policy-plan.json", "utf8");
  if (sourceHash(plan) !== "91a0063b903da477cc5c72cfd55f4865fec10074d0862c32f776dfc214071d48")
    throw new Error("Frozen steady plan changed");
  const reference = readFileSync("benchmarks/reports/threshold-reference.json", "utf8");
  if (sourceHash(reference) !== "605157881559ef310db914c34b6c4e52a9cd335abe8662679a3b0ecb1e6d9693")
    throw new Error("Frozen threshold reference changed");
  const frozen = JSON.parse(
    readFileSync("benchmarks/reports/qualification-fallback.json", "utf8"),
  ) as ReturnType<typeof runBudgetFallback>;
  for (const [p, h] of Object.entries(frozen.sourceHashes))
    if (sourceHash(readFileSync(p, "utf8")) !== h) throw new Error("Frozen harness source changed");
  const rows = affineCostCases().map((c) => {
    const r = evaluateSteadyPolicy(c);
    onProgress?.(`${c.profile}/${c.suite}/${c.scenario.steps} complete`);
    return r;
  });
  return {
    runner: "foldpoint.steady-policy.v1",
    planCommit: "09f25a2",
    baselineCommit: "47144e1",
    paidCalls: 0,
    planHash: sourceHash(plan),
    referenceHash: sourceHash(reference),
    sourceHashes: Object.fromEntries(
      ["tools/steady-choice.ts", "tools/steady-policy.ts"].map((p) => [
        p,
        sourceHash(readFileSync(p, "utf8")),
      ]),
    ),
    rows,
    groups: [...new Set(rows.map((r) => `${r.profile}/${r.suite}`))].map((key) => {
      const cells = rows.filter((r) => `${r.profile}/${r.suite}` === key);
      const mean = (
        a: "steadyRatio" | "steadyOutput",
        b: "incumbent" | "fixed60" | "steadyRatio",
      ) => cells.reduce((s, r) => s + r.arms[a].cost / r.arms[b].cost - 1, 0) / cells.length;
      return {
        key,
        cases: cells.length,
        ratioVsIncumbent: mean("steadyRatio", "incumbent"),
        outputVsIncumbent: mean("steadyOutput", "incumbent"),
        outputVsFixed60: mean("steadyOutput", "fixed60"),
        outputVsRatio: mean("steadyOutput", "steadyRatio"),
        wins: cells.filter((r) => r.arms.steadyOutput.cost < r.arms.incumbent.cost - 1e-9).length,
        losses: cells.filter((r) => r.arms.steadyOutput.cost > r.arms.incumbent.cost + 1e-9).length,
      };
    }),
  };
}

export function renderSteadyPolicy(r: ReturnType<typeof runSteadyPolicy>) {
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
  return [
    "# 在线稳定周期费用策略：离线对照",
    "",
    "计划09f25a2先冻结。沿用24格既有场景、全部计费和观测契约，付费调用0。候选在请求时只读取当前元数据及过去观测。",
    "",
    "| 价格/分组 | 格数 | 周期+旧输出相对原算法 | 周期+拟合输出相对原算法 | 周期+拟合输出相对固定60 | 拟合输出相对旧输出 |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...r.groups.map(
      (g) =>
        `| ${g.key} | ${g.cases} | ${pct(g.ratioVsIncumbent)} | ${pct(g.outputVsIncumbent)} | ${pct(g.outputVsFixed60)} | ${pct(g.outputVsRatio)} |`,
    ),
    "",
    "| 价格/分组/fixture | 步数 | 固定60 | 原算法 | 周期+旧输出 | 周期+拟合输出 | 拟合输出边界范围 | 摘要/失败/预热 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |",
    ...r.rows.map(
      (v) =>
        `| ${v.profile}/${v.suite}/${v.fixture} | ${v.steps} | ${v.arms.fixed60.cost.toFixed(6)} | ${v.arms.incumbent.cost.toFixed(6)} | ${v.arms.steadyRatio.cost.toFixed(6)} | ${v.arms.steadyOutput.cost.toFixed(6)} | ${v.diagnostics.output.boundaryMin?.toFixed(0) ?? "—"}～${v.diagnostics.output.boundaryMax?.toFixed(0) ?? "—"} | ${v.arms.steadyOutput.summaryCalls}/${v.arms.steadyOutput.failed}/${v.arms.steadyOutput.prewarmCalls} |`,
    ),
    "",
    "## 算法与边界",
    "",
    "- 复用stableCycleCandidates/cycleBill：根据当前压缩体积模型、增长和价格求整数稳定周期（最多256次，最少为执行冷却+1），比较每次普通调用的平均费用，边界不能超过既有guardedForceBoundary。",
    "- 周期排序计入摘要输入输出、前缀重建和额外预热；普通输出在候选间相同，仅从排序中抵消，真实完整费用仍全部保留。",
    "- steadyRatio仅换选时机目标，保持旧输出比例EMA。steadyOutput再接入已有SummaryOutputLearner，不改其先验、样本要求或回退；两臂独立演化。",
    "- 当前达到所选体积边界才允许经济性压缩；仍保留现有eligible、runtimeRiskAllowed、结束风险预算和未建模尾部门，安全FORCE不变。不要求旧expectedSaving为正，否则无法隔离目标变化。",
    "- 周期目标不依赖剩余调用数，但结束风险门仍沿用既有时长先验；它不保证短任务回本。模型未知、增长非正或无可行周期时KEEP；不满足暖缓存范围时回退到同模型的原策略。",
    "- 周期是假定稳定增长与成功摘要的长期近似；真实抖动、失败、模型外推、有限任务和初始写入都可能造成回归。边界范围含冷启动和被执行门拦截的预测，不是实际每次压缩点。",
    "- 每格重跑两旧控制并逐项复现完整账单；所有臂同一提供增长。事后网格参考只在在线臂结束后读入评测，不进入候选选择。",
    "- 只覆盖已见合成流，冻结价格不是实时供应商报价；没有独立质量或泛化证明，不扩展冷缓存网格，不推广SDK/Pi默认策略，不启动付费测试。",
    "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("usage: tsx tools/steady-policy.ts");
  const r = runSteadyPolicy(console.log);
  writeFileSync("benchmarks/reports/steady-policy.json", `${JSON.stringify(r, null, 2)}\n`);
  writeFileSync("benchmarks/steady-policy.md", renderSteadyPolicy(r));
  console.log(JSON.stringify(r.groups, null, 2));
}
