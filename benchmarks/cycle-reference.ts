/** Steady-price diagnostic, NOT a replacement for finite-task or paid trials. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CycleBilling,
  ExperimentalCompactorLearner,
  estimateRuntimeSurvival,
  FoldPoint,
  type FoldPointInput,
  resolveUnitPrices,
  stableCycleCandidates,
  thresholdCycleAverage,
} from "../src/index";
import { compactorCases } from "./compactor-model";
import { DURATION_PRIOR } from "./duration-mixture";
import { collectCompactorHistory } from "./history-reuse";
import { PRICE_PROFILES } from "./provider-ratios";

export const CYCLE_CONTRACTS: { id: string; billing: CycleBilling }[] = [
  { id: "summary-uncached", billing: {} },
  { id: "hypothetical-summary-shared-80", billing: { summarySharedPrefixRatio: 0.8 } },
  {
    id: "hypothetical-shared-80-prewarm-1",
    billing: { summarySharedPrefixRatio: 0.8, prewarmOutputTokens: 1 },
  },
];

export function cycleReferenceReport() {
  const bases = compactorCases().filter((s) => s.id.startsWith("heldout-floor-180-"));
  const rows = PRICE_PROFILES.flatMap((p) =>
    bases.flatMap((base) => {
      const history = collectCompactorHistory({ ...base, pricing: p.pricing });
      const model = new ExperimentalCompactorLearner(history.observations).snapshot();
      if (!model) throw new Error("Insufficient prior observations");
      const prices = resolveUnitPrices(p.pricing);
      const profile = {
        model: "synthetic",
        compactorId: "same-controlled-fixture",
        contextWindowTokens: 1000000,
        pricing: p.pricing,
      };
      const core = new FoldPoint({ defaults: { compactOutputRatio: 0.002 } });
      history.observations.forEach((o, i) => {
        core.recordCompaction("history", profile, {
          timestamp: i + 1,
          beforeTokens: o.beforeTokens,
          afterTokens: o.afterTokens,
          success: true,
          outputTokens: o.outputTokens,
        });
      });
      core.importState({ ...core.exportState(), sessions: {} });
      const growth = base.growthPerStep;
      for (const [i, promptTokens] of [500000 - 2 * growth, 500000 - growth].entries())
        core.observeRequest("reference", profile, {
          timestamp: 100 + i,
          promptTokens,
          cachedInputTokens: promptTokens - growth,
          outputTokens: 0,
        });
      const input: FoldPointInput = {
        sessionId: "reference",
        timestamp: 102,
        profile,
        contextTokens: 500000,
        reusablePrefixTokens: 500000 - growth,
      };
      const baseline = core.decide(input);
      return CYCLE_CONTRACTS.map((contract) => {
        const options = {
          continuationProbability: 0.95,
          maxImmediateLossRatio: 1,
          maxCalls: 256,
          rolloutMode: "renewal" as const,
          endingRiskMode: "survival-weighted" as const,
          endingLossBudgetRatio: 1,
          savingMarginBasis: "timing" as const,
          durationModel: { completedCalls: 140, components: DURATION_PRIOR },
          compactorTokenModel: model,
          cycleBilling: contract.billing,
          executionConstraints: {
            hasAttempt: false,
            minCallsBetweenCompactions: 3,
            minReclaimTokens: 4096,
            minReclaimRatio: 0.2,
            softWindowTokens: 0,
          },
        };
        const estimate = estimateRuntimeSurvival(input, baseline, options);
        const candidates = stableCycleCandidates(
          prices,
          model,
          growth,
          baseline.metrics.guardedForceBoundaryTokens,
          contract.billing,
        );
        const best = candidates.reduce((a, b) =>
          b.costPerOrdinaryCall < a.costPerOrdinaryCall ? b : a,
        );
        const fixed60 = thresholdCycleAverage(prices, model, growth, 600000, contract.billing);
        const selected =
          estimate.selectedRepeatBoundaryTokens === null
            ? null
            : thresholdCycleAverage(
                prices,
                model,
                growth,
                estimate.selectedRepeatBoundaryTokens,
                contract.billing,
              );
        return {
          profile: p.id,
          id: base.id,
          contract: contract.id,
          billing: contract.billing,
          growth,
          historyCost: history.cost,
          historySamples: history.observations.length,
          model,
          currentContext: input.contextTokens,
          guardedBoundary: baseline.metrics.guardedForceBoundaryTokens,
          shouldCompactNow: estimate.shouldCompact,
          eligible: estimate.eligible,
          expectedSaving: estimate.expectedSaving,
          stressedSaving: estimate.stressedSaving,
          requiredSaving: estimate.requiredSaving,
          assessedEndingLoss: estimate.assessedEndingLoss,
          immediateLossBudget: estimate.immediateLossBudget,
          runtimeRiskAllowed: estimate.runtimeRiskAllowed,
          expectedCalls: estimate.expectedCallsIncludingCurrent,
          selectedBoundary: estimate.selectedRepeatBoundaryTokens,
          bestStableCycle: best,
          fixed60Reference: fixed60,
          selectedReference: selected,
          selectedVsFixed60: selected
            ? selected.costPerOrdinaryCall / fixed60.costPerOrdinaryCall - 1
            : null,
          selectedVsStableBest: selected
            ? selected.costPerOrdinaryCall / best.costPerOrdinaryCall - 1
            : null,
        };
      });
    }),
  );
  const summary = PRICE_PROFILES.flatMap((p) =>
    CYCLE_CONTRACTS.map((c) => {
      const group = rows.filter((r) => r.profile === p.id && r.contract === c.id);
      return {
        profile: p.id,
        contract: c.id,
        cases: group.length,
        meanSelectedVsFixed60:
          group.reduce((s, r) => s + (r.selectedVsFixed60 ?? 0), 0) / group.length,
        meanSelectedVsStableBest:
          group.reduce((s, r) => s + (r.selectedVsStableBest ?? 0), 0) / group.length,
        meanBestBoundary: group.reduce((s, r) => s + r.bestStableCycle.before, 0) / group.length,
        meanSelectedBoundary:
          group.reduce((s, r) => s + (r.selectedBoundary ?? 0), 0) / group.length,
        compactNow: group.filter((r) => r.shouldCompactNow).length,
      };
    }),
  );
  return {
    kind: "foldpoint.warm-cycle-reference.v1",
    ordinaryOutputTokens: 0,
    externalCalls: 0,
    paidCalls: 0,
    rows,
    summary,
    limitations: [
      "稳态诊断，不是新的长任务实测胜率：无任务终点、无缓存过期、无失败、无重试、无质量评测。固定 60% 只是同假设下的周期参考费用。",
      "摘要共享 80% 与额外输出 1 token 的预热是显式假设，不是 Pi 的实测缓存命中率；不同摘要提示词可能完全不共享缓存。",
      "保留/输出模型只拟合先前独立模拟会话的成功反馈，不给策略真实底座；测试组合已经看过，不是新盲测。历史采集费用独立保留，不计为免费。",
      "稳定 n 调用循环按仿射固定点求解；阈值循环可能长短交替，均要求至少 3 次普通调用，先丢弃 100 周期，再聚合 1000 周期总费用/普通工作调用数。阈值跨越有增长 overshoot，未模拟安全提前打断；它是参考族，不保证覆盖所有策略。",
      "普通工作调用作分母；摘要与预热额外收费，不能靠增加请求数降低单位成本。默认核心、Pi、原完整任务 simulator 与旧报告均未切换。",
      "普通输出设为 0，只比较输入/摘要/预热费用；摘要和预热输出均计费。加入相同普通输出会稀释相对百分比，但不改变周期排序。这里的百分比不是完整任务总账单节省。",
      "有限 runtime 的选定边界与无限稳态的目标不同；差距只能定位待验证项，不能据此声称算法错误或真实节费。",
      "周期参考假设普通请求可读取完整的上一轮前缀；有限预测仍采用学习到的覆盖率与压力预测。引用边界后的费用是独立理想化核对，不是有限预测费用的重放。",
    ],
  };
}

export function renderCycleReference(report: ReturnType<typeof cycleReferenceReport>) {
  return [
    "# 暖缓存重复周期费用诊断",
    "",
    "负数为比固定 60% 周期参考更便宜；不是有限任务的实际节费。边界列为 token 均值。",
    "",
    "| 冻结价格配置 | 计费假设 | 选定周期 vs 60% | vs 稳定周期最低参考 | 选定边界 | 最低参考边界 | 当前建议压缩 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.summary.map(
      (s) =>
        `| ${s.profile} | ${s.contract} | ${(s.meanSelectedVsFixed60 * 100).toFixed(2)}% | ${(s.meanSelectedVsStableBest * 100).toFixed(2)}% | ${Math.round(s.meanSelectedBoundary)} | ${Math.round(s.meanBestBoundary)} | ${s.compactNow}/${s.cases} |`,
    ),
    "",
    "## 限制",
    "",
    ...report.limitations.map((s) => `- ${s}`),
    "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = cycleReferenceReport();
  mkdirSync(new URL("./reports/", import.meta.url), { recursive: true });
  writeFileSync(
    new URL("./reports/cycle-reference.json", import.meta.url),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync(new URL("./cycle-reference.md", import.meta.url), renderCycleReference(report));
  console.log(JSON.stringify(report.summary, null, 2));
}
