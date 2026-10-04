/** Zero-network sensitivity screen, not a replay or a task-quality benchmark. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PricingSnapshot } from "../src/index";
import {
  createGuardedFixedThresholdStrategy,
  createRawFixedThresholdStrategy,
} from "./fixed-threshold";
import type { Scenario } from "./scenarios";
import { createFoldPointStrategy, runSession, type SessionMetrics } from "./simulator";

const WINDOW = 1_000_000;
export const SIMULATION_PRICES: Record<string, PricingSnapshot> = {
  cheapRead: {
    currency: "HYPOTHETICAL",
    inputPerMillion: 1,
    outputPerMillion: 4,
    cacheReadPerMillion: 0.01,
    cacheWritePerMillion: 1,
  },
  writePremium: {
    currency: "HYPOTHETICAL",
    inputPerMillion: 1,
    outputPerMillion: 5,
    cacheReadPerMillion: 0.1,
    cacheWritePerMillion: 1.25,
  },
  expensiveRead: {
    currency: "HYPOTHETICAL",
    inputPerMillion: 1,
    outputPerMillion: 5,
    cacheReadPerMillion: 0.6,
    cacheWritePerMillion: 1.25,
  },
};

export function buildMillionScenarios(): Scenario[] {
  const scenarios: Scenario[] = [];
  for (const [price, pricing] of Object.entries(SIMULATION_PRICES))
    for (const cache of ["warm", "cold", "coldAfterMidpoint"])
      for (const retention of [0.05, 0.1, 0.2])
        for (const outputRatio of [0.002, 0.01])
          for (const steps of [12, 60, 140])
            for (const growth of [16_500, 32_000]) {
              const id = `${price}-${cache}-${retention}-${outputRatio}-${steps}-${growth}`;
              scenarios.push({
                id,
                name: id,
                title: "1M synthetic sensitivity",
                seed: 73,
                contextWindowTokens: WINDOW,
                pricing,
                cachePolicy: { ttlMs: 60_000 },
                steps,
                startTokens: 4_000,
                growthPerStep: growth,
                growthJitter: 2_000,
                outputTokens: 300,
                idleMs: cache === "cold" ? 120_000 : 1_000,
                ...(cache === "coldAfterMidpoint"
                  ? { idleMsAfterStep: { fromStep: Math.floor(steps / 2), idleMs: 120_000 } }
                  : {}),
                compactor: { retentionRatio: retention, outputRatio, successRate: 1 },
              });
            }
  return scenarios;
}

function stableMetrics(metrics: SessionMetrics) {
  return {
    totalSimulatedCost: metrics.totalSimulatedCost,
    compactionAttemptCount: metrics.compactionAttemptCount,
    successfulCompactionCount: metrics.successfulCompactionCount,
    failedCompactionCount: metrics.failedCompactionCount,
    economicAttemptCount: metrics.economicAttemptCount,
    forcedAttemptCount: metrics.forcedAttemptCount,
    overflowCount: metrics.overflowCount,
    totalOfferedGrowthTokens: metrics.totalOfferedGrowthTokens,
    growthSequenceFingerprint: metrics.growthSequenceFingerprint,
  };
}

function compactRecords(run: ReturnType<typeof runSession>) {
  return run.compactions.map(
    ({ step, action, success, beforeTokens, afterTokens, attemptCost }) => ({
      step,
      action,
      success,
      beforeTokens,
      afterTokens,
      attemptCost,
    }),
  );
}

export function millionSimulationReport(scenarios = buildMillionScenarios()) {
  const rows = scenarios.map((scenario) => {
    const strategies = {
      nativeTiming: createRawFixedThresholdStrategy((WINDOW - 16_384) / WINDOW),
      fixed60: createRawFixedThresholdStrategy(0.6),
      safety70: createGuardedFixedThresholdStrategy(0.7, WINDOW),
      foldpoint: createFoldPointStrategy(scenario, {
        omitRequestCacheEvidence: true,
        defaults: { compactOutputRatio: 0.002 },
      }),
    };
    const arms = Object.fromEntries(
      Object.entries(strategies).map(([arm, strategy]) => {
        const run = runSession(scenario, strategy);
        return [arm, { metrics: stableMetrics(run.metrics), compactions: compactRecords(run) }];
      }),
    ) as Record<
      keyof typeof strategies,
      {
        metrics: ReturnType<typeof stableMetrics>;
        compactions: ReturnType<typeof compactRecords>;
      }
    >;
    return { scenario, arms };
  });
  const summary = Object.keys(SIMULATION_PRICES).map((price) => {
    const group = rows.filter((row) => row.scenario.id.startsWith(`${price}-`));
    const compared = group.filter((row) =>
      Object.values(row.arms).some((arm) => arm.metrics.successfulCompactionCount > 0),
    );
    const comparisons = (["nativeTiming", "fixed60", "safety70"] as const).map((baseline) => {
      const deltas = compared.map(
        (row) =>
          row.arms.foldpoint.metrics.totalSimulatedCost /
            row.arms[baseline].metrics.totalSimulatedCost -
          1,
      );
      return {
        baseline,
        compared: compared.length,
        wins: deltas.filter((delta) => delta < -1e-9).length,
        ties: deltas.filter((delta) => Math.abs(delta) <= 1e-9).length,
        losses: deltas.filter((delta) => delta > 1e-9).length,
        meanRelativeCostChange: deltas.length
          ? deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length
          : null,
      };
    });
    return {
      price,
      scenarios: group.length,
      noCompactionCases: group.length - compared.length,
      economicAttempts: group.reduce(
        (sum, row) => sum + row.arms.foldpoint.metrics.economicAttemptCount,
        0,
      ),
      forcedAttempts: group.reduce(
        (sum, row) => sum + row.arms.foldpoint.metrics.forcedAttemptCount,
        0,
      ),
      comparisons,
    };
  });
  return {
    kind: "foldpoint.million-simulation.v1",
    paidCalls: 0,
    policy: {
      declaredWindow: WINDOW,
      unknownHorizon: true,
      cacheEvidenceBeforeRequest: "omitted",
      piCompactOutputPrior: 0.002,
    },
    limitations: [
      "Hypothetical price ratios, not current provider quotes or bills.",
      "Independent state per strategy; fixed offered growth and output tokens. No task-quality measurement.",
      "All summaries succeed; summary truncation, content loss and provider rejection are not modeled.",
      "Summaries are billed as uncached full-input calls; no summary prompt-selection or cache-sharing model.",
      "Full-prefix cache with hard TTL. No cache warming or provider cache eviction model.",
      "nativeTiming reproduces only the threshold, not Pi's complete scheduler or summarizer.",
      "Scenario win counts are sensitivity cases, not real traffic prevalence. No parameter optimization.",
    ],
    summary,
    rows,
  };
}

export function renderMillionSimulation(
  report: ReturnType<typeof millionSimulationReport>,
): string {
  const lines = [
    "# 1M 零付费模拟：算法敏感性筛选",
    "",
    `场景 ${report.rows.length}；每场景四个独立策略分支；付费调用 0。`,
    "",
    "价格全部为假设比例；未知剩余调用数，不提前告诉 FoldPoint 真实缓存命中。没有任务质量证明。",
    "",
    "| 价格形状 | 对照 | 有压缩的场景 | 更便宜 / 相同 / 更贵 | 平均相对费用变化 |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const group of report.summary)
    for (const comparison of group.comparisons)
      lines.push(
        `| ${group.price} | ${comparison.baseline} | ${comparison.compared} | ${comparison.wins} / ${comparison.ties} / ${comparison.losses} | ${comparison.meanRelativeCostChange === null ? "n/a" : `${(comparison.meanRelativeCostChange * 100).toFixed(2)}%`} |`,
      );
  lines.push(
    "",
    "nativeTiming 只模拟原生阈值；fixed60 固定 60%；safety70 是无经济模型的 70% 防护基线，避免把安全阈值差异误当成动态算法优势。",
    "",
    ...report.summary.map(
      (group) =>
        `${group.price}：经济触发 ${group.economicAttempts} 次，安全强制 ${group.forcedAttempts} 次。`,
    ),
    "",
    "当前结果用于定位模型缺口，不用于宣传获胜。在这组未知 horizon、摘要按全输入冷计费的假设下，若经济触发为零，费用差主要来自安全边界和增长余量，而非价格驱动的主动选择。",
    "",
    "历史数据核对（未用于调整参数）：已保留的 fixed60-full 与 dynamic70-20261003 轨迹共六次摘要，输入约为压缩前上下文的 97.28%–97.35%，摘要缓存命中均为 0，压后保留约 9.19%–9.53%。这支持全输入冷计费作为本任务的近似，但不是所有 Pi 任务的通用事实，也不能验证模拟中的固定增长、TTL 或质量假设。",
    "",
    "## 假设与限制",
    "",
    ...report.limitations.map((limitation) => `- ${limitation}`),
    "",
    "每个分支拥有自己的上下文、缓存和学习状态。相同增长序列并不代表真实压缩后模型仍会走相同路径；费用结果不是旧轨迹的反事实重算。所有场景保留，不挑选获胜场景调参。",
    "",
  );
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = millionSimulationReport();
  const jsonPath = fileURLToPath(
    new URL("./reports/million-simulation-report.json", import.meta.url),
  );
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(
    new URL("./million-simulation.md", import.meta.url),
    renderMillionSimulation(report),
  );
  console.log(
    JSON.stringify(
      { paidCalls: 0, scenarios: report.rows.length, summary: report.summary },
      null,
      2,
    ),
  );
}
