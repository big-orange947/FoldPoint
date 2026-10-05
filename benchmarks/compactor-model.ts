/** Frozen 60% comparator. No paid calls or compactor ground truth reaches the policy. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DURATION_PRIOR } from "./duration-mixture";
import { createRawFixedThresholdStrategy } from "./fixed-threshold";
import { PRICE_PROFILES } from "./provider-ratios";
import { createFoldPointStrategy, runSession } from "./simulator";
import { timingCases } from "./timing-margin";

export function compactorCases() {
  const seen = timingCases().filter(
    (s) => s.id.startsWith("heldout-floor-") || s.id.startsWith("heldout-margin-"),
  );
  const base = seen[0];
  if (!base) throw new Error("Missing fixture");
  // Fixed before the first run. Different sizes, outputs and endpoints; no price-specific tuning.
  const fresh = [95, 245].flatMap((steps) =>
    [27000, 39000].flatMap((growthPerStep) =>
      [15000, 65000].map((retainedFloorTokens) => ({
        ...base,
        id: `fresh-model-${steps}-${growthPerStep}-${retainedFloorTokens}`,
        steps,
        growthPerStep,
        seed: 557,
        growthJitter: 5500,
        compactor: {
          retentionRatio: 0.13,
          outputRatio: 0.003,
          successRate: 1,
          retainedFloorTokens,
          outputFloorTokens: 3500,
        },
      })),
    ),
  );
  return [...seen, ...fresh];
}

export function compactorModelReport() {
  const rows = PRICE_PROFILES.flatMap((profile) =>
    compactorCases().map((base) => {
      const scenario = { ...base, pricing: profile.pricing };
      const common = {
        omitRequestCacheEvidence: true,
        verifiedAppendOnlyPrefix: true,
        defaults: { compactOutputRatio: 0.002 },
        runtimeSurvival: {
          continuationProbability: 0.95,
          maxImmediateLossRatio: 1,
          maxCalls: 256,
          rolloutMode: "renewal" as const,
          endingRiskMode: "survival-weighted" as const,
          endingLossBudgetRatio: 1,
          savingMarginBasis: "timing" as const,
          durationModel: { completedCalls: 0, components: DURATION_PRIOR },
        },
      };
      const strategies = {
        fixed60: createRawFixedThresholdStrategy(0.6),
        ratio: createFoldPointStrategy(scenario, common),
        learned: createFoldPointStrategy(scenario, { ...common, learnedCompactorTokens: true }),
      };
      const arms = Object.fromEntries(
        Object.entries(strategies).map(([name, strategy]) => {
          const run = runSession(scenario, strategy);
          return [
            name,
            {
              cost: run.metrics.totalSimulatedCost,
              attempts: run.metrics.compactionAttemptCount,
              overflow: run.metrics.overflowCount,
              fingerprint: run.metrics.growthSequenceFingerprint,
              summaryCost: run.compactions.reduce((s, c) => s + c.attemptCost, 0),
              compactionSteps: run.compactions.map((c) => c.step),
            },
          ];
        }),
      );
      return {
        id: base.id,
        profile: profile.id,
        suite: base.id.startsWith("fresh-model-")
          ? "fresh-fixed-term"
          : base.id.startsWith("heldout-floor-")
            ? "seen-floor"
            : "seen-proportional",
        arms,
      };
    }),
  );
  const summary = PRICE_PROFILES.flatMap((profile) =>
    ["seen-floor", "seen-proportional", "fresh-fixed-term"].flatMap((suite) =>
      ["ratio", "learned"].map((candidate) => {
        const selected = rows.filter((r) => r.profile === profile.id && r.suite === suite);
        const deltas = selected.map(
          (r) => (r.arms[candidate]?.cost ?? NaN) / (r.arms.fixed60?.cost ?? NaN) - 1,
        );
        return {
          profile: profile.id,
          suite,
          candidate,
          baseline: "fixed60",
          wins: deltas.filter((d) => d < -1e-9).length,
          losses: deltas.filter((d) => d > 1e-9).length,
          ties: deltas.filter((d) => Math.abs(d) <= 1e-9).length,
          mean: deltas.reduce((a, b) => a + b, 0) / deltas.length,
          worst: Math.max(...deltas),
          attempts: selected.reduce((s, r) => s + (r.arms[candidate]?.attempts ?? 0), 0),
        };
      }),
    ),
  );
  return {
    kind: "foldpoint.compactor-model.v1",
    comparator: "fixed60",
    paidCalls: 0,
    learner: {
      window: 32,
      minSamples: 3,
      minInputSpanRatio: 0.2,
      fit: "nonnegative affine least squares",
      stress: "maximum observed residual + existing retention stress",
    },
    rows,
    summary,
    limitations: [
      "只学习当前会话已经成功压缩的元数据，不输入真实 floor、未来结果或任务终点；不修改核心/Pi 默认策略。",
      "主对照固定 60%，不在不同阈值中挑最有利对照；旧报告保持原样。",
      "非负仿射只是近似，不能证明固定底座存在；不同输入跨度不足时回退比例估计，窗口最多 32 条。",
      "残差压力不是置信区间；区间外外推、输出成本与缓存制度变化可能失准。",
      "样本全部来自合成轨迹，没有证明真实 Pi 任务质量，价格只替换冻结报价比例。",
      "fresh-fixed-term 是本轮首次运行的新组合，查看后即为已见数据，不再称盲测。",
    ],
  };
}

export function renderCompactor(report: ReturnType<typeof compactorModelReport>) {
  return [
    "# 压缩固定项预测实验（主对照 60%）",
    "",
    "负数为省钱，所有摘要与缓存重建费用均计入。",
    "",
    "| 价格 | 分组 | 策略 | 胜/负/平 | 平均变化 | 最差变化 | 压缩次数 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.summary.map(
      (s) =>
        `| ${s.profile} | ${s.suite} | ${s.candidate} | ${s.wins}/${s.losses}/${s.ties} | ${(s.mean * 100).toFixed(2)}% | ${(s.worst * 100).toFixed(2)}% | ${s.attempts} |`,
    ),
    "",
    "## 限制",
    "",
    ...report.limitations.map((l) => `- ${l}`),
    "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = compactorModelReport();
  mkdirSync(new URL("./reports/", import.meta.url), { recursive: true });
  writeFileSync(
    new URL("./reports/compactor-model.json", import.meta.url),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync(new URL("./compactor-model.md", import.meta.url), renderCompactor(report));
  console.log(
    JSON.stringify(
      report.summary.filter((s) => s.candidate === "learned"),
      null,
      2,
    ),
  );
}
