/** Zero-paid experiment: no task endpoint enters a survival policy. */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  estimateRuntimeSurvival,
  FoldPoint,
  type FoldPointInput,
  type RuntimeRiskBudget,
} from "../src/index";
import { createRawFixedThresholdStrategy } from "./fixed-threshold";
import { buildMillionScenarios } from "./million-simulation";
import type { Scenario } from "./scenarios";
import { createFoldPointStrategy, runSession } from "./simulator";

export const SURVIVAL_PROFILES = [
  {
    id: "q80-loss1",
    continuationProbability: 0.8,
    maxImmediateLossRatio: 1,
    runtimeRiskBudgetRatio: 1,
  },
  {
    id: "q95-loss1",
    continuationProbability: 0.95,
    maxImmediateLossRatio: 1,
    runtimeRiskBudgetRatio: 1,
  },
  {
    id: "q99-loss1",
    continuationProbability: 0.99,
    maxImmediateLossRatio: 1,
    runtimeRiskBudgetRatio: 1,
  },
  {
    id: "q95-loss3",
    continuationProbability: 0.95,
    maxImmediateLossRatio: 3,
    runtimeRiskBudgetRatio: 3,
  },
] as const;

export function buildRuntimeSurvivalScenarios(): Scenario[] {
  const matrix = buildMillionScenarios();
  // Endpoints deliberately near a possible trigger. No access by the policy to steps.
  const adversarial = matrix
    .filter(
      (s) =>
        s.steps === 12 &&
        s.compactor.retentionRatio === 0.1 &&
        s.compactor.outputRatio === 0.002 &&
        s.growthPerStep === 16_500,
    )
    .flatMap((base) =>
      [1, 2, 4].map((steps) => ({
        ...base,
        id: `near-end-${base.id}-${steps}`,
        steps,
        startTokens: 550_000,
        growthJitter: 0,
        ...(base.idleMsAfterStep
          ? {
              idleMsAfterStep: {
                ...base.idleMsAfterStep,
                fromStep: Math.floor(steps / 2),
              },
            }
          : {}),
      })),
    );
  return [...matrix, ...adversarial];
}

export function runtimeSurvivalReport(scenarios = buildRuntimeSurvivalScenarios()) {
  const rows = scenarios.map((scenario) => {
    const riskReports: Record<string, ReturnType<RuntimeRiskBudget["report"]>> = {};
    const calibration: Record<
      string,
      {
        samples: number;
        estimated: number;
        actual: number;
        worstOverestimateRatio: number;
        worstEstimated: number;
        worstActual: number;
      }
    > = {};
    const audit = (id: string) => ({
      onRuntimeRisk: (report: ReturnType<RuntimeRiskBudget["report"]>) => {
        riskReports[id] = report;
      },
      onReplayCalibration: (estimated: number, actual: number) => {
        const entry = calibration[id] ?? {
          samples: 0,
          estimated: 0,
          actual: 0,
          worstOverestimateRatio: 0,
          worstEstimated: 0,
          worstActual: 0,
        };
        entry.samples += 1;
        entry.estimated += estimated;
        entry.actual += actual;
        if (actual > 0 && estimated / actual > entry.worstOverestimateRatio) {
          entry.worstOverestimateRatio = estimated / actual;
          entry.worstEstimated = estimated;
          entry.worstActual = actual;
        }
        calibration[id] = entry;
      },
    });
    const strategies = {
      current: createFoldPointStrategy(scenario, {
        ...audit("current"),
        omitRequestCacheEvidence: true,
        defaults: { compactOutputRatio: 0.002 },
      }),
      fixed60: createRawFixedThresholdStrategy(0.6),
      forceOnlyV1: createFoldPointStrategy(scenario, {
        ...audit("forceOnlyV1"),
        omitRequestCacheEvidence: true,
        defaults: { compactOutputRatio: 0.002 },
        runtimeSurvival: {
          continuationProbability: 0.95,
          maxImmediateLossRatio: 1,
          allowWaitOne: false,
        },
      }),
      waitOneNoBudget: createFoldPointStrategy(scenario, {
        ...audit("waitOneNoBudget"),
        omitRequestCacheEvidence: true,
        defaults: { compactOutputRatio: 0.002 },
        runtimeSurvival: { continuationProbability: 0.95, maxImmediateLossRatio: 1 },
      }),
      ...Object.fromEntries(
        SURVIVAL_PROFILES.map(({ id, runtimeRiskBudgetRatio, ...runtimeSurvival }) => [
          id,
          createFoldPointStrategy(scenario, {
            ...audit(id),
            omitRequestCacheEvidence: true,
            defaults: { compactOutputRatio: 0.002 },
            runtimeSurvival,
            runtimeRiskBudgetRatio,
          }),
        ]),
      ),
    };
    const arms = Object.fromEntries(
      Object.entries(strategies).map(([name, strategy]) => {
        const run = runSession(scenario, strategy);
        const m = run.metrics;
        return [
          name,
          {
            cost: m.totalSimulatedCost,
            runtimeRisk: riskReports[name] ?? null,
            preDecisionReplayCalibration: calibration[name] ?? null,
            economic: m.economicAttemptCount,
            forced: m.forcedAttemptCount,
            overflow: m.overflowCount,
            unneeded: m.unnecessaryCompactionCount,
            judged: m.judgedCompactionCount,
            growthFingerprint: m.growthSequenceFingerprint,
            offeredGrowth: m.totalOfferedGrowthTokens,
            compactionSteps: run.compactions.map((c) => c.step),
            firstCompactionUtilization: run.compactions[0]
              ? run.compactions[0].beforeTokens / scenario.contextWindowTokens
              : null,
          },
        ];
      }),
    );
    return { id: scenario.id, steps: scenario.steps, arms };
  });
  const summary = ["matrix", "near-end"].flatMap((suite) =>
    SURVIVAL_PROFILES.flatMap((profile) =>
      ["current", "fixed60", "forceOnlyV1", "waitOneNoBudget"].map((baseline) => {
        const selected = rows.filter(
          (r) => r.id.startsWith("near-end-") === (suite === "near-end"),
        );
        const compared = selected.filter((r) =>
          [r.arms[profile.id], r.arms[baseline]].some((a) => a && a.compactionSteps.length > 0),
        );
        const deltas = compared.map(
          (r) => (r.arms[profile.id]?.cost ?? 0) / (r.arms[baseline]?.cost ?? 1) - 1,
        );
        return {
          suite,
          profile: profile.id,
          baseline,
          scenarios: selected.length,
          compared: compared.length,
          noCompactionCases: selected.length - compared.length,
          wins: deltas.filter((d) => d < -1e-9).length,
          losses: deltas.filter((d) => d > 1e-9).length,
          meanRelativeChange: deltas.length
            ? deltas.reduce((a, b) => a + b, 0) / deltas.length
            : null,
          worstRelativeChange: deltas.length ? Math.max(...deltas) : null,
          economic: selected.reduce((s, r) => s + (r.arms[profile.id]?.economic ?? 0), 0),
          unneeded: selected.reduce((s, r) => s + (r.arms[profile.id]?.unneeded ?? 0), 0),
          judged: selected.reduce((s, r) => s + (r.arms[profile.id]?.judged ?? 0), 0),
          overflow: selected.reduce((s, r) => s + (r.arms[profile.id]?.overflow ?? 0), 0),
          attempts: selected.reduce(
            (s, r) => s + (r.arms[profile.id]?.compactionSteps.length ?? 0),
            0,
          ),
          firstCompactionBelow20Percent: selected.filter((r) => {
            const first = r.arms[profile.id]?.firstCompactionUtilization;
            return first !== null && first !== undefined && first < 0.2;
          }).length,
          runtimeRiskOverspends: selected.filter((r) => r.arms[profile.id]?.runtimeRisk?.overBudget)
            .length,
        };
      }),
    ),
  );
  return {
    kind: "foldpoint.runtime-survival-experiment.v2",
    paidCalls: 0,
    profiles: SURVIVAL_PROFILES,
    horizonCap: 64,
    limitations: [
      "Explicit uncalibrated priors, not estimated task progress or future user commands.",
      "No held-out endpoint, true retention or future cache condition is supplied to the policy.",
      "All original 1M simulation limitations apply; summary success and unchanged task output are assumed.",
      "Geometric survival, constant observed growth and future cache reuse can be wrong.",
      "WAIT compares safety-only waiting with compaction after one call; both are bounded forecast schedules, not full optimal control or a guarantee of information gain.",
      "Runtime risk budget is fixed from the first request estimated replay cost (ratios 1/3), charged conservatively without presumed payback refunds. Not a hard actual expense bound.",
      "Look-ahead truncated at 64 calls; q=0.99 leaves 52.6% survival probability beyond it.",
      "Policy refuses economic triggers if unmodeled tail probability exceeds 5%; q99 therefore falls back to safety.",
      "Immediate-loss budget is conditional on estimated costs, not an actual spending cap.",
      "Unneeded uses the existing bounded shadow interval, not a global optimum.",
      "Sensitivity cases do not establish real task-quality or majority-traffic savings.",
    ],
    summary,
    rows,
  };
}

export function renderRuntimeSurvival(report: ReturnType<typeof runtimeSurvivalReport>) {
  const worst = report.rows
    .filter((r) => r.id.startsWith("near-end-"))
    .sort(
      (a, b) =>
        (b.arms["q95-loss1"]?.cost ?? 0) / (b.arms.current?.cost ?? 1) -
        (a.arms["q95-loss1"]?.cost ?? 0) / (a.arms.current?.cost ?? 1),
    )[0];
  const calibration = worst?.arms["q95-loss1"]?.preDecisionReplayCalibration;
  return [
    "# Runtime 继续概率：零付费实验",
    "",
    "实验策略未接管 Pi，也未替换核心默认策略。参数预先列举作敏感性检查，不选择获胜参数作默认。",
    "",
    "平均成本变化是逐场景相对差值的算术平均；不是实际用户流量加权结果。无压缩场景不计为胜利。",
    "",
    "| 场景组 | 参数 | 基线 | 比较数 | 胜/负 | 平均变化 | 最坏变化 | 经济压缩 | 未回本/判定 | 溢出 | 首压<20%的场景 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.summary.map(
      (s) =>
        `| ${s.suite} | ${s.profile} | ${s.baseline} | ${s.compared} | ${s.wins}/${s.losses} | ${s.meanRelativeChange === null ? "—" : `${(100 * s.meanRelativeChange).toFixed(2)}%`} | ${s.worstRelativeChange === null ? "—" : `${(100 * s.worstRelativeChange).toFixed(2)}%`} | ${s.economic} | ${s.unneeded}/${s.judged} | ${s.overflow} | ${s.firstCompactionBelow20Percent} |`,
    ),
    "",
    "## 仍未解决的成本估计偏差",
    "",
    "增加等待一轮和累计风险预算只修比较路径与风险累积，不能保证基础成本估计准确。以下是按相对损失选择的最坏近结束场景，作为审计示例，不是策略特判。",
    ...(worst && calibration
      ? [
          `场景 ${worst.id}：最坏单次 KEEP 输入费用估计 ${calibration.worstEstimated.toFixed(6)}，模拟真实缓存状态计价 ${calibration.worstActual.toFixed(6)}，高估 ${calibration.worstOverestimateRatio.toFixed(2)} 倍。该诊断在策略之外计算，真实缓存用量没有反向传给策略。`,
          "初次请求缓存命中为零，不等于它写回的前缀在下一次请求仍不可用。当前按历史命中覆盖度预测本次缓存的路径可能混淆这两者，因此立即结束损失估计也可能过低；风险账本不超预算不意味着真实损失被限制。应先验证缓存重建后的费用校准，再做付费收益测试。",
        ]
      : []),
    "",
    "## 限制",
    "",
    ...report.limitations.map((s) => `- ${s}`),
    "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runtimeSurvivalReport();
  const path = fileURLToPath(new URL("./reports/runtime-survival-report.json", import.meta.url));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  // Keep generated numeric arrays compatible with the repository formatter, without network.
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
  writeFileSync(new URL("./runtime-survival.md", import.meta.url), renderRuntimeSurvival(report));
  const probeInput: FoldPointInput = {
    sessionId: "latency-probe",
    contextTokens: 500_000,
    timestamp: 1,
    profile: {
      model: "probe",
      compactorId: "probe",
      contextWindowTokens: 1_000_000,
      pricing: { inputPerMillion: 1, outputPerMillion: 4, cacheReadPerMillion: 0.1 },
    },
  };
  const baseline = new FoldPoint().decide(probeInput);
  baseline.metrics.estimatedGrowthTokensPerCall = 10_000;
  const probeOptions = { continuationProbability: 0.95, maxImmediateLossRatio: 1 };
  for (let i = 0; i < 1_000; i++) estimateRuntimeSurvival(probeInput, baseline, probeOptions);
  const samples = Array.from({ length: 2_000 }, () => {
    const start = performance.now();
    estimateRuntimeSurvival(probeInput, baseline, probeOptions);
    return performance.now() - start;
  }).sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        paidCalls: 0,
        scenarios: report.rows.length,
        evaluatorOnlyWarmLatencyMs: {
          p50: samples[1_000],
          p95: samples[1_900],
          samples: 2_000,
          note: "local microbenchmark, excludes core/Pi/LLM; not persisted or a latency SLA",
        },
        summary: report.summary,
      },
      null,
      2,
    ),
  );
}
