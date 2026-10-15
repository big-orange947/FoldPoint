import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ApproximateRetentionTracker } from "./approximate-feedback";

export function runApproximateFeedbackProbe() {
  const r = JSON.parse(
    readFileSync(
      new URL("../benchmarks/reports/pi-feedback-capture-result.json", import.meta.url),
      "utf8",
    ),
  );
  // Existing live metadata only. Do NOT infer a precision budget from 1474 vs 1518.
  const b = r.boundaries;
  const sensitivity = [0, 0.1, 0.25].map((fraction) => {
    const tracker = new ApproximateRetentionTracker(
      "pi-host-estimates/deepseek-flash/native-summary-v1",
    );
    const admission = tracker.observe({
      basisKey: tracker.snapshot().basisKey,
      sequence: 1,
      success: true,
      source: "host-immediate",
      beforeTokens: b.compactionBefore,
      afterTokens: b.immediateAfterEstimate,
      beforeErrorTokens: Math.ceil(fraction * b.compactionBefore),
      afterErrorTokens: Math.ceil(fraction * b.immediateAfterEstimate),
    });
    return {
      assumedErrorFraction: fraction,
      admission,
      state: tracker.snapshot(),
      sameSizePrediction: tracker.predict(b.compactionBefore),
    };
  });
  const tracker = new ApproximateRetentionTracker("controlled-host-estimator/v1");
  const cold = tracker.predict(100_000);
  for (let i = 1; i <= 8; i++)
    tracker.observe({
      basisKey: "controlled-host-estimator/v1",
      sequence: i,
      success: true,
      source: "host-immediate",
      beforeTokens: 100_000,
      afterTokens: 25_000,
      beforeErrorTokens: 10_000,
      afterErrorTokens: 2_500,
    });
  const trained = tracker.predict(100_000);
  const checks = {
    coldAbstains: cold === null,
    admitsApproximateWithoutUpgradingTruth: sensitivity.every(
      (s) =>
        s.state.acceptedApproximate === 1 && s.state.exactSamples === 0 && !s.state.canDrivePolicy,
    ),
    zeroBudgetStillNotTruth:
      sensitivity[0]?.sameSizePrediction?.calibratedConfidenceInterval === false,
    errorAssumptionsDoNotShiftNominal: sensitivity.every(
      (s) => s.sameSizePrediction?.pointTokens === b.immediateAfterEstimate,
    ),
    largerAssumptionsWidenEnvelope: sensitivity.every(
      (s, i) =>
        i === 0 ||
        (s.sameSizePrediction !== null &&
          s.sameSizePrediction.lowerTokens <
            (sensitivity[i - 1]?.sameSizePrediction?.lowerTokens ?? 0) &&
          s.sameSizePrediction.upperTokens >
            (sensitivity[i - 1]?.sameSizePrediction?.upperTokens ?? Infinity)),
    ),
    knownSyntheticValueInsideEnvelope:
      trained !== null && trained.lowerTokens <= 25_000 && trained.upperTokens >= 25_000,
    syntheticFeedbackImprovesOverColdPrior:
      trained !== null && Math.abs(trained.pointTokens - 25_000) < Math.abs(10_000 - 25_000),
    noPolicyAction: sensitivity.every((s) => s.sameSizePrediction?.canDrivePolicy === false),
  };
  return {
    runner: "foldpoint.approximate-feedback.v1",
    paidCalls: 0,
    sourceLiveReport: r.provenance.originalReportSha256,
    passed: Object.values(checks).every(Boolean),
    checks,
    sensitivity,
    synthetic: { cold, trained },
    limitations: [
      "0%/10%/25% 是误差假设敏感性，不是由这一次 Pi 实测估出来的误差率。",
      "Pi before 是利用上次 provider 用量校准的宿主上下文估计，after 是消息估计；误差预算必须覆盖估计方法差异，当前未校准。",
      "只有一次真实压缩，不能证明下一次预测准确；同尺寸回代不是留出验证。",
      "历史包络不是统计置信区间；未观测输入范围外的预测会标为 extrapolated。",
      "这是比例 EMA，不是 affine 模型；固定保留底座、跨尺寸变化和任务阶段变化仍可能造成误差。",
      "增长修正仅在同一宿主估计单位且由宿主提供范围时可用；provider 完整 prompt 不自动混进来。",
      "近似模型独立于精确 affine 模型和精确校准；默认核心/Pi 策略、旧实测和费用均未更改。",
    ],
  };
}

export function renderApproximateFeedback(r: ReturnType<typeof runApproximateFeedbackProbe>) {
  return [
    "# 近似压缩反馈：来源与误差假设",
    "",
    `离线检查：${Object.values(r.checks).filter(Boolean).length}/${Object.keys(r.checks).length} 通过；新增付费调用 0。`,
    "已有真实 Pi 元数据仅作回放，每个误差假设分支都只接收同一份观测一次。精确样本仍为 0。",
    "",
    "| before/after 误差假设 | 同尺寸回代点估计 | 假设下历史包络 |",
    "| --- | ---: | ---: |",
    ...r.sensitivity.map(
      (s) =>
        `| ${s.assumedErrorFraction * 100}% | ${s.sameSizePrediction?.pointTokens.toFixed(1)} | ${s.sameSizePrediction?.lowerTokens.toFixed(1)}–${s.sameSizePrediction?.upperTokens.toFixed(1)} |`,
    ),
    "",
    "没有为了拟合而将 1474、1518 或 1532 当成相同含义的真值。误差假设不改变这份观测的名义点估计，只改变范围及后续学习影响；同尺寸回代不代表实测预测改进。",
    "",
    "## 检查",
    "",
    ...Object.entries(r.checks).map(([key, pass]) => `- ${key}: ${pass ? "PASS" : "FAIL"}`),
    "",
    "## 限制",
    "",
    ...r.limitations.map((s) => `- ${s}`),
    "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("usage: tsx tools/approximate-feedback-probe.ts");
  const r = runApproximateFeedbackProbe();
  writeFileSync(
    new URL("../benchmarks/approximate-feedback.md", import.meta.url),
    renderApproximateFeedback(r),
  );
  console.log(JSON.stringify(r, null, 2));
  if (!r.passed) process.exitCode = 1;
}
