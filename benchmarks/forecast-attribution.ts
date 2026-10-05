/** One online-selected intervention, not a new deployment policy or an oracle controller. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  estimateRuntimeSurvival,
  type RuntimeForecastBill,
  type RuntimeSurvivalEstimate,
  resolveUnitPrices,
} from "../src/index";
import { DURATION_PRIOR } from "./duration-mixture";
import type { Strategy } from "./fixed-threshold";
import { collectCompactorHistory } from "./history-reuse";
import type { Scenario } from "./scenarios";
import { createFoldPointStrategy, runSession } from "./simulator";
import { type buildWarmLengthReport, warmLengthCases } from "./warm-length-seed";

type Snapshot = Parameters<
  NonNullable<NonNullable<Parameters<typeof createFoldPointStrategy>[1]>["onSurvivalSnapshot"]>
>[0];
type StepBill = {
  ordinaryInputCost: number;
  ordinaryOutputCost: number;
  summaryCost: number;
  prewarmCost: number;
  summaryCalls: number;
  prewarmCalls: number;
};
const blank = (): StepBill => ({
  ordinaryInputCost: 0,
  ordinaryOutputCost: 0,
  summaryCost: 0,
  prewarmCost: 0,
  summaryCalls: 0,
  prewarmCalls: 0,
});
export const ATTRIBUTION_SELECTION = {
  minimumCompletedCalls: 20,
  seed: 151,
  steps: 360,
  suite: "main",
} as const;
export function attributionCases() {
  return warmLengthCases().filter(
    (c) =>
      c.seed === ATTRIBUTION_SELECTION.seed &&
      c.steps === ATTRIBUTION_SELECTION.steps &&
      c.suite === ATTRIBUTION_SELECTION.suite,
  );
}
function runBranch(scenario: Scenario, intervene: boolean, minimumCompletedCalls: number) {
  const history = collectCompactorHistory({ ...scenario, cycleBilling: undefined });
  let snapshot: Snapshot | undefined;
  let estimate: RuntimeSurvivalEstimate | undefined;
  let checkpoint:
    | { step: number; snapshot: Snapshot; estimate: RuntimeSurvivalEstimate }
    | undefined;
  const bills = Array.from({ length: scenario.steps }, blank);
  const actions: string[] = [];
  const prices = resolveUnitPrices(scenario.pricing);
  const base = createFoldPointStrategy(scenario, {
    learnedCompactorTokens: true,
    compactorHistory: history.observations,
    warmCoreFromHistory: true,
    enforceForecastExecutionGates: true,
    omitRequestCacheEvidence: true,
    verifiedAppendOnlyPrefix: true,
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
    },
    onSurvivalSnapshot: (s) => {
      snapshot = s;
    },
    onSurvivalEstimate: (e) => {
      estimate = e;
    },
  });
  const strategy: Strategy = {
    ...base,
    decide(request) {
      const decision = base.decide(request);
      if (!snapshot || !estimate) throw new Error("missing online evidence");
      const qualifies =
        !checkpoint &&
        request.step >= minimumCompletedCalls &&
        decision.action === "KEEP" &&
        estimate.eligible &&
        estimate.selectedRepeatBoundaryTokens !== null &&
        request.contextTokens >= estimate.selectedRepeatBoundaryTokens;
      if (qualifies)
        checkpoint = {
          step: request.step,
          snapshot: structuredClone(snapshot),
          estimate: structuredClone(estimate),
        };
      const result =
        qualifies && intervene ? { ...decision, action: "COMPACT" as const } : decision;
      actions.push(result.action);
      return result;
    },
    onRequest(e) {
      const b = bills[e.step];
      if (!b) throw new Error("missing step bill");
      b.ordinaryOutputCost += e.outputTokens * prices.outputPerToken;
      b.ordinaryInputCost += e.cost - e.outputTokens * prices.outputPerToken;
      base.onRequest?.(e);
    },
    onCompaction(e) {
      const b = bills[e.step];
      if (!b) throw new Error("missing step bill");
      b.summaryCost += e.cost;
      b.summaryCalls++;
      base.onCompaction?.(e);
    },
    onPrewarm(e) {
      const b = bills[e.step];
      if (!b) throw new Error("missing step bill");
      b.prewarmCost += e.cost;
      b.prewarmCalls++;
      base.onPrewarm?.(e);
    },
  };
  const run = runSession(scenario, strategy);
  const totals = bills.reduce((a, b) => {
    for (const k of Object.keys(a) as (keyof StepBill)[]) a[k] += b[k];
    return a;
  }, blank());
  const cost =
    totals.ordinaryInputCost + totals.ordinaryOutputCost + totals.summaryCost + totals.prewarmCost;
  if (run.metrics.overflowRecoveryCount || Math.abs(cost - run.metrics.totalSimulatedCost) > 1e-8)
    throw new Error("unreconciled fork ledger");
  return {
    cost,
    totals,
    bills,
    actions,
    checkpoint,
    fingerprint: run.metrics.growthSequenceFingerprint,
    compactions: run.compactions.map((c) => ({
      step: c.step,
      action: c.action,
      success: c.success,
      beforeTokens: c.beforeTokens,
      afterTokens: c.afterTokens,
      summaryCost: c.attemptCost,
    })),
  };
}
export function sumObservedBills(bills: StepBill[], weights?: number[]) {
  if (weights && weights.length !== bills.length) throw new Error("weight length mismatch");
  return bills.reduce((a, b, i) => {
    const w = weights?.[i] ?? 1;
    for (const k of Object.keys(a) as (keyof StepBill)[]) a[k] += w * b[k];
    return a;
  }, blank());
}
export function sumForecastBills(bill: RuntimeForecastBill, count: number) {
  if (!Number.isSafeInteger(count) || count < 1 || count > bill.steps.length)
    throw new Error("invalid prefix length");
  return bill.steps.slice(0, count).reduce((a, b) => {
    a.ordinaryInputCost += b.survival * b.ordinaryInputCost;
    a.summaryCost += b.survival * b.summaryCost;
    a.prewarmCost += b.survival * b.prewarmCost;
    a.summaryCalls += b.survival * Number(b.compact);
    a.prewarmCalls += b.survival * Number(b.prewarmCost > 0);
    return a;
  }, blank());
}
function difference(wait: StepBill, now: StepBill) {
  const d = blank();
  for (const k of Object.keys(d) as (keyof StepBill)[]) d[k] = wait[k] - now[k];
  return {
    ...d,
    saving: d.ordinaryInputCost + d.ordinaryOutputCost + d.summaryCost + d.prewarmCost,
  };
}
export function forecastAttributionCase(scenario: Scenario, minimumCompletedCalls = 20) {
  if (!Number.isSafeInteger(minimumCompletedCalls) || minimumCompletedCalls < 0)
    throw new RangeError("invalid checkpoint cutoff");
  const wait = runBranch(scenario, false, minimumCompletedCalls);
  const now = runBranch(scenario, true, minimumCompletedCalls);
  if (wait.fingerprint !== now.fingerprint || wait.checkpoint?.step !== now.checkpoint?.step)
    throw new Error("fork mismatch");
  const checkpoint = wait.checkpoint;
  if (!checkpoint)
    return { status: "NOT_APPLICABLE" as const, wait, now, checkpoint: null, comparison: null };
  const step = checkpoint.step;
  if (
    JSON.stringify(wait.bills.slice(0, step)) !== JSON.stringify(now.bills.slice(0, step)) ||
    JSON.stringify(wait.actions.slice(0, step)) !== JSON.stringify(now.actions.slice(0, step)) ||
    JSON.stringify(checkpoint) !== JSON.stringify(now.checkpoint)
  )
    throw new Error("pre-intervention paths differ");
  const explained = estimateRuntimeSurvival(
    checkpoint.snapshot.input,
    checkpoint.snapshot.baseline,
    { ...checkpoint.snapshot.options, explainBills: true },
  );
  const { forecastBills, ...unchanged } = explained;
  if (!forecastBills || JSON.stringify(unchanged) !== JSON.stringify(checkpoint.estimate))
    throw new Error("explanation changed estimate");
  const remaining = scenario.steps - step;
  const count = Math.min(remaining, forecastBills.now.steps.length);
  const weights = forecastBills.now.steps.slice(0, count).map((s) => s.survival);
  if (
    JSON.stringify(weights) !==
    JSON.stringify(forecastBills.wait.steps.slice(0, count).map((s) => s.survival))
  )
    throw new Error("different survival weights");
  const observedWait = wait.bills.slice(step, step + count);
  const observedNow = now.bills.slice(step, step + count);
  const weighted = difference(
    sumObservedBills(observedWait, weights),
    sumObservedBills(observedNow, weights),
  );
  const unweighted = difference(sumObservedBills(observedWait), sumObservedBills(observedNow));
  const forecast = difference(
    sumForecastBills(forecastBills.wait, count),
    sumForecastBills(forecastBills.now, count),
  );
  const full = difference(
    sumObservedBills(wait.bills.slice(step)),
    sumObservedBills(now.bills.slice(step)),
  );
  const beyondForecast = difference(
    sumObservedBills(wait.bills.slice(step + count)),
    sumObservedBills(now.bills.slice(step + count)),
  );
  if (Math.abs(full.ordinaryOutputCost) > 1e-10)
    throw new Error("ordinary output does not cancel across forks");
  return {
    status: "FORKED" as const,
    wait,
    now,
    checkpoint: {
      step,
      context: checkpoint.snapshot.input.contextTokens,
      expectedSaving: explained.expectedSaving,
      stressedSaving: explained.stressedSaving,
      requiredSaving: explained.requiredSaving,
      endingRiskAllowed:
        explained.runtimeRiskAllowed &&
        explained.assessedEndingLoss <= explained.immediateLossBudget,
      forecastBills,
    },
    comparison: {
      remainingOrdinaryCalls: remaining,
      matchedCalls: count,
      callsBeyondForecast: remaining - count,
      probabilityOfUnmodeledTail: explained.probabilityOfUnmodeledTail,
      forecast,
      weightedObservedFork: weighted,
      unweightedObservedFork: unweighted,
      fullObservedFork: full,
      beyondForecastFork: beyondForecast,
      forecastMinusWeightedObservedSaving: forecast.saving - weighted.saving,
      weightingEffectOnObservedSaving: weighted.saving - unweighted.saving,
      fullCostChange: now.cost / wait.cost - 1,
    },
  };
}
type Row = ReturnType<typeof forecastAttributionCase> &
  Omit<ReturnType<typeof attributionCases>[number], "scenario">;
export function summarizeAttribution(rows: Row[]) {
  return [...new Set(rows.map((r) => r.profile))].map((profile) => {
    const group = rows.filter((r) => r.profile === profile);
    const applicable = group.flatMap((r) => (r.comparison ? [r.comparison] : []));
    const mean = (f: (c: NonNullable<Row["comparison"]>) => number) =>
      applicable.length ? applicable.reduce((n, c) => n + f(c), 0) / applicable.length : null;
    return {
      profile,
      cases: group.length,
      forked: applicable.length,
      notApplicable: group.length - applicable.length,
      wins: applicable.filter((c) => c.fullCostChange < -1e-9).length,
      losses: applicable.filter((c) => c.fullCostChange > 1e-9).length,
      meanFullCostChange: mean((c) => c.fullCostChange),
      meanForecastMinusWeightedObservedSaving: mean((c) => c.forecastMinusWeightedObservedSaving),
      meanOrdinaryInputGap: mean(
        (c) => c.forecast.ordinaryInputCost - c.weightedObservedFork.ordinaryInputCost,
      ),
      meanSummaryGap: mean((c) => c.forecast.summaryCost - c.weightedObservedFork.summaryCost),
      meanWeightingEffect: mean((c) => c.weightingEffectOnObservedSaving),
    };
  });
}
export function renderAttribution(report: {
  summary: ReturnType<typeof summarizeAttribution>;
  limitations: string[];
}) {
  const fmt = (n: number | null, scale = 1) => (n === null ? "—" : (n * scale).toFixed(4));
  return [
    "# 单次在线分叉：预测费用与逐轮执行的差距",
    "",
    "这是一次诊断性干预，不是新的压缩策略。负成本变化表示这一次干预降低完整模拟账单。",
    "",
    "| 冻结价格 | 分叉/不适用 | 完整账单胜/负 | 平均变化 | 预测−同权实际收益 | 普通输入差距 | 摘要差距 | 加权影响 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.summary.map(
      (s) =>
        `| ${s.profile} | ${s.forked}/${s.notApplicable} | ${s.wins}/${s.losses} | ${fmt(s.meanFullCostChange, 100)}% | ${fmt(s.meanForecastMinusWeightedObservedSaving)} | ${fmt(s.meanOrdinaryInputGap)} | ${fmt(s.meanSummaryGap)} | ${fmt(s.meanWeightingEffect)} |`,
    ),
    "",
    "差距的费用单位为合成美元；各价格的绝对差距不可直接比较。正差距代表预测更乐观，不等同于已证明持续时间先验或定价有错。",
    "",
    "## 限制",
    "",
    ...report.limitations.map((l) => `- ${l}`),
    "",
  ].join("\n");
}
export function forecastAttributionReport() {
  const source = readFileSync(new URL("./reports/warm-length-seed.json", import.meta.url), "utf8");
  const frozen = JSON.parse(source) as ReturnType<typeof buildWarmLengthReport>;
  const rows = attributionCases().map((c) => {
    const result = forecastAttributionCase(c.scenario);
    const control = frozen.rows.find(
      (r) =>
        r.profile === c.profile &&
        r.contract === c.contract &&
        r.sourceFixture === c.sourceFixture &&
        r.seed === c.seed &&
        r.steps === c.steps &&
        r.suite === c.suite,
    );
    if (
      !control ||
      Math.abs(control.paired.cost - result.wait.cost) > 1e-10 ||
      JSON.stringify(control.paired.compactions) !== JSON.stringify(result.wait.compactions) ||
      control.paired.fingerprint !== result.wait.fingerprint
    )
      throw new Error("frozen control changed");
    const { scenario, ...identity } = c;
    console.log(`fork audit ${identity.profile} ${identity.sourceFixture}: ${result.status}`);
    return { ...identity, ...result };
  });
  return {
    kind: "foldpoint.forecast-attribution.v1",
    externalCalls: 0,
    paidCalls: 0,
    selection: ATTRIBUTION_SELECTION,
    frozenControlSha256: createHash("sha256").update(source).digest("hex"),
    rows,
    summary: summarizeAttribution(rows),
    limitations: [
      "冻结 28 个主矩阵组合：seed 151、360 次普通调用、四种增长/压缩底噪、七组价格、摘要无共享缓存。不是新增独立数据或供应商实测。",
      "在线选择第一个完成至少 20 次调用、原算法 KEEP、执行资格有效且达到预测重复边界的点；未看到终点或未来费用，所有不适用及负结果保留。",
      "一次 NOW 干预可越过经济/结束风险门，仅用于诊断，不能直接部署；此后两路均恢复同一原算法并各自学习。默认核心、Pi、先验和安全门未改。",
      "实际分叉总费用是给定任务终点的条件结果，不是期望预测的真值。普通输出在两路相同并单列，预测不计相消的普通输出，但摘要输出、缓存重建和预热费用完整计入。",
      "同权比较仅将两路实际费用乘以相同预测存活权重，并截取共同视野；费用差距仍混合增长/压缩预测与固定预测路径对逐轮执行路径的偏差，不能直接归因为纯计价误差。",
      "加权影响量只展示该分叉路径上权重的作用，不证明持续时间先验错误；超过 256 次视野的实际费用单列，不把未知尾部当作零。",
      "成功压缩、稳定增长、同任务输出的合成假设；没有验证任务质量、失败、TTL 或真实缓存。这次不扩大为新的压缩策略。",
    ],
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = forecastAttributionReport();
  mkdirSync(new URL("./reports/", import.meta.url), { recursive: true });
  writeFileSync(
    new URL("./reports/forecast-attribution.json", import.meta.url),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync(new URL("./forecast-attribution.md", import.meta.url), renderAttribution(report));
  console.log(JSON.stringify(report.summary, null, 2));
}
