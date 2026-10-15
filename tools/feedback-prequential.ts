/** Frozen synthetic prediction screen. No policy actions, provider requests or task-quality claims. */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ApproximateFeedback, ApproximateRetentionTracker } from "./approximate-feedback";

export interface FeedbackScenario {
  id: string;
  ratio: number;
  floor: number;
  noise: number;
  error: number;
  bias?: number;
  delayed?: "known" | "unknown";
  change?: { at: number; ratio: number };
  failEvery?: number;
}

/** Declared before execution; no tuning or scenario-dependent predictor parameters. */
export const FEEDBACK_SCENARIOS: readonly FeedbackScenario[] = [
  { id: "stable-high", ratio: 0.25, floor: 0, noise: 0.03, error: 0.1 },
  { id: "stable-low", ratio: 0.04, floor: 0, noise: 0.03, error: 0.1 },
  { id: "near-prior", ratio: 0.1, floor: 0, noise: 0.06, error: 0.1 },
  { id: "fixed-floor", ratio: 0.03, floor: 40_000, noise: 0.03, error: 0.1 },
  {
    id: "phase-change",
    ratio: 0.28,
    floor: 0,
    noise: 0.03,
    error: 0.1,
    change: { at: 20, ratio: 0.06 },
  },
  { id: "underdeclared-bias", ratio: 0.1, floor: 0, noise: 0, error: 0.1, bias: 0.25 },
  {
    id: "delayed-known-growth",
    ratio: 0.18,
    floor: 10_000,
    noise: 0.02,
    error: 0.1,
    delayed: "known",
  },
  {
    id: "delayed-unknown-growth",
    ratio: 0.22,
    floor: 10_000,
    noise: 0.02,
    error: 0.1,
    delayed: "unknown",
  },
  { id: "failed-attempts", ratio: 0.2, floor: 0, noise: 0.03, error: 0.1, failEvery: 7 },
];
const BEFORE = [100_000, 150_000, 350_000, 700_000];
const ARMS = ["fixed10", "lastObserved", "pointEma", "approximate"] as const;
const LEARNER_SHA256 = "f109ccf8b127afb4447972198c506d7f5d31f7e4025abd1d3184c2ed87c45a18";
export function assertFeedbackSource(source: string) {
  if (createHash("sha256").update(source.replace(/\r\n/g, "\n")).digest("hex") !== LEARNER_SHA256)
    throw new Error(
      "Frozen learner changed: create a new comparison rather than rewriting this baseline",
    );
}
type Arm = (typeof ARMS)[number];
const rng = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
};

export function runFeedbackScenario(s: FeedbackScenario, seed: number, steps = 40) {
  if (!Number.isSafeInteger(steps) || steps < 1 || steps > 1000)
    throw new RangeError("invalid screen length");
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new RangeError("invalid seed");
  if (s.failEvery !== undefined && (!Number.isSafeInteger(s.failEvery) || s.failEvery < 2))
    throw new RangeError("invalid failure interval");
  for (const n of [s.ratio, s.floor, s.noise, s.error, s.bias ?? 0])
    if (!Number.isFinite(n)) throw new RangeError("invalid scenario");
  if (
    s.ratio < 0 ||
    !Number.isSafeInteger(s.floor) ||
    s.floor < 0 ||
    s.noise < 0 ||
    s.noise >= 1 ||
    s.error < 0 ||
    s.error >= 1 ||
    1 + (s.bias ?? 0) - s.noise <= 0
  )
    throw new RangeError("invalid scenario");
  const basisKey = "controlled-host-estimator/v1";
  const learner = new ApproximateRetentionTracker(basisKey);
  const random = rng(seed);
  let last: number | undefined;
  let ema: number | undefined;
  const rows = [];
  for (let step = 0; step < steps; step++) {
    // The pre-request host input is visible to every arm. No task endpoint is passed in.
    const before = BEFORE[step % BEFORE.length] ?? 100_000;
    const prediction = learner.predict(before, Math.ceil(s.error * before));
    const predictions = {
      fixed10: 0.1 * before,
      lastObserved: (last ?? 0.1) * before,
      pointEma: (ema ?? 0.1) * before,
      approximate: prediction?.pointTokens ?? 0.1 * before,
    };
    // Reveal evaluator-owned outcome only AFTER predictions have been copied.
    const ratio = s.change && step >= s.change.at ? s.change.ratio : s.ratio;
    const success = !s.failEvery || (step + 1) % s.failEvery !== 0;
    const truth = Math.round(before * ratio + s.floor);
    if (truth <= 0) throw new RangeError("fixture target must be positive");
    const added = s.delayed ? 20_000 : 0;
    const observedAfter = success
      ? Math.round((truth + added) * (1 + (s.bias ?? 0) + s.noise * (2 * random() - 1)))
      : before;
    // Consume one RNG draw on failures too, keeping future random streams aligned.
    if (!success) random();
    const feedback: ApproximateFeedback = {
      basisKey,
      sequence: step + 1,
      success,
      source: s.delayed ? "host-delayed" : "host-immediate",
      beforeTokens: before,
      afterTokens: observedAfter,
      beforeErrorTokens: Math.ceil(s.error * before),
      afterErrorTokens: Math.ceil(s.error * observedAfter),
      ...(s.delayed === "known" ? { growth: { lowerTokens: 15_000, upperTokens: 25_000 } } : {}),
    };
    const admission = learner.observe(feedback);
    // Simple controls receive exactly the same accepted observable information, never truth.
    if (admission === "accepted-approximate") {
      const growth = feedback.growth;
      const midpoint = growth ? (growth.lowerTokens + growth.upperTokens) / 2 : 0;
      last = Math.max(0, observedAfter - midpoint) / before;
      ema = ema === undefined ? last : ema + 0.25 * (last - ema);
    }
    rows.push({
      step,
      before,
      predictions,
      prediction,
      success,
      truth: success ? truth : null,
      observedAfter,
      admission,
      assumedErrorContainsOutcome: success
        ? observedAfter - feedback.afterErrorTokens <= truth + added &&
          truth + added <= observedAfter + feedback.afterErrorTokens
        : null,
    });
  }
  const scored = rows.filter((row) => row.truth !== null);
  const warm = scored.slice(3); // Fixed rule shared by all arms, not "only when learner wins".
  const metrics = Object.fromEntries(
    ARMS.map((arm) => [
      arm,
      {
        samples: scored.length,
        mae:
          scored.reduce((sum, r) => sum + Math.abs(r.predictions[arm] - (r.truth ?? 0)), 0) /
          scored.length,
        relativeMae:
          scored.reduce(
            (sum, r) => sum + Math.abs(r.predictions[arm] - (r.truth ?? 0)) / (r.truth ?? 1),
            0,
          ) / scored.length,
        warmMae: warm.length
          ? warm.reduce((sum, r) => sum + Math.abs(r.predictions[arm] - (r.truth ?? 0)), 0) /
            warm.length
          : null,
      },
    ]),
  ) as Record<Arm, { samples: number; mae: number; relativeMae: number; warmMae: number | null }>;
  const withEnvelope = scored.filter((r) => r.prediction !== null);
  const covered = withEnvelope.filter(
    (r) =>
      r.prediction &&
      (r.truth ?? 0) >= r.prediction.lowerTokens &&
      (r.truth ?? 0) <= r.prediction.upperTokens,
  ).length;
  return {
    id: s.id,
    seed,
    steps,
    rows,
    metrics,
    failed: rows.filter((r) => !r.success).length,
    accepted: learner.snapshot().acceptedApproximate,
    fallbackScored: scored.filter((r) => r.prediction === null).length,
    rejectedGrowth: rows.filter((r) => r.admission === "unknown-growth").length,
    errorAssumptionViolations: scored.filter((r) => !r.assumedErrorContainsOutcome).length,
    envelope: {
      samples: withEnvelope.length,
      covered,
      coverage: withEnvelope.length ? covered / withEnvelope.length : null,
      meanRelativeWidth: withEnvelope.length
        ? withEnvelope.reduce(
            (sum, r) =>
              sum +
              ((r.prediction?.upperTokens ?? 0) - (r.prediction?.lowerTokens ?? 0)) /
                (r.truth ?? 1),
            0,
          ) / withEnvelope.length
        : null,
    },
  };
}

export function runFeedbackPrequential() {
  assertFeedbackSource(readFileSync(new URL("./approximate-feedback.ts", import.meta.url), "utf8"));
  const seeds = [151, 919, 2027];
  const runs = FEEDBACK_SCENARIOS.flatMap((s) => seeds.map((seed) => runFeedbackScenario(s, seed)));
  const groups = FEEDBACK_SCENARIOS.map((s) => {
    const selected = runs.filter((r) => r.id === s.id);
    const mean = (pick: (r: (typeof runs)[number]) => number) =>
      selected.reduce((sum, r) => sum + pick(r), 0) / selected.length;
    return {
      id: s.id,
      mae: Object.fromEntries(ARMS.map((a) => [a, mean((r) => r.metrics[a].mae)])) as Record<
        Arm,
        number
      >,
      relativeMae: Object.fromEntries(
        ARMS.map((a) => [a, mean((r) => r.metrics[a].relativeMae)]),
      ) as Record<Arm, number>,
      warmMae: Object.fromEntries(
        ARMS.map((a) => [
          a,
          selected.some((r) => r.metrics[a].warmMae === null)
            ? null
            : mean((r) => r.metrics[a].warmMae ?? 0),
        ]),
      ) as Record<Arm, number>,
      intervalSamples: selected.reduce((sum, r) => sum + r.envelope.samples, 0),
      covered: selected.reduce((sum, r) => sum + r.envelope.covered, 0),
      meanRelativeWidth:
        selected[0]?.envelope.meanRelativeWidth === null
          ? null
          : mean((r) => r.envelope.meanRelativeWidth ?? 0),
      assumptionViolations: selected.reduce((sum, r) => sum + r.errorAssumptionViolations, 0),
    };
  });
  return {
    runner: "foldpoint.feedback-prequential.v1",
    learnerSourceSha256: LEARNER_SHA256,
    paidCalls: 0,
    runs,
    groups,
    summary: {
      streams: runs.length,
      attempts: runs.reduce((sum, r) => sum + r.steps, 0),
      scoredSuccesses: runs.reduce((sum, r) => sum + r.metrics.fixed10.samples, 0),
      failedAttempts: runs.reduce((sum, r) => sum + r.failed, 0),
      winsVsFixed: runs.filter((r) => r.metrics.approximate.mae < r.metrics.fixed10.mae - 1e-9)
        .length,
      lossesVsFixed: runs.filter((r) => r.metrics.approximate.mae > r.metrics.fixed10.mae + 1e-9)
        .length,
      winsVsPointEma: runs.filter((r) => r.metrics.approximate.mae < r.metrics.pointEma.mae - 1e-9)
        .length,
      lossesVsPointEma: runs.filter(
        (r) => r.metrics.approximate.mae > r.metrics.pointEma.mae + 1e-9,
      ).length,
      macroMae: Object.fromEntries(
        ARMS.map((arm) => [
          arm,
          runs.reduce((sum, r) => sum + r.metrics[arm].mae, 0) / runs.length,
        ]),
      ) as Record<Arm, number>,
    },
    limitations: [
      "预先声明的合成预测压力测试，不是真实任务、1M 执行或省钱 benchmark；未修改模型或默认策略。",
      "所有成功压缩都评分，包括冷启动与拒绝反馈的时刻。没有近似模型时显式回退到同一固定 10%。",
      "失败尝试单独列出，不拿未发生的成功压缩结果评分，也不训练成功模型。本工具不计算费用。",
      "warmMae 统一排除每条流最初三次成功尝试，不按是否已有模型选择样本；主指标仍包含全部成功尝试。",
      "范围覆盖率只覆盖已有历史包络的预测，分母与平均相对宽度同时列出；不是统计置信区间。",
      "普通 EMA 和上次比例对照使用同样的已接收观测，均不是生产核心的完整决策策略。",
      "结果用于揭示权重、底座、漂移和错误预算的局限；不能由优于固定 10% 推导优于简单 EMA 或真实收益。",
    ],
  };
}

export function renderFeedbackPrequential(r: ReturnType<typeof runFeedbackPrequential>) {
  const f = (n: number) => n.toFixed(0);
  return [
    "# 连续压缩：先预测、后反馈的离线比较",
    "",
    `预先声明 9 类场景 × 3 个 seed × 40 次尝试，共 ${r.summary.attempts} 次；成功评分 ${r.summary.scoredSuccesses} 次，失败 ${r.summary.failedAttempts} 次。新增付费调用 0。`,
    "所有模型参数保持 a6bca36 的实现：alpha=0.25，不按场景调参；固定 10%、上次比例、无误差权重 EMA 和近似 EMA 均在揭示当前结果前预测。",
    "",
    "| 场景 | 固定10% MAE | 上次比例 MAE | 普通EMA MAE | 近似EMA MAE | 范围覆盖/分母 | 平均范围宽度/真值 | 误差假设失效 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...r.groups.map(
      (g) =>
        `| ${g.id} | ${f(g.mae.fixed10)} | ${f(g.mae.lastObserved)} | ${f(g.mae.pointEma)} | ${f(g.mae.approximate)} | ${g.covered}/${g.intervalSamples} | ${g.meanRelativeWidth === null ? "—" : `${(100 * g.meanRelativeWidth).toFixed(1)}%`} | ${g.assumptionViolations} |`,
    ),
    "",
    `按每条流的全程 MAE，近似 EMA 相比固定 10%：${r.summary.winsVsFixed} 胜 / ${r.summary.lossesVsFixed} 负 / ${r.summary.streams - r.summary.winsVsFixed - r.summary.lossesVsFixed} 平；相比普通 EMA：${r.summary.winsVsPointEma} 胜 / ${r.summary.lossesVsPointEma} 负 / ${r.summary.streams - r.summary.winsVsPointEma - r.summary.lossesVsPointEma} 平。`,
    `27 条流等权的宏平均 MAE：固定 10% ${f(r.summary.macroMae.fixed10)}，上次比例 ${f(r.summary.macroMae.lastObserved)}，普通 EMA ${f(r.summary.macroMae.pointEma)}，近似 EMA ${f(r.summary.macroMae.approximate)}。这些等权不代表真实使用分布。`,
    "",
    "胜负只是这些确定性流的描述，不是显著性检验。命令默认只输出汇总；加 --details 输出完整逐步 JSON，便于复查每一次预测和反馈。",
    "",
    "## 本轮结论",
    "",
    "- 稳定比例下学习明显优于错误的固定先验，但真值接近 10% 时，学习观测噪声反而可能变差。",
    "- 固定保留底座暴露了比例模型的结构性误差；阶段突变暴露了不确定性降权导致的迟钝。不能只靠继续调整 alpha 解释为已经解决。",
    "- 错报误差预算时，名义点估计持续偏高；宽范围依然可能覆盖真值，因此覆盖率不能替代点误差和预算有效性检查。",
    "- 当前近似 EMA 不宜替换默认预测器，也没有证明优于简单 EMA；下一轮应保留本基线，研究兼容近似数据的底座/比例分离，而非先加大付费测试。",
    "",
    "## 限制",
    "",
    ...r.limitations.map((s) => `- ${s}`),
    "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3 || (process.argv.length === 3 && process.argv[2] !== "--details"))
    throw new Error("usage: tsx tools/feedback-prequential.ts [--details]");
  const r = runFeedbackPrequential();
  writeFileSync(
    new URL("../benchmarks/feedback-prequential.md", import.meta.url),
    renderFeedbackPrequential(r),
  );
  console.log(
    JSON.stringify(
      process.argv.includes("--details")
        ? r
        : {
            runner: r.runner,
            paidCalls: r.paidCalls,
            summary: r.summary,
            groups: r.groups,
            limitations: r.limitations,
          },
      null,
      2,
    ),
  );
}
