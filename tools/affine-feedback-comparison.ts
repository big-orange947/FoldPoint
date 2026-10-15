import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FEEDBACK_SCENARIOS,
  type FeedbackScenario,
  runFeedbackPrequential,
  runFeedbackScenario,
} from "./feedback-prequential";
import { UncertainAffineFeedback } from "./uncertain-affine-feedback";

const BASELINE_SHA = "06765b1fb946ccd3f7450af35207ca8d176c820974bfb4a3acb16f3b237c4a3d";
export function assertAffineBaseline(source: string) {
  if (createHash("sha256").update(source.replace(/\r\n/g, "\n")).digest("hex") !== BASELINE_SHA)
    throw new Error("Frozen prediction baseline changed");
}

export function runAffineScenario(s: FeedbackScenario, seed: number, steps = 40) {
  const baseline = runFeedbackScenario(s, seed, steps);
  const learner = new UncertainAffineFeedback("controlled-host-estimator/v1");
  // Pre-generated public evaluation rows are revealed one at a time. Model receives metadata only.
  const rows = baseline.rows.map((row) => {
    const prediction = learner.predict(row.before, Math.ceil(s.error * row.before));
    const issued = prediction?.pointTokens ?? 0.1 * row.before;
    const admission = learner.observe({
      basisKey: "controlled-host-estimator/v1",
      sequence: row.step + 1,
      success: row.success,
      source: s.delayed ? "host-delayed" : "host-immediate",
      beforeTokens: row.before,
      afterTokens: row.observedAfter,
      beforeErrorTokens: Math.ceil(s.error * row.before),
      afterErrorTokens: Math.ceil(s.error * row.observedAfter),
      ...(s.delayed === "known" ? { growth: { lowerTokens: 15_000, upperTokens: 25_000 } } : {}),
    });
    return { step: row.step, prediction, issued, admission, truth: row.truth };
  });
  const scored = rows.filter((r) => r.truth !== null);
  const envelopeRows = scored.filter((r) => r.prediction !== null);
  const covered = envelopeRows.filter(
    (r) =>
      r.prediction &&
      (r.truth ?? 0) >= r.prediction.lowerTokens &&
      (r.truth ?? 0) <= r.prediction.upperTokens,
  ).length;
  return {
    id: s.id,
    seed,
    rows,
    baseline: baseline.metrics,
    samples: scored.length,
    mae: scored.reduce((sum, r) => sum + Math.abs(r.issued - (r.truth ?? 0)), 0) / scored.length,
    relativeMae:
      scored.reduce((sum, r) => sum + Math.abs(r.issued - (r.truth ?? 0)) / (r.truth ?? 1), 0) /
      scored.length,
    intervalSamples: envelopeRows.length,
    covered,
    meanRelativeWidth: envelopeRows.length
      ? envelopeRows.reduce(
          (sum, r) =>
            sum +
            ((r.prediction?.upperTokens ?? 0) - (r.prediction?.lowerTokens ?? 0)) / (r.truth ?? 1),
          0,
        ) / envelopeRows.length
      : null,
    fittedPredictions: scored.filter((r) => r.prediction?.source === "weighted-affine").length,
    lastFallbacks: scored.filter((r) => r.prediction?.source === "last-observation-fallback")
      .length,
    coldFallbacks: scored.filter((r) => r.prediction === null).length,
    state: learner.snapshot(),
  };
}

export function runAffineComparison() {
  assertAffineBaseline(readFileSync(new URL("./feedback-prequential.ts", import.meta.url), "utf8"));
  const frozen = runFeedbackPrequential(); // Also guards original approximate learner source.
  const runs = FEEDBACK_SCENARIOS.flatMap((s) =>
    [151, 919, 2027].map((seed) => runAffineScenario(s, seed)),
  );
  const groups = frozen.groups.map((g) => {
    const selected = runs.filter((r) => r.id === g.id);
    return {
      ...g,
      affineMae: selected.reduce((sum, r) => sum + r.mae, 0) / selected.length,
      affineCovered: selected.reduce((sum, r) => sum + r.covered, 0),
      affineIntervals: selected.reduce((sum, r) => sum + r.intervalSamples, 0),
      affineRelativeWidth:
        selected[0]?.meanRelativeWidth === null
          ? null
          : selected.reduce((sum, r) => sum + (r.meanRelativeWidth ?? 0), 0) / selected.length,
    };
  });
  return {
    runner: "foldpoint.uncertain-affine-comparison.v1",
    paidCalls: 0,
    baselineSourceSha256: BASELINE_SHA,
    parameters: { alpha: 0.25, history: 32, minimumSamples: 3, minimumRelativeSpan: 0.2 },
    summary: {
      streams: runs.length,
      samples: runs.reduce((sum, r) => sum + r.samples, 0),
      affineMacroMae: runs.reduce((sum, r) => sum + r.mae, 0) / runs.length,
      baselineMacroMae: frozen.summary.macroMae,
      winsVsFixed: runs.filter((r) => r.mae < r.baseline.fixed10.mae - 1e-9).length,
      lossesVsFixed: runs.filter((r) => r.mae > r.baseline.fixed10.mae + 1e-9).length,
      winsVsEma: runs.filter((r) => r.mae < r.baseline.pointEma.mae - 1e-9).length,
      lossesVsEma: runs.filter((r) => r.mae > r.baseline.pointEma.mae + 1e-9).length,
    },
    groups,
    runs,
    limitations: [
      "旧基线、场景、seed、评分分母、误差预算均未修改；不按场景选择预测器或调参。",
      "拟合的是近似宿主单位，exactSamples 仍为 0；点预测、权重和范围不是精确测量或统计置信度。",
      "带遗忘的非负加权最小二乘使用名义 before；不是完整 errors-in-variables 估计，错误预算可能继续误导它。",
      "数据不足或跨度不足回退到上次观测比例，完全冷启动仍用固定 10%；两类回退均计分。",
      "近期窗口若失去输入跨度，会撤下旧拟合并回退；尚未证明真实压缩周期的窄跨度反馈足够识别底座。",
      "范围包含近期最大残差及假设误差，阶段变化可能让范围很宽；覆盖率不代表点预测有用。",
      "只验证压缩后体积预测，未接管 Pi、未更改默认核心、未测真实任务质量或完整节费。",
    ],
  };
}

export function renderAffineComparison(r: ReturnType<typeof runAffineComparison>) {
  return [
    "# 底座＋比例：近似反馈候选对照",
    "",
    `27 条旧合成流，${r.summary.samples} 次成功结果同分母评分；新增付费调用 0。全部模型先预测再接收当步观测。`,
    "新候选：非负底座＋非负比例；32 条窗口、alpha=0.25 的指数遗忘，使用宿主误差假设作相对加权。至少三个样本且 before 跨度达到 20% 才拟合，否则明确回退。没有按场景分支或搜索参数。",
    "",
    "| 场景 | 固定10% MAE | 上次比例 | 普通EMA | 旧近似EMA | 新底座＋比例 | 新范围覆盖/分母 | 新范围宽度/真值 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...r.groups.map(
      (g) =>
        `| ${g.id} | ${g.mae.fixed10.toFixed(0)} | ${g.mae.lastObserved.toFixed(0)} | ${g.mae.pointEma.toFixed(0)} | ${g.mae.approximate.toFixed(0)} | ${g.affineMae.toFixed(0)} | ${g.affineCovered}/${g.affineIntervals} | ${g.affineRelativeWidth === null ? "—" : `${(100 * g.affineRelativeWidth).toFixed(1)}%`} |`,
    ),
    "",
    `流等权宏平均 MAE：新候选 ${r.summary.affineMacroMae.toFixed(0)}；旧近似 EMA ${r.summary.baselineMacroMae.approximate.toFixed(0)}；普通 EMA ${r.summary.baselineMacroMae.pointEma.toFixed(0)}；上次比例 ${r.summary.baselineMacroMae.lastObserved.toFixed(0)}；固定 10% ${r.summary.baselineMacroMae.fixed10.toFixed(0)}。`,
    `新候选 vs 固定 10%：${r.summary.winsVsFixed} 胜 / ${r.summary.lossesVsFixed} 负 / ${27 - r.summary.winsVsFixed - r.summary.lossesVsFixed} 平；vs 普通 EMA：${r.summary.winsVsEma} 胜 / ${r.summary.lossesVsEma} 负 / ${27 - r.summary.winsVsEma - r.summary.lossesVsEma} 平。`,
    "",
    "这些是同一组合成流上的开发检查，不是独立留出集、显著性证明或真实节费结论。旧基线报告保持原样。",
    "",
    "## 限制",
    "",
    ...r.limitations.map((s) => `- ${s}`),
    "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3 || (process.argv.length === 3 && process.argv[2] !== "--details"))
    throw new Error("usage: tsx tools/affine-feedback-comparison.ts [--details]");
  const r = runAffineComparison();
  writeFileSync(
    new URL("../benchmarks/affine-feedback-comparison.md", import.meta.url),
    renderAffineComparison(r),
  );
  console.log(JSON.stringify(process.argv.includes("--details") ? r : r.summary, null, 2));
}
