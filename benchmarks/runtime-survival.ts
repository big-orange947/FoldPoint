/** Zero-paid experiment: no task endpoint enters a survival policy. */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateRuntimeSurvival, FoldPoint, type FoldPointInput } from "../src/index";
import { createRawFixedThresholdStrategy } from "./fixed-threshold";
import { buildMillionScenarios } from "./million-simulation";
import type { Scenario } from "./scenarios";
import { createFoldPointStrategy, runSession } from "./simulator";

export const SURVIVAL_PROFILES = [
  { id: "q80-loss1", continuationProbability: 0.8, maxImmediateLossRatio: 1 },
  { id: "q95-loss1", continuationProbability: 0.95, maxImmediateLossRatio: 1 },
  { id: "q99-loss1", continuationProbability: 0.99, maxImmediateLossRatio: 1 },
  { id: "q95-loss3", continuationProbability: 0.95, maxImmediateLossRatio: 3 },
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
      })),
    );
  return [...matrix, ...adversarial];
}

export function runtimeSurvivalReport(scenarios = buildRuntimeSurvivalScenarios()) {
  const rows = scenarios.map((scenario) => {
    const strategies = {
      current: createFoldPointStrategy(scenario, {
        omitRequestCacheEvidence: true,
        defaults: { compactOutputRatio: 0.002 },
      }),
      fixed60: createRawFixedThresholdStrategy(0.6),
      ...Object.fromEntries(
        SURVIVAL_PROFILES.map(({ id, ...runtimeSurvival }) => [
          id,
          createFoldPointStrategy(scenario, {
            omitRequestCacheEvidence: true,
            defaults: { compactOutputRatio: 0.002 },
            runtimeSurvival,
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
      ["current", "fixed60"].map((baseline) => {
        const selected = rows.filter(
          (r) => r.id.startsWith("near-end-") === (suite === "near-end"),
        );
        const compared = selected.filter((r) =>
          Object.values(r.arms).some((a) => a.compactionSteps.length > 0),
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
        };
      }),
    ),
  );
  return {
    kind: "foldpoint.runtime-survival-experiment.v1",
    paidCalls: 0,
    profiles: SURVIVAL_PROFILES,
    horizonCap: 64,
    limitations: [
      "Explicit uncalibrated priors, not estimated task progress or future user commands.",
      "No held-out endpoint, true retention or future cache condition is supplied to the policy.",
      "All original 1M simulation limitations apply; summary success and unchanged task output are assumed.",
      "Geometric survival, constant observed growth and future cache reuse can be wrong.",
      "WAIT delays economic compaction until safety; it is not an optimal policy that replans an earlier compaction next call.",
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
