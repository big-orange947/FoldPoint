/** Research harness: only budget-exhaustion continuation changes. No SDK or Pi changes. */
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
import { estimateRuntimeSurvival as estimateSafetyRuntime } from "./qualification-safety-runtime";
import { SummaryOutputLearner } from "./summary-output";
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

export function captureBudgetBranch(scenario: Scenario, safety: boolean) {
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
          slope: out.legacyRatio,
          intercept: 0,
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
      if (safety) {
        pendingEstimate = estimateSafetyRuntime(
          snapshot.input,
          snapshot.baseline,
          snapshot.options,
        );
        decision = {
          action:
            snapshot.baseline.action === "FORCE"
              ? "FORCE"
              : pendingEstimate.shouldCompact
                ? "COMPACT"
                : "KEEP",
          reasons: pendingEstimate.shouldCompact ? ["ECONOMIC_TRIGGER"] : snapshot.baseline.reasons,
          estimatedBreakEvenCalls: null,
        };
      }
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
  return { bill, snapshots, estimates, actions, bills };
}

export function evaluateBudgetFallback(c: ReturnType<typeof affineCostCases>[number]) {
  const incumbent = captureBudgetBranch(c.scenario, false);
  const candidate = captureBudgetBranch(c.scenario, true);
  const fixed60 = costLedger(c.scenario, createRawFixedThresholdStrategy(0.6));
  const frozen = JSON.parse(readFileSync("benchmarks/reports/affine-cost.json", "utf8"));
  const control = frozen.rows.find(
    (r: { profile: string; fixture: string; suite: string; steps: number }) =>
      r.profile === c.profile &&
      r.fixture === c.fixture &&
      r.suite === c.suite &&
      r.steps === c.scenario.steps,
  );
  if (
    !control ||
    JSON.stringify(incumbent.bill) !== JSON.stringify(control.arms.uncertainAffine) ||
    JSON.stringify(fixed60) !== JSON.stringify(control.arms.fixed60)
  )
    throw new Error("Frozen control ledger mismatch");
  const arms = { fixed60, incumbent: incumbent.bill, budgetSafety: candidate.bill };
  if (new Set(Object.values(arms).map((a) => a.fingerprint)).size !== 1)
    throw new Error("Different offered growth streams");
  const stats = (b: typeof candidate) => {
    let checks = 0,
      approved = 0,
      exhaustedCandidates = 0,
      safetyFallbacks = 0;
    for (const e of b.estimates) {
      const q = e.futureQualification;
      if (!q) continue;
      for (const side of [q.now, q.wait]) {
        if (side.checks.length > 2) throw new Error("Qualification budget exceeded");
        checks += side.checks.length;
        approved += side.checks.filter((c) => c.allowed).length;
        exhaustedCandidates += side.unassessedAttempts;
      }
      safetyFallbacks += Number(q.nowSafetyFallback) + Number(q.waitSafetyFallback);
    }
    return { checks, approved, exhaustedCandidates, safetyFallbacks };
  };
  return {
    profile: c.profile,
    fixture: c.fixture,
    suite: c.suite,
    steps: c.scenario.steps,
    arms,
    baselineMatches: true,
    diagnostics: { incumbent: stats(incumbent), candidate: stats(candidate) },
    firstActionDifference: incumbent.actions.findIndex((a, i) => a !== candidate.actions[i]),
  };
}

export function renderBudgetFallback(r: ReturnType<typeof runBudgetFallback>) {
  return [
    "# 检查预算耗尽后的安全续程对照",
    "",
    "计划179542d先冻结；24个已见合成场景，外部调用0。只改预测路径的检查耗尽回退，不改模型、价格、阈值或检查预算。",
    "",
    "| 价格 / 场景 | 长度 | 固定60 | 旧续程 | 安全续程 | 相对旧续程 |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...r.rows.map(
      (v) =>
        `| ${v.profile} / ${v.suite} / ${v.fixture} | ${v.steps} | ${v.arms.fixed60.cost.toFixed(6)} | ${v.arms.incumbent.cost.toFixed(6)} | ${v.arms.budgetSafety.cost.toFixed(6)} | ${((v.arms.budgetSafety.cost / v.arms.incumbent.cost - 1) * 100).toFixed(3)}% |`,
    ),
    "",
    "## 口径与限制",
    "",
    "- NOW与WAIT两侧各最多检查2次；已批准的未来经济性压缩仍保留，未检查的尝试拒绝，达到安全边界时仍允许强制压缩。两侧原有安全续程备选和压力路径规则不变。",
    "- 这是预测路径的修改，不是把在线经济性压缩全部关闭；在线每次请求仍用当时可见数据重新计算。",
    "- 保留冻结核心与旧报告。研究副本由冻结源码机械派生，测试校验差异仅为导入路径、说明和预算耗尽时的两个布尔值；不导出SDK，不接管Pi。",
    "- 子检查仍是深度一的旧续程，不是完整递归一致性证明；修复这一处乐观假设不保证更便宜。",
    "- 所有24格重跑旧策略与固定60并逐项复现冻结账单。费用包括普通输入输出、失败摘要、压缩后前缀重建、显式预热；相同增长流，分支独立演化。无原生Pi性能结论。",
    "- 只报告已见合成流的成本，不证明任务质量或真实供应商缓存行为。没有扩展冷缓存网格，也没有据结果调参或默认推广。",
    "",
  ].join("\n");
}

export function runBudgetFallback() {
  assertAffineCostSources();
  const plan = readFileSync("benchmarks/qualification-fallback-plan.json", "utf8");
  if (sourceHash(plan) !== "c24344881d7c98fc72d0b939b4f74e3b4a838ac9590f7da87f149a5745f1f1be")
    throw new Error("Frozen qualification fallback plan changed");
  const rows = affineCostCases().map(evaluateBudgetFallback);
  return {
    runner: "foldpoint.qualification-fallback.v1",
    paidCalls: 0,
    planCommit: "179542d",
    baselineCommit: "5621eb6",
    planHash: sourceHash(plan),
    sourceHashes: Object.fromEntries(
      ["tools/qualification-safety-runtime.ts", "tools/qualification-fallback.ts"].map((p) => [
        p,
        sourceHash(readFileSync(p, "utf8")),
      ]),
    ),
    rows,
    groups: [...new Set(rows.map((r) => `${r.profile}/${r.suite}`))].map((key) => {
      const cells = rows.filter((r) => `${r.profile}/${r.suite}` === key);
      return {
        key,
        cases: cells.length,
        meanVsIncumbent:
          cells.reduce((s, r) => s + r.arms.budgetSafety.cost / r.arms.incumbent.cost - 1, 0) /
          cells.length,
        meanVsFixed60:
          cells.reduce((s, r) => s + r.arms.budgetSafety.cost / r.arms.fixed60.cost - 1, 0) /
          cells.length,
        wins: cells.filter((r) => r.arms.budgetSafety.cost < r.arms.incumbent.cost - 1e-9).length,
        losses: cells.filter((r) => r.arms.budgetSafety.cost > r.arms.incumbent.cost + 1e-9).length,
      };
    }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("usage: tsx tools/qualification-fallback.ts");
  const r = runBudgetFallback();
  writeFileSync(
    "benchmarks/reports/qualification-fallback.json",
    `${JSON.stringify(r, null, 2)}\n`,
  );
  writeFileSync("benchmarks/qualification-fallback.md", renderBudgetFallback(r));
  console.log(JSON.stringify(r.groups, null, 2));
}
