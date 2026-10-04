/** Diagnostic only: no changes to strategies, future-call estimates or paid reports. */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isCachingInPlay } from "../src/cache";
import { costOfCall, resolveUnitPrices } from "../src/index";
import { createRawFixedThresholdStrategy } from "./fixed-threshold";
import { buildRuntimeSurvivalScenarios } from "./runtime-survival";
import type { Scenario } from "./scenarios";
import { createFoldPointStrategy, runSession, type SessionRun } from "./simulator";

export function summarizeFrequency(scenario: Scenario, run: SessionRun) {
  if (run.metrics.overflowRecoveryCount !== 0)
    throw new RangeError("Recovery costs need separate attribution; this audit excludes overflow");
  const prices = resolveUnitPrices(scenario.pricing);
  const cachingInPlay = isCachingInPlay(
    { cachePolicy: scenario.cachePolicy, hasCacheDiscount: prices.hasCacheDiscount },
    false,
  );
  const successful = run.compactions.filter((c) => c.success);
  const summaryCost = run.compactions.reduce((sum, c) => sum + c.attemptCost, 0);
  // In this simulator a successful compaction is immediately followed by the ordinary call.
  // This is its entire input bill, NOT an incremental penalty versus keeping the old context.
  const firstPostCompactInputCost = successful.reduce(
    (sum, c) =>
      sum +
      costOfCall(prices, c.afterTokens, { prefixTokens: 0, aliveProbability: 0, cachingInPlay }),
    0,
  );
  const ordinaryOutputCost = scenario.steps * scenario.outputTokens * prices.outputPerToken;
  const otherOrdinaryInputCost =
    run.metrics.totalSimulatedCost - summaryCost - firstPostCompactInputCost - ordinaryOutputCost;
  if (otherOrdinaryInputCost < -1e-8) throw new RangeError("Cost attribution is inconsistent");
  const gaps = successful.slice(1).map((c, i) => c.step - (successful[i]?.step ?? c.step));
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  return {
    totalCost: run.metrics.totalSimulatedCost,
    summaryCost,
    firstPostCompactInputCost,
    ordinaryOutputCost,
    otherOrdinaryInputCost: Math.max(0, otherOrdinaryInputCost),
    summaryCostShare:
      run.metrics.totalSimulatedCost > 0 ? summaryCost / run.metrics.totalSimulatedCost : 0,
    attempts: run.compactions.length,
    successes: successful.length,
    economic: run.metrics.economicAttemptCount,
    forced: run.metrics.forcedAttemptCount,
    adjacentSuccessfulPairs: gaps.filter((gap) => gap === 1).length,
    minimumGap: sortedGaps[0] ?? null,
    medianGap: sortedGaps.length ? (sortedGaps[Math.floor(sortedGaps.length / 2)] ?? null) : null,
    ordinaryCallsPerSuccess: successful.length ? scenario.steps / successful.length : null,
    firstUtilization: successful[0]
      ? successful[0].beforeTokens / scenario.contextWindowTokens
      : null,
    callsAfterFinalCompaction: successful.length
      ? scenario.steps - (successful.at(-1)?.step ?? 0)
      : null,
    shadowNonPayback: run.metrics.unnecessaryCompactionCount,
    shadowJudged: run.metrics.judgedCompactionCount,
    growthFingerprint: run.metrics.growthSequenceFingerprint,
    offeredGrowth: run.metrics.totalOfferedGrowthTokens,
    successfulSteps: successful.map((c) => c.step),
  };
}

export function frequencyReport(scenarios = buildRuntimeSurvivalScenarios()) {
  const rows = scenarios.map((scenario) => {
    const common = {
      omitRequestCacheEvidence: true,
      verifiedAppendOnlyPrefix: true,
      defaults: { compactOutputRatio: 0.002 },
      runtimeSurvival: { continuationProbability: 0.95, maxImmediateLossRatio: 1 },
    };
    const arms = {
      fixed60: summarizeFrequency(
        scenario,
        runSession(scenario, createRawFixedThresholdStrategy(0.6)),
      ),
      cacheAwareNoBudget: summarizeFrequency(
        scenario,
        runSession(scenario, createFoldPointStrategy(scenario, common)),
      ),
      cumulativeRisk1: summarizeFrequency(
        scenario,
        runSession(
          scenario,
          createFoldPointStrategy(scenario, { ...common, runtimeRiskBudgetRatio: 1 }),
        ),
      ),
    };
    const id = scenario.id.replace(/^near-end-/, "");
    const cache = id.includes("-coldAfterMidpoint-")
      ? "coldAfterMidpoint"
      : id.includes("-cold-")
        ? "cold"
        : "warm";
    return {
      id: scenario.id,
      suite: scenario.id.startsWith("near-end-") ? "near-end" : "matrix",
      steps: scenario.steps,
      cache,
      arms,
    };
  });
  const summary = [12, 60, 140].flatMap((steps) =>
    ["warm", "cold", "coldAfterMidpoint"].flatMap((cache) =>
      (["fixed60", "cacheAwareNoBudget", "cumulativeRisk1"] as const).map((arm) => {
        const selected = rows.filter(
          (r) => r.suite === "matrix" && r.steps === steps && r.cache === cache,
        );
        const compared = selected.filter(
          (r) => r.arms[arm].attempts > 0 || r.arms.fixed60.attempts > 0,
        );
        const deltas = compared.map((r) => r.arms[arm].totalCost / r.arms.fixed60.totalCost - 1);
        const totalCost = selected.reduce((sum, r) => sum + r.arms[arm].totalCost, 0);
        const summaryCost = selected.reduce((sum, r) => sum + r.arms[arm].summaryCost, 0);
        const gaps = selected.flatMap((r) =>
          r.arms[arm].minimumGap === null ? [] : [r.arms[arm].minimumGap],
        );
        return {
          steps,
          cache,
          arm,
          scenarios: selected.length,
          compared: compared.length,
          excludedNoCompaction: selected.length - compared.length,
          wins: deltas.filter((d) => d < -1e-9).length,
          losses: deltas.filter((d) => d > 1e-9).length,
          meanRelativeCost: deltas.length
            ? deltas.reduce((a, b) => a + b, 0) / deltas.length
            : null,
          worstRelativeCost: deltas.length ? Math.max(...deltas) : null,
          attempts: selected.reduce((sum, r) => sum + r.arms[arm].attempts, 0),
          adjacentPairs: selected.reduce((sum, r) => sum + r.arms[arm].adjacentSuccessfulPairs, 0),
          minimumGap: gaps.length ? Math.min(...gaps) : null,
          aggregateSummaryCostShare: totalCost > 0 ? summaryCost / totalCost : 0,
        };
      }),
    ),
  );
  return {
    kind: "foldpoint.compaction-frequency-audit.v1",
    paidCalls: 0,
    policyChanged: false,
    taskQualityMeasured: false,
    limitations: [
      "Synthetic 1M matrix with identical offered growth; no real task quality or provider cache evidence.",
      "q=0.95 is an uncalibrated diagnostic prior, not a selected production default.",
      "All summary attempts are billed; first post-compaction input is part of ordinary input, not added again.",
      "First post-compaction input is a full bill, not an incremental cache rebuilding penalty or avoidable overhead.",
      "Calls/compaction and adjacent pairs describe frequency, not a validated quality limit.",
      "Costs use hypothetical prices; group means are unweighted sensitivity summaries, not real traffic savings.",
      "Cold-cache future reuse prediction can be optimistic; this audit does not change that model.",
      "Endpoint and true retention are used only for evaluation, never supplied to policy decisions.",
    ],
    summary,
    rows,
  };
}

export function renderFrequency(report: ReturnType<typeof frequencyReport>) {
  return [
    "# 压缩频率与费用归因：零付费诊断",
    "",
    "不改默认算法，不选择获胜参数。摘要、压缩后首次输入、其他普通输入、普通输出四项互不重复。压缩后首次输入并不等于额外损失；应与未压缩的输入费用对照。",
    "",
    "| 调用数 | 缓存 | 分支 | 比较数 | 胜/负 | 平均费用变化 | 压缩尝试 | 最短压缩间隔/调用 | 摘要占总费用 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.summary.map(
      (s) =>
        `| ${s.steps} | ${s.cache} | ${s.arm} | ${s.compared} | ${s.wins}/${s.losses} | ${s.meanRelativeCost === null ? "—" : `${(100 * s.meanRelativeCost).toFixed(2)}%`} | ${s.attempts} | ${s.minimumGap ?? "—"} | ${(100 * s.aggregateSummaryCostShare).toFixed(2)}% |`,
    ),
    "",
    "近结束的 27 个案例仍全部保留在 JSON 明细中，不因结果好坏移除。无压缩双方不计入胜负。步骤号、最后一次压缩之后的调用数只用于事后审计，不用于触发决策。",
    "callsAfterFinalCompaction 包含紧接最后一次摘要的普通调用；最短/中位间隔来自成功压缩步骤差，不把会话结尾的短区间当作压缩间隔。",
    "",
    "## 限制",
    "",
    ...report.limitations.map((line) => `- ${line}`),
    "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = frequencyReport();
  const path = fileURLToPath(new URL("./reports/compaction-frequency.json", import.meta.url));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("../node_modules/@biomejs/biome/bin/biome", import.meta.url)),
      "format",
      "--write",
      path,
    ],
    { stdio: "pipe" },
  );
  writeFileSync(new URL("./compaction-frequency.md", import.meta.url), renderFrequency(report));
  console.log(
    JSON.stringify(
      {
        paidCalls: 0,
        scenarios: report.rows.length,
        longRunSummary: report.summary.filter((s) => s.steps === 140),
      },
      null,
      2,
    ),
  );
}
