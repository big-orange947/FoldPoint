/** Local, frozen-state forecast consistency audit. No production changes or provider calls. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DURATION_PRIOR } from "../benchmarks/duration-mixture";
import type { Strategy } from "../benchmarks/fixed-threshold";
import { sumForecastBills, sumObservedBills } from "../benchmarks/forecast-attribution";
import type { Scenario } from "../benchmarks/scenarios";
import { createFoldPointStrategy } from "../benchmarks/simulator";
import { postCompactBill, summaryBill } from "../src/experimental-cycle";
import {
  type CompactorTokenModel,
  costOfCall,
  estimateRuntimeSurvival,
  predictCompactorTokens,
  type RuntimeForecastBill,
  type RuntimeSurvivalEstimate,
  resolveUnitPrices,
} from "../src/index";
import { affineCostCases, assertAffineCostSources, costLedger, hostFeedback } from "./affine-cost";
import { sourceHash } from "./affine-holdout";
import { SummaryOutputLearner } from "./summary-output";
import type { buildOutputCostReport } from "./summary-output-cost";
import { UncertainAffineFeedback } from "./uncertain-affine-feedback";

type Frozen = ReturnType<typeof buildOutputCostReport>;
type Cell = Frozen["rows"][number];
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
  if (Math.abs(a - b) > 1e-8) throw new Error(`Forecast audit mismatch: ${a}/${b}`);
};

export function selectForecastCells(rows: Cell[]) {
  const main = rows.filter((r) => r.suite === "main");
  const change = (r: Cell) => r.arms.affineOutput.cost / r.arms.legacyOutputRatio.cost - 1;
  const sorted = [...main].sort(
    (a, b) => change(a) - change(b) || a.profile.localeCompare(b.profile) || a.steps - b.steps,
  );
  const control = main.find(
    (r) => r.profile === "deepseek-flash-peak" && r.steps === 240 && change(r) === 0,
  );
  const best = sorted[0],
    worst = sorted.at(-1);
  if (!best || !worst || !control) throw new Error("Missing declared diagnostic cells");
  return [
    { role: "worst" as const, cell: worst },
    { role: "best" as const, cell: best },
    { role: "unchanged" as const, cell: control },
  ];
}

export function captureForecastBranch(scenario: Scenario, affineOutput: boolean) {
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
      const decision = base.decide(r);
      if (!pendingSnapshot || !pendingEstimate) throw new Error("Missing frozen metadata snapshot");
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

export function comparePath(
  bill: RuntimeForecastBill,
  actual: ReturnType<typeof blank>[],
  actions: string[],
) {
  const count = Math.min(bill.steps.length, actual.length);
  if (!count) throw new Error("No matched forecast calls");
  const weights = bill.steps.slice(0, count).map((s) => s.survival);
  const weightedForecast = sumForecastBills(bill, count);
  const weightedActual = sumObservedBills(actual.slice(0, count), weights);
  const rawForecast = bill.steps.slice(0, count).reduce((b, s) => {
    b.ordinaryInputCost += s.ordinaryInputCost;
    b.summaryCost += s.summaryCost;
    b.prewarmCost += s.prewarmCost;
    b.summaryCalls += Number(s.compact);
    b.prewarmCalls += Number(s.prewarmCost > 0);
    return b;
  }, blank());
  const rawActual = sumObservedBills(actual.slice(0, count));
  return {
    matchedCalls: count,
    weightedForecast,
    weightedActual,
    rawForecast,
    rawActual,
    weightedInputFeeGap: total(weightedActual) - total(weightedForecast),
    rawInputFeeGap: total(rawActual) - total(rawForecast),
    scheduleMismatchCalls: bill.steps
      .slice(0, count)
      .filter((s, i) => s.compact !== (actions[i] !== "KEEP"))
      .map((s) => s.call),
    ordinaryOutputExcluded: true,
  };
}

/** Reconstruct the very same nominal inner-screen state, without revealing future observations. */
export function projectedState(
  snapshot: Snapshot,
  path: RuntimeForecastBill,
  index: number,
): Snapshot {
  const row = path.steps[index],
    previous = path.steps[index - 1];
  const { input, baseline, options } = structuredClone(snapshot);
  const tokenModel = options.compactorTokenModel,
    constraints = options.executionConstraints;
  if (!row || !previous || !tokenModel || !constraints || !options.cycleBilling)
    throw new Error("Incomplete projected state");
  const m = baseline.metrics;
  const coverage = m.estimatedCacheLaterCandidateTokens / input.contextTokens;
  const shared = previous.afterTokens * coverage;
  const alive = m.estimatedCacheLaterAliveProbability;
  const prices = resolveUnitPrices(input.profile.pricing);
  const post = predictCompactorTokens(tokenModel, row.beforeTokens).afterTokens;
  const rebuilt = postCompactBill(prices, post, prices.hasCacheDiscount, options.cycleBilling);
  let callsSinceAttempt = m.callsSinceLastAttempt,
    hasAttempt = constraints.hasAttempt;
  for (const s of path.steps.slice(0, index)) {
    if (s.compact) {
      callsSinceAttempt = 0;
      hasAttempt = true;
    }
    callsSinceAttempt++;
  }
  const nextBaseline = {
    ...baseline,
    action: "KEEP" as const,
    reasons: baseline.reasons.filter(
      (r) =>
        ![
          "COOLDOWN_ACTIVE",
          "INSUFFICIENT_RECLAIM_TOKENS",
          "INSUFFICIENT_RECLAIM_RATIO",
          "BELOW_SOFT_WINDOW",
        ].includes(r),
    ),
    metrics: {
      ...m,
      callsSinceLastAttempt: callsSinceAttempt,
      estimatedCurrentCallReplayCost: costOfCall(prices, row.beforeTokens, {
        prefixTokens: shared,
        aliveProbability: alive,
        cachingInPlay: prices.hasCacheDiscount,
      }),
      estimatedCompactCallCost: summaryBill(
        prices,
        tokenModel,
        row.beforeTokens,
        shared,
        alive,
        options.cycleBilling,
      ),
      estimatedFirstPostCompactReplayCost: rebuilt.prewarm + rebuilt.ordinary,
      estimatedPostCompactTokens: post,
      estimatedCacheLaterCandidateTokens: row.beforeTokens * coverage,
      estimatedEffectiveCachedTokens: shared * alive,
      estimatedCacheAliveProbability: alive,
    },
  };
  return {
    input: {
      ...input,
      contextTokens: row.beforeTokens,
      reusablePrefixTokens: shared,
      cachedTokens: undefined,
    },
    baseline: nextBaseline,
    options: {
      ...options,
      explainBills: false,
      executionConstraints: { ...constraints, hasAttempt },
      ...(options.durationModel
        ? {
            durationModel: {
              ...options.durationModel,
              completedCalls: options.durationModel.completedCalls + index,
            },
          }
        : {}),
    },
  };
}

export function frozenRechecks(
  snapshot: Snapshot,
  estimate: RuntimeSurvivalEstimate,
  path: RuntimeForecastBill,
  side: "now" | "wait",
) {
  // Validate reconstruction on rejected screens too; they need not appear as final compactions.
  const recordedChecks = estimate.futureQualification?.[side].checks ?? [];
  const screenValidation = recordedChecks.map((recorded) => {
    const row = path.steps[recorded.call];
    if (!row || Math.abs(row.beforeTokens - recorded.context) > 1e-7)
      return { call: recorded.call, matched: false };
    const local = projectedState(snapshot, path, recorded.call);
    const recreated = estimateRuntimeSurvival(local.input, local.baseline, {
      ...local.options,
      futureQualification: undefined,
    });
    if (recreated.shouldCompact !== recorded.allowed)
      throw new Error("Rejected-screen reconstruction changed approval");
    close(recorded.expectedSaving, recreated.expectedSaving);
    close(recorded.stressedSaving, recreated.stressedSaving);
    close(recorded.requiredSaving, recreated.requiredSaving);
    return { call: recorded.call, matched: true };
  });
  const economic = path.steps.filter(
    (s) =>
      s.call > 0 &&
      s.compact &&
      s.beforeTokens < snapshot.baseline.metrics.guardedForceBoundaryTokens,
  );
  const checks = economic.slice(0, 2).map((s) => {
    const local = projectedState(snapshot, path, s.call);
    const incumbent = estimateRuntimeSurvival(local.input, local.baseline, {
      ...local.options,
      futureQualification: undefined,
    });
    const deployed = estimateRuntimeSurvival(local.input, local.baseline, local.options);
    const recorded = estimate.futureQualification?.[side].checks.find(
      (c) => c.call === s.call && Math.abs(c.context - s.beforeTokens) < 1e-7,
    );
    if (recorded) {
      if (recorded.allowed !== incumbent.shouldCompact)
        throw new Error("Inner screen reconstruction changed approval");
      close(recorded.expectedSaving, incumbent.expectedSaving);
      close(recorded.stressedSaving, incumbent.stressedSaving);
      close(recorded.requiredSaving, incumbent.requiredSaving);
    }
    return {
      call: s.call,
      context: s.beforeTokens,
      recordedScreenMatched: recorded !== undefined,
      incumbentAllowed: incumbent.shouldCompact,
      deployedAllowed: deployed.shouldCompact,
      incumbentSaving: incumbent.expectedSaving,
      deployedSaving: deployed.expectedSaving,
      incumbentStressedSaving: incumbent.stressedSaving,
      deployedStressedSaving: deployed.stressedSaving,
      requiredSaving: deployed.requiredSaving,
      incumbentEligible: incumbent.eligible,
      deployedEligible: deployed.eligible,
    };
  });
  return {
    screenValidation,
    economicAttempts: economic.length,
    checks,
    unassessedAttempts: economic.length - checks.length,
  };
}

export function auditForecastCell(cell: Cell, scenario: Scenario) {
  const legacy = captureForecastBranch(scenario, false),
    candidate = captureForecastBranch(scenario, true);
  if (
    JSON.stringify(legacy.bill) !== JSON.stringify(cell.arms.legacyOutputRatio) ||
    JSON.stringify(candidate.bill) !== JSON.stringify(cell.arms.affineOutput)
  )
    throw new Error("Snapshot replica changed frozen bills");
  const step = legacy.actions.findIndex((a, i) => a !== candidate.actions[i]);
  const identity = {
    profile: cell.profile,
    fixture: cell.fixture,
    steps: cell.steps,
    legacyBill: legacy.bill,
    candidateBill: candidate.bill,
  };
  if (step < 0) return { ...identity, status: "UNCHANGED" as const, checkpoint: null };
  if (
    JSON.stringify(legacy.actions.slice(0, step)) !==
      JSON.stringify(candidate.actions.slice(0, step)) ||
    JSON.stringify(legacy.bills.slice(0, step)) !== JSON.stringify(candidate.bills.slice(0, step))
  )
    throw new Error("Pre-divergence paths differ");
  const a = legacy.snapshots[step],
    b = candidate.snapshots[step];
  if (
    !a ||
    !b ||
    JSON.stringify(a.input) !== JSON.stringify(b.input) ||
    JSON.stringify(a.baseline) !== JSON.stringify(b.baseline)
  )
    throw new Error("First fork does not share the same state");
  const explain = (branch: typeof legacy, snapshot: Snapshot) => {
    const estimate = estimateRuntimeSurvival(snapshot.input, snapshot.baseline, {
      ...snapshot.options,
      explainBills: true,
    });
    const { forecastBills, ...unchanged } = estimate;
    if (!forecastBills || JSON.stringify(unchanged) !== JSON.stringify(branch.estimates[step]))
      throw new Error("Explanation changed the actual decision");
    const action = branch.actions[step];
    const side = action === "COMPACT" ? ("now" as const) : ("wait" as const);
    return {
      snapshot,
      action,
      estimate,
      selectedSide: side,
      comparison: comparePath(
        forecastBills[side],
        branch.bills.slice(step),
        branch.actions.slice(step),
      ),
      frozenState: {
        now: frozenRechecks(snapshot, estimate, forecastBills.now, "now"),
        wait: frozenRechecks(snapshot, estimate, forecastBills.wait, "wait"),
      },
    };
  };
  return {
    ...identity,
    status: "DIVERGED" as const,
    checkpoint: {
      step,
      context: a.input.contextTokens,
      commonPrefixFees: total(sumObservedBills(legacy.bills.slice(0, step))),
      legacy: explain(legacy, a),
      candidate: explain(candidate, b),
      actualSuffixCostDelta: candidate.bill.cost - legacy.bill.cost,
    },
  };
}

export function runForecastAudit() {
  assertAffineCostSources();
  const planHash = sourceHash(
    readFileSync(new URL("../benchmarks/forecast-execution-plan.json", import.meta.url), "utf8"),
  );
  if (planHash !== "51057c03f41112c847a9e730317115e32751e4260325f5fdfc11253c2c6547b4")
    throw new Error("Frozen forecast audit plan changed");
  const raw = readFileSync(
    new URL("../benchmarks/reports/summary-output-cost.json", import.meta.url),
    "utf8",
  );
  if (sourceHash(raw) !== "eca809fe2d5078f9e79d0a9d822c0dbee1bce3033b84f3343cb21fe5f3d5ec1e")
    throw new Error("Frozen output-cost result changed");
  const frozen = JSON.parse(raw) as Frozen;
  for (const [p, hash] of Object.entries(frozen.sourceHashes))
    if (sourceHash(readFileSync(new URL(`../${p}`, import.meta.url), "utf8")) !== hash)
      throw new Error(`Frozen source changed: ${p}`);
  const cases = affineCostCases();
  const rows = selectForecastCells(frozen.rows).map(({ role, cell }) => {
    const c = cases.find(
      (c) =>
        c.profile === cell.profile &&
        c.fixture === cell.fixture &&
        c.suite === cell.suite &&
        c.scenario.steps === cell.steps,
    );
    if (!c) throw new Error("Missing selected cell");
    const row = { role, ...auditForecastCell(cell, c.scenario) };
    console.error(`captured ${role}/${cell.profile}`);
    return row;
  });
  return {
    runner: "foldpoint.forecast-execution-audit.v1",
    paidCalls: 0,
    baselineCommit: "2f8bac6",
    planCommit: "30cd473",
    planHash,
    sourceHash: sourceHash(readFileSync(fileURLToPath(import.meta.url), "utf8")),
    frozenResultHash: sourceHash(raw),
    rows,
  };
}

export function renderForecastAudit(r: ReturnType<typeof runForecastAudit>) {
  const f = (n: number) => n.toFixed(6);
  return [
    "# 冻结状态下的预测续程与逐轮执行核对",
    "",
    "计划30cd473先冻结。只复核2f8bac6已有的最差、最好及不变对照；未调参数、未改默认、付费调用0。复制器必须逐项复现两侧原账单，解释开关也必须不改变实际估计。",
    ...r.rows.flatMap((row) => {
      const c = row.checkpoint;
      if (!c)
        return [
          "",
          `## ${row.role} / ${row.profile}`,
          "",
          "两侧完整动作序列一致，无分叉点；不制造预测偏差或填成0样本。",
        ];
      return [
        "",
        `## ${row.role} / ${row.profile} / ${row.steps}调用`,
        "",
        `首次动作分叉：0起始第${c.step}步，输入${c.context}。之前的动作/收费和当步输入/核心状态一致。新分支−旧分支实际后缀费用：${f(c.actualSuffixCostDelta)}。`,
        "",
        "| 输出模型 | 实际动作 | 名义预期节省 | 压力节省 | 所需余量 | 所选重复边界 | 同窗口加权预测输入费用 | 同窗口加权实际输入费用 | 未加权实际输入费用 | 日程不一致调用数 |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        ...(["legacy", "candidate"] as const).map((a) => {
          const v = c[a];
          return `| ${a} | ${v.action} | ${f(v.estimate.expectedSaving)} | ${f(v.estimate.stressedSaving)} | ${f(v.estimate.requiredSaving)} | ${v.estimate.selectedRepeatBoundaryTokens} | ${f(total(v.comparison.weightedForecast))} | ${f(total(v.comparison.weightedActual))} | ${f(total(v.comparison.rawActual))} | ${v.comparison.scheduleMismatchCalls.length}/${v.comparison.matchedCalls} |`;
        }),
        "",
        `原内部筛查重构核验：${(["legacy", "candidate"] as const).flatMap((a) => (["now", "wait"] as const).flatMap((side) => c[a].frozenState[side].screenValidation)).filter((v) => v.matched).length}/${(["legacy", "candidate"] as const).flatMap((a) => (["now", "wait"] as const).flatMap((side) => c[a].frozenState[side].screenValidation)).length}项匹配。以下另抽查最终日程前两次未来经济尝试；“曾被原筛查”false表示预算耗尽后默认放行，不是重构验证失败。`,
        "",
        "| 模型/预测路径 | 未来调用偏移 | 该尝试曾被原筛查 | 内部旧规则通过 | 完整两次筛查规则通过 | 内部节省 | 完整节省 | 完整压力节省 | 所需余量 |",
        "| --- | ---: | --- | --- | --- | ---: | ---: | ---: | ---: |",
        ...(["legacy", "candidate"] as const).flatMap((a) =>
          (["now", "wait"] as const).flatMap((side) =>
            c[a].frozenState[side].checks.map(
              (x) =>
                `| ${a}/${side} | ${x.call} | ${x.recordedScreenMatched} | ${x.incumbentAllowed} | ${x.deployedAllowed} | ${f(x.incumbentSaving)} | ${f(x.deployedSaving)} | ${f(x.deployedStressedSaving)} | ${f(x.requiredSaving)} |`,
            ),
          ),
        ),
      ];
    }),
    "",
    "## 边界",
    "",
    "- 实际未来模型会随观测更新，增长会抖动，任务也会结束；日程不一致或实际费用更高本身不构成代码缺陷。加权和未加权费用分列，普通输出两边对称排除，预测裁剪到真实可观察的相同窗口。",
    "- 冻结状态复核使用检查点模型、预测路径上的输入/前缀/冷却状态和对应运行时年龄，不注入后续真实观测或终点。只核对前两次未来经济尝试，排除本次和安全FORCE，其余明确未测。",
    "- 局部状态沿用现有内部筛查构造的合成基线，不是重新执行未来真实宿主的所有学习过程；其原记录的通过标记与收益指标单独核验，避免空验证。",
    "- incumbent是内部筛查使用的不带futureQualification规则；deployed是原部署的两次筛查规则。模型相同仍可能因有限深度筛查而出现规则差异；这不是完整递归求解或总费用差额的因果分摊。",
    "- 若原内部筛查记录存在且上下文相同，必须重现它的通过标记和全部收益指标；否则停止，不把重构错误当成发现。",
    "- 三条已见合成流是定位样本，不是新泛化评测；原报告、控制器、模型和Pi默认策略均未修改。",
    "",
  ].join("\n");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("usage: tsx tools/forecast-execution-audit.ts");
  const result = runForecastAudit();
  writeFileSync(
    new URL("../benchmarks/reports/forecast-execution-audit.json", import.meta.url),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  writeFileSync(
    new URL("../benchmarks/forecast-execution-audit.md", import.meta.url),
    renderForecastAudit(result),
  );
  console.log(
    JSON.stringify(
      result.rows.map((r) => ({ role: r.role, status: r.status, step: r.checkpoint?.step })),
      null,
      2,
    ),
  );
}
