/** Isolated shared-boundary / one-renewal commitment ablation. Research only. */
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
import { RenewalCommitment } from "./renewal-commitment";
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

export function captureCommittedBranch(scenario: Scenario, committed: boolean) {
  const commitment = new RenewalCommitment();
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
      renewalComparison: "shared-wait-continuation",
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
      if (committed)
        decision = commitment.decide(
          snapshot,
          decision,
          pendingEstimate as RuntimeSurvivalEstimate,
        );
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
      if (committed) commitment.observe(e.success);
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
  return { bill, snapshots, estimates, actions, bills, commitment: commitment.snapshot() };
}

export function evaluateCommitment(c: ReturnType<typeof affineCostCases>[number]) {
  const frozen = JSON.parse(
    readFileSync("benchmarks/reports/qualification-fallback.json", "utf8"),
  ) as ReturnType<typeof runBudgetFallback>;
  const old = frozen.rows.find(
    (r) =>
      r.profile === c.profile &&
      r.fixture === c.fixture &&
      r.suite === c.suite &&
      r.steps === c.scenario.steps,
  );
  if (!old) throw new Error("Missing frozen control");
  const incumbent = captureBudgetBranch(c.scenario, false);
  const replan = captureCommittedBranch(c.scenario, false);
  const committed = captureCommittedBranch(c.scenario, true);
  const arms = {
    fixed60: costLedger(c.scenario, createRawFixedThresholdStrategy(0.6)),
    incumbent: incumbent.bill,
    sharedReplan: replan.bill,
    sharedCommit: committed.bill,
  };
  if (
    JSON.stringify(arms.fixed60) !== JSON.stringify(old.arms.fixed60) ||
    JSON.stringify(arms.incumbent) !== JSON.stringify(old.arms.incumbent)
  )
    throw new Error("Frozen commitment control bill mismatch");
  if (new Set(Object.values(arms).map((a) => a.fingerprint)).size !== 1)
    throw new Error("Growth stream differs");
  const first = replan.actions.findIndex((a, i) => a !== committed.actions[i]);
  if (
    first >= 0 &&
    JSON.stringify(replan.bills.slice(0, first)) !== JSON.stringify(committed.bills.slice(0, first))
  )
    throw new Error("Pre-fork bills differ");
  return {
    profile: c.profile,
    fixture: c.fixture,
    suite: c.suite,
    steps: c.scenario.steps,
    arms,
    baselineMatches: true,
    commitment: committed.commitment,
    firstCommitmentDifference: first,
    first20: committed.actions.slice(0, 20),
  };
}

export function runCommittedContinuation(onProgress?: (message: string) => void) {
  assertAffineCostSources();
  const plan = readFileSync("benchmarks/committed-continuation-plan.json", "utf8");
  if (sourceHash(plan) !== "213d6ba4cda3dc487a24ae59d3cf9190c980aeed866d1c6f5d1f3adcd343fb82")
    throw new Error("Frozen commitment plan changed");
  const frozenText = readFileSync("benchmarks/reports/qualification-fallback.json", "utf8");
  if (sourceHash(frozenText) !== "28623bca2d3fd4e7b532eddf77e98fe76c63b26b093efd9aa1709f220be492ce")
    throw new Error("Frozen fallback report changed");
  const frozen = JSON.parse(frozenText) as ReturnType<typeof runBudgetFallback>;
  for (const [p, h] of Object.entries(frozen.sourceHashes))
    if (sourceHash(readFileSync(p, "utf8")) !== h) throw new Error("Frozen source changed");
  const rows = affineCostCases().map((c) => {
    const r = evaluateCommitment(c);
    onProgress?.(`${c.profile}/${c.suite}/${c.scenario.steps} complete`);
    return r;
  });
  return {
    runner: "foldpoint.committed-continuation.v1",
    planCommit: "b15dec4",
    baselineCommit: "4afeb14",
    planHash: sourceHash(plan),
    paidCalls: 0,
    sourceHashes: Object.fromEntries(
      ["tools/committed-continuation.ts", "tools/renewal-commitment.ts"].map((p) => [
        p,
        sourceHash(readFileSync(p, "utf8")),
      ]),
    ),
    rows,
    groups: [...new Set(rows.map((r) => `${r.profile}/${r.suite}`))].map((key) => {
      const cells = rows.filter((r) => `${r.profile}/${r.suite}` === key);
      const mean = (arm: "fixed60" | "incumbent" | "sharedReplan") =>
        cells.reduce((s, r) => s + r.arms.sharedCommit.cost / r.arms[arm].cost - 1, 0) /
        cells.length;
      return {
        key,
        cases: cells.length,
        meanVsFixed60: mean("fixed60"),
        meanVsIncumbent: mean("incumbent"),
        meanVsSharedReplan: mean("sharedReplan"),
        wins: cells.filter((r) => r.arms.sharedCommit.cost < r.arms.sharedReplan.cost - 1e-9)
          .length,
        losses: cells.filter((r) => r.arms.sharedCommit.cost > r.arms.sharedReplan.cost + 1e-9)
          .length,
      };
    }),
  };
}

export function renderCommittedContinuation(r: ReturnType<typeof runCommittedContinuation>) {
  return [
    "# 一次续程承诺：隔离费用对照",
    "",
    "计划b15dec4先冻结。沿用24格暖缓存场景和全部模型；付费调用0，默认SDK和Pi均不改。",
    "",
    "| 价格 / 场景 / fixture | 步数 | 固定60 | 原算法 | 共用边界逐轮重算 | 共用边界并承诺 | 承诺相对重算 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...r.rows.map(
      (v) =>
        `| ${v.profile}/${v.suite}/${v.fixture} | ${v.steps} | ${v.arms.fixed60.cost.toFixed(6)} | ${v.arms.incumbent.cost.toFixed(6)} | ${v.arms.sharedReplan.cost.toFixed(6)} | ${v.arms.sharedCommit.cost.toFixed(6)} | ${((v.arms.sharedCommit.cost / v.arms.sharedReplan.cost - 1) * 100).toFixed(3)}% |`,
    ),
    "",
    "## 机制与限制",
    "",
    "- sharedReplan复用已有shared-wait-continuation，禁用旧futureQualification；sharedCommit仅增加一次续程承诺。它不是把两项改变共同归为一个收益。",
    "- 当前经济性压缩成功后遵守所选的下一次重复边界；下一次成功摘要后释放。未发生经济性压缩时仍重算，KEEP不锁定。失败保留待完成计划，重试遵守冷却；成功前后的阶段分别记录。",
    "- 安全FORCE保留；承诺不能绕过非安全请求的权限、空闲、冷却、最小回收量与软边界执行门。记录拦截及覆盖次数。",
    "- 计划仅覆盖一次续程，不保证整个未来256步与逐轮重新规划完全一致；真实增长和学习模型变化仍可能导致预测偏差，旧计划过时也是风险。",
    "- 所有四臂费用包含普通输出、摘要输入输出、失败、前缀重建和独立预热；重跑并逐项复现两旧控制账单，相同提供增长、分支独立演化。",
    "- 这批已见合成流不是新留出或模型质量证明；不扩大冷缓存网格，不引入模型名特判或新预测参数，不据结果推广默认插件。",
    "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("usage: tsx tools/committed-continuation.ts");
  const r = runCommittedContinuation(console.log);
  writeFileSync(
    "benchmarks/reports/committed-continuation.json",
    `${JSON.stringify(r, null, 2)}\n`,
  );
  writeFileSync("benchmarks/committed-continuation.md", renderCommittedContinuation(r));
  console.log(JSON.stringify(r.groups, null, 2));
}
