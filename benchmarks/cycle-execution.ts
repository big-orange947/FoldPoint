/** Actual receding decisions versus fixed 60%, on controlled warm long tasks only. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeSurvivalEstimate } from "../src/index";
import { compactorCases } from "./compactor-model";
import { CYCLE_CONTRACTS } from "./cycle-reference";
import { DURATION_PRIOR } from "./duration-mixture";
import { createRawFixedThresholdStrategy, type Strategy } from "./fixed-threshold";
import { collectCompactorHistory } from "./history-reuse";
import { PRICE_PROFILES } from "./provider-ratios";
import type { Scenario } from "./scenarios";
import { createFoldPointStrategy, runSession } from "./simulator";

export function cycleExecutionCase(scenario: Scenario, stressWaitSelection?: "paired-policy") {
  // Collection is completed beforehand, no evaluation endpoint or future feedback is read.
  const history = collectCompactorHistory({ ...scenario, cycleBilling: undefined });
  let estimate: RuntimeSurvivalEstimate | undefined;
  const trace: {
    step: number;
    context: number;
    action: string;
    repeatBoundary: number | null;
    expectedSaving: number;
    stressedSaving: number;
    requiredSaving: number;
    eligible: boolean;
    endingRiskAllowed: boolean;
  }[] = [];
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
      stressWaitSelection,
    },
    onSurvivalEstimate: (e) => {
      estimate = e;
    },
  });
  const runLedger = (strategy: Strategy) => {
    let ordinaryCost = 0,
      summaryCost = 0,
      prewarmCost = 0,
      prewarmCount = 0;
    const run = runSession(scenario, {
      ...strategy,
      onRequest: (e) => {
        ordinaryCost += e.cost;
        strategy.onRequest?.(e);
      },
      onCompaction: (e) => {
        summaryCost += e.cost;
        strategy.onCompaction?.(e);
      },
      onPrewarm: (e) => {
        prewarmCost += e.cost;
        prewarmCount++;
        strategy.onPrewarm?.(e);
      },
    });
    const sum = ordinaryCost + summaryCost + prewarmCost;
    if (run.metrics.overflowRecoveryCount || Math.abs(sum - run.metrics.totalSimulatedCost) > 1e-8)
      throw new Error("cycle execution ledger does not reconcile");
    return {
      cost: run.metrics.totalSimulatedCost,
      ordinaryCost,
      summaryCost,
      prewarmCost,
      ordinaryCalls: scenario.steps,
      summaryCalls: run.metrics.compactionAttemptCount,
      prewarmCalls: prewarmCount,
      totalRequests: scenario.steps + run.metrics.compactionAttemptCount + prewarmCount,
      overflow: run.metrics.overflowCount,
      forced: run.metrics.forcedAttemptCount,
      economic: run.metrics.economicAttemptCount,
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
  };
  const fixed60 = runLedger(createRawFixedThresholdStrategy(0.6));
  const dynamic = runLedger({
    ...base,
    decide: (request) => {
      const decision = base.decide(request);
      if (!estimate) throw new Error("missing runtime estimate");
      trace.push({
        step: request.step,
        context: request.contextTokens,
        action: decision.action,
        repeatBoundary: estimate.selectedRepeatBoundaryTokens,
        expectedSaving: estimate.expectedSaving,
        stressedSaving: estimate.stressedSaving,
        requiredSaving: estimate.requiredSaving,
        eligible: estimate.eligible,
        endingRiskAllowed:
          estimate.runtimeRiskAllowed &&
          estimate.assessedEndingLoss <= estimate.immediateLossBudget,
      });
      return decision;
    },
  });
  const aboveAndKeep = trace.filter(
    (t) =>
      t.action === "KEEP" &&
      t.eligible &&
      t.repeatBoundary !== null &&
      t.context >= t.repeatBoundary,
  );
  let streak = 0,
    maxStreak = 0,
    start = 0,
    longest: { start: (typeof trace)[number]; end: (typeof trace)[number]; calls: number } | null =
      null;
  for (const t of trace) {
    if (
      t.action === "KEEP" &&
      t.eligible &&
      t.repeatBoundary !== null &&
      t.context >= t.repeatBoundary
    ) {
      if (streak === 0) start = t.step;
      streak++;
      if (streak > maxStreak) {
        maxStreak = streak;
        const first = trace[start];
        if (!first) throw new Error("missing trace");
        longest = { start: first, end: t, calls: streak };
      }
    } else streak = 0;
  }
  return {
    id: scenario.id,
    steps: scenario.steps,
    billing: scenario.cycleBilling ?? {},
    historySamples: history.observations.length,
    historyCost: history.cost,
    fixed60,
    dynamic,
    change: dynamic.cost / fixed60.cost - 1,
    audit: {
      decisions: trace.length,
      aboveModeledRepeatAndKeep: aboveAndKeep.length,
      stressOrMarginBlocked: aboveAndKeep.filter(
        (t) => t.expectedSaving <= t.requiredSaving || t.stressedSaving <= t.requiredSaving,
      ).length,
      endingRiskBlocked: aboveAndKeep.filter((t) => !t.endingRiskAllowed).length,
      longest,
      checkpoints: trace.filter(
        (t) => [0, 20, 60, 100, 140, 179].includes(t.step) || t.action !== "KEEP",
      ),
    },
  };
}

export function cycleExecutionReport() {
  const bases = compactorCases().filter((s) => s.id.startsWith("heldout-floor-180-"));
  const rows = PRICE_PROFILES.flatMap((p) =>
    bases.flatMap((base) =>
      CYCLE_CONTRACTS.map((c) => ({
        profile: p.id,
        contract: c.id,
        ...cycleExecutionCase({ ...base, pricing: p.pricing, cycleBilling: c.billing }),
      })),
    ),
  );
  const summary = PRICE_PROFILES.flatMap((p) =>
    CYCLE_CONTRACTS.map((c) => {
      const group = rows.filter((r) => r.profile === p.id && r.contract === c.id);
      return {
        profile: p.id,
        contract: c.id,
        cases: group.length,
        wins: group.filter((r) => r.change < -1e-9).length,
        losses: group.filter((r) => r.change > 1e-9).length,
        meanChange: group.reduce((s, r) => s + r.change, 0) / group.length,
        worstChange: Math.max(...group.map((r) => r.change)),
        economic: group.reduce((s, r) => s + r.dynamic.economic, 0),
        forced: group.reduce((s, r) => s + r.dynamic.forced, 0),
        aboveModeledRepeatAndKeep: group.reduce((s, r) => s + r.audit.aboveModeledRepeatAndKeep, 0),
        longestKeepStreak: Math.max(...group.map((r) => r.audit.longest?.calls ?? 0)),
      };
    }),
  );
  return {
    kind: "foldpoint.warm-cycle-execution.v1",
    externalCalls: 0,
    paidCalls: 0,
    rows,
    summary,
    limitations: [
      "180 次普通工作调用、1M 窗口、暖缓存长任务的完整模拟；同价格/同增长流比较固定 60% 与实际逐轮重新决策，普通输出、摘要、预热均收费。",
      "摘要共享 80% 与输出 1 token 的预热为显式合成假设，不是 Pi 的实测缓存。假设各前缀可共存、请求成功；没有改变真实 Pi 插件。",
      "历史来自事先独立模拟会话，训练费用单列；没有读取当前任务未来终点，仍使用既有未校准的持续时间先验、压力与执行门。",
      "高于预测中的重复边界但 KEEP 只是预测/行动不一致的诊断：边界属于假想 NOW 后的周期，不是当前状态的强制压缩承诺。连续等待不能单凭此计数认定为 bug。",
      "全部组合已经看过，不是盲测；保留所有负结果，不按价格特判。失败/TTL 用单元回归覆盖，主表只代表持续暖缓存成功路径，尚未验证任务质量。",
    ],
  };
}

export function renderCycleExecution(report: ReturnType<typeof cycleExecutionReport>) {
  return [
    "# 暖缓存完整任务：逐轮执行与固定 60%",
    "",
    "负数为实际完整模拟账单更低，包含普通输出、摘要及预热。不是供应商实测或任务质量证明。",
    "",
    "| 冻结价格 | 计费假设 | 胜/负 | 平均变化 | 最差变化 | 经济/强制压缩 | 高于假想重复边界仍 KEEP | 最长连续次数 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.summary.map(
      (s) =>
        `| ${s.profile} | ${s.contract} | ${s.wins}/${s.losses} | ${(s.meanChange * 100).toFixed(2)}% | ${(s.worstChange * 100).toFixed(2)}% | ${s.economic}/${s.forced} | ${s.aboveModeledRepeatAndKeep} | ${s.longestKeepStreak} |`,
    ),
    "",
    "## 限制",
    "",
    ...report.limitations.map((l) => `- ${l}`),
    "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = cycleExecutionReport();
  mkdirSync(new URL("./reports/", import.meta.url), { recursive: true });
  writeFileSync(
    new URL("./reports/cycle-execution.json", import.meta.url),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync(new URL("./cycle-execution.md", import.meta.url), renderCycleExecution(report));
  console.log(JSON.stringify(report.summary, null, 2));
}
