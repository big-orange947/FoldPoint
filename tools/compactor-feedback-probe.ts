/** Offline wiring check. Synthetic truth is evaluator-owned, never a live-quality claim. */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  costOfUsage,
  ExperimentalCompactorLearner,
  FoldPoint,
  type FoldPointProfile,
  predictCompactorTokens,
  resolveUnitPrices,
  type TraceCompactionEvent,
  type TraceEvent,
  TraceRecorder,
  validateTraceEvent,
} from "../src/index";
import { analyzeTraceEvents } from "./trace-analyze";

const PROFILE: FoldPointProfile = {
  provider: "synthetic",
  model: "feedback-fixture",
  compactorId: "controlled-affine-v1",
  contextWindowTokens: 1_000_000,
  pricing: {
    currency: "USD",
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
    source: "hypothetical-test-fixture",
  },
};

/** Research replay gate, NOT a replacement for Pi's existing feedback or a public API. */
export function admitMeasuredFeedback(
  learner: ExperimentalCompactorLearner,
  event: TraceCompactionEvent,
  prices = resolveUnitPrices(PROFILE.pricing),
) {
  validateTraceEvent(event);
  if (!event.success) return "failed" as const;
  if (event.afterTokens === null) return "unknown-size" as const;
  if (event.afterTokensSource !== "host-measured") return "unmeasured-size" as const;
  const usage = event.usage;
  if (
    usage?.promptTokens === undefined ||
    usage.outputTokens === undefined ||
    usage.cachedInputTokens === undefined ||
    usage.cacheWriteTokens === undefined
  )
    return "incomplete-usage" as const;
  for (const count of Object.values(usage)) {
    // actualCost is a monetary value, not an integer token count.
    if (!Number.isFinite(count) || count < 0) throw new RangeError("invalid feedback usage");
  }
  for (const count of [
    usage.promptTokens,
    usage.outputTokens,
    usage.cachedInputTokens,
    usage.cacheWriteTokens,
  ]) {
    if (!Number.isSafeInteger(count)) throw new RangeError("invalid feedback token count");
  }
  if (usage.cachedInputTokens + usage.cacheWriteTokens > usage.promptTokens) {
    throw new RangeError("feedback cache partitions exceed prompt");
  }
  learner.observe({
    beforeTokens: event.beforeTokens,
    afterTokens: event.afterTokens,
    outputTokens: usage.outputTokens,
    summaryInputCostPerToken:
      costOfUsage(prices, {
        promptTokens: usage.promptTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        outputTokens: 0,
      }) / event.beforeTokens,
  });
  return "accepted" as const;
}

/** Known compatible host/provider units; no new input is added inside a compaction. */
function truth(before: number, changed = false) {
  return changed
    ? { afterTokens: 50_000 + 0.08 * before, outputTokens: 3_000 + 0.01 * before }
    : { afterTokens: 20_000 + 0.04 * before, outputTokens: 1_500 + 0.005 * before };
}

export function runFeedbackProbe() {
  const learner = new ExperimentalCompactorLearner();
  const core = new FoldPoint();
  const trace = new TraceRecorder({ producer: "controlled-feedback", now: () => 0 });
  const prices = resolveUnitPrices(PROFILE.pricing);
  const sessionId = "controlled-feedback";
  const events: TraceEvent[] = [trace.header()];
  const checkpoints = [];
  let time = 0;
  const decision = (tokens: number) =>
    core.decide({
      sessionId,
      profile: PROFILE,
      timestamp: ++time,
      contextTokens: tokens,
      expectedFutureCalls: 3,
      safeBoundary: true,
    });
  const observedCompaction = (before: number, success = true, changed = false) => {
    const actual = truth(before, changed);
    return trace.compaction(
      sessionId,
      {
        timestamp: ++time,
        beforeTokens: before,
        afterTokens: success ? actual.afterTokens : before,
        success,
        promptTokens: before,
        cachedInputTokens: 0.8 * before,
        cacheWriteTokens: 0.2 * before,
        outputTokens: success ? actual.outputTokens : 400,
      },
      { afterTokensSource: "host-measured" },
    );
  };
  const observeCore = (event: TraceCompactionEvent) => {
    if (event.afterTokens === null) throw new Error("fixture size missing");
    core.recordCompaction(sessionId, PROFILE, {
      timestamp: event.timestamp,
      beforeTokens: event.beforeTokens,
      afterTokens: event.afterTokens,
      success: event.success,
      ...event.usage,
    });
  };
  const coldMetrics = decision(100_000).metrics;
  const coldPrediction = coldMetrics.estimatedPostCompactTokens;
  const coldAvailability = learner.snapshotWithFallback();
  // Predictions are copied BEFORE the host outcome is generated/ingested on each iteration.
  for (const before of [100_000, 200_000, 300_000]) {
    const availability = learner.snapshotWithFallback();
    const prediction = availability.model
      ? predictCompactorTokens(availability.model, before)
      : null;
    const event = observedCompaction(before);
    events.push(event);
    const status = admitMeasuredFeedback(learner, event, prices);
    observeCore(event);
    checkpoints.push({
      beforeTokens: before,
      prediction,
      status,
      availabilityAfter: learner.snapshotWithFallback().source,
    });
  }
  // Separate one-sample check: the default EMA is approximate, not an affine solver.
  const single = new FoldPoint();
  const first = events.find((e): e is TraceCompactionEvent => e.type === "compaction");
  if (!first || first.afterTokens === null) throw new Error("missing first feedback");
  single.recordCompaction(sessionId, PROFILE, {
    timestamp: first.timestamp,
    beforeTokens: first.beforeTokens,
    afterTokens: first.afterTokens,
    success: true,
    ...first.usage,
  });
  const learnedMetrics = single.decide({
    sessionId,
    profile: PROFILE,
    timestamp: ++time,
    contextTokens: 100_000,
  }).metrics;
  const afterSingleFeedback = learnedMetrics.estimatedPostCompactTokens;
  const firstSummaryCost = costOfUsage(prices, { ...first.usage, promptTokens: 100_000 });

  const model = learner.snapshotWithFallback().model;
  if (!model) throw new Error("controlled training failed to identify model");
  const heldoutBefore = 250_000;
  const heldoutPrediction = predictCompactorTokens(model, heldoutBefore);
  const predictedSummaryCost =
    heldoutBefore * model.summaryInputCostPerToken +
    heldoutPrediction.outputTokens * prices.outputPerToken;
  // Reveal held-out truth only after capturing prediction. This is a wiring check, not blind data.
  const heldout = observedCompaction(heldoutBefore);
  events.push(heldout);
  const actualSummaryCost = costOfUsage(prices, { ...heldout.usage, promptTokens: heldoutBefore });
  admitMeasuredFeedback(learner, heldout, prices);
  observeCore(heldout);

  const beforeFailure = learner.exportObservations();
  const coreBeforeFailure = core.decide({
    sessionId,
    profile: PROFILE,
    timestamp: ++time,
    contextTokens: heldoutBefore,
  }).metrics;
  const failed = observedCompaction(heldoutBefore, false);
  events.push(failed);
  const failureStatus = admitMeasuredFeedback(learner, failed, prices);
  observeCore(failed);
  const coreAfterFailure = decision(heldoutBefore).metrics;

  // Audit variants are admission probes, not extra billable attempts in the trajectory.
  const rejected = [
    { ...heldout, afterTokensSource: "host-estimate" as const, afterTokens: 95_000 },
    { ...heldout, afterTokensSource: undefined },
    { ...heldout, afterTokens: null },
    { ...heldout, usage: { promptTokens: heldoutBefore } },
  ].map((event) => admitMeasuredFeedback(learner, event, prices));
  const feedbackUntouched =
    JSON.stringify(beforeFailure) === JSON.stringify(learner.exportObservations());

  // Explicit separate prewarm followed by 5K known growth; neither is summary retention.
  const after = heldout.afterTokens;
  if (after === null) throw new Error("missing heldout size");
  events.push(
    trace.cacheWarm(sessionId, ++time, {
      promptTokens: after,
      cachedInputTokens: 0,
      cacheWriteTokens: after,
      outputTokens: 1,
      actualCost: costOfUsage(prices, {
        promptTokens: after,
        cachedInputTokens: 0,
        cacheWriteTokens: after,
        outputTokens: 1,
      }),
    }),
  );
  const nextInput = {
    sessionId,
    profile: PROFILE,
    timestamp: ++time,
    contextTokens: after + 5_000,
  };
  events.push(trace.decision(nextInput, core.decide(nextInput), { callId: "post-compact-1" }));
  const request = {
    timestamp: ++time,
    promptTokens: after + 5_000,
    cachedInputTokens: after,
    cacheWriteTokens: 0,
    outputTokens: 700,
  };
  events.push(trace.request(sessionId, "post-compact-1", request));
  core.observeRequest(sessionId, PROFILE, request);
  const growth = core.getSessionState(sessionId, PROFILE);
  events.push(trace.sessionEnd(sessionId, { timestamp: ++time }));
  const accounting = analyzeTraceEvents(events).sessionCosts[0];
  if (!accounting) throw new Error("missing fixture bill");

  // Low-span history can retain an identifiable fit; changed feedback must invalidate it.
  for (let i = 0; i < 32; i++) admitMeasuredFeedback(learner, observedCompaction(250_000), prices);
  const stable = learner.snapshotWithFallback();
  admitMeasuredFeedback(learner, observedCompaction(250_000, true, true), prices);
  const drifted = learner.snapshotWithFallback();
  for (let i = 0; i < 32; i++) {
    admitMeasuredFeedback(
      learner,
      observedCompaction([100_000, 200_000, 300_000][i % 3] ?? 100_000, true, true),
      prices,
    );
  }
  const recovered = learner.snapshotWithFallback();
  const recoveredPrediction = recovered.model
    ? predictCompactorTokens(recovered.model, heldoutBefore)
    : null;
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  const expected = truth(heldoutBefore);
  const expectedChanged = truth(heldoutBefore, true);
  const checks = {
    coldModelUnavailable: coldAvailability.source === "unavailable",
    noTrainingLookahead: checkpoints.every((c) => c.prediction === null),
    coreFeedbackMovesTowardObservation:
      Math.abs(afterSingleFeedback - 24_000) < Math.abs(coldPrediction - 24_000),
    coreCostMovesTowardObservation:
      Math.abs(learnedMetrics.estimatedCompactCallCost - firstSummaryCost) <
      Math.abs(coldMetrics.estimatedCompactCallCost - firstSummaryCost),
    heldoutContextCorrect: near(heldoutPrediction.afterTokens, expected.afterTokens),
    heldoutOutputCorrect: near(heldoutPrediction.outputTokens, expected.outputTokens),
    heldoutSummaryCostCorrect: near(predictedSummaryCost, actualSummaryCost),
    rejectedFeedbackDoesNotTrain:
      feedbackUntouched && failureStatus === "failed" && rejected.every((r) => r !== "accepted"),
    failedCoreRetentionUnchanged:
      coreBeforeFailure.estimatedPostCompactTokens === coreAfterFailure.estimatedPostCompactTokens,
    completeBill: accounting.unpricedCompactions === 0 && near(accounting.totalCost, 1.395765),
    summaryBill:
      near(accounting.compactionCost, 1.24875) &&
      accounting.compactions === 4 &&
      accounting.compactionsNotRun === 1,
    prewarmBill: near(accounting.cacheWarmCost, 0.112515) && accounting.cacheWarms === 1,
    ordinaryBill: near(accounting.callCost, 0.0345) && accounting.calls === 1,
    growthDoesNotIncludeCompactionDrop:
      growth.growthSamples === 1 && growth.growthTokensEma === 5_000,
    lowSpanRetains: stable.source === "retained",
    driftInvalidates: drifted.source === "unavailable" && drifted.reason === "feedback-drift",
    freshFeedbackRecovers:
      recovered.source === "fitted" &&
      recoveredPrediction !== null &&
      near(recoveredPrediction.afterTokens, expectedChanged.afterTokens) &&
      near(recoveredPrediction.outputTokens, expectedChanged.outputTokens),
  };
  return {
    runner: "foldpoint.controlled-feedback.v1",
    mode: "offline-synthetic",
    usage: { paidCalls: 0, externalHttpCalls: 0 },
    defaultPolicyChanged: false,
    piFeedbackChanged: false,
    checks,
    passed: Object.values(checks).every(Boolean),
    core: {
      coldPrediction,
      afterSingleFeedback,
      observedAfter: 24_000,
      coldSummaryCost: coldMetrics.estimatedCompactCallCost,
      learnedSummaryCost: learnedMetrics.estimatedCompactCallCost,
      observedSummaryCost: firstSummaryCost,
      growthTokens: growth.growthTokensEma,
    },
    checkpoints,
    heldout: {
      beforeTokens: heldoutBefore,
      prediction: heldoutPrediction,
      actual: expected,
      predictedSummaryCost,
      actualSummaryCost,
    },
    rejected,
    accounting,
    drift: {
      stable: stable.source,
      invalidated: drifted.source,
      reason: drifted.reason,
      recovered: recovered.source,
      prediction: recoveredPrediction,
      actual: expectedChanged,
    },
    limitations: [
      "公开确定性仿真，只验证接线、学习响应和账单，不证明真实任务质量或省钱。",
      "尺寸留出仍来自同一个已知 affine fixture，不是独立真实数据集或模型泛化证据。",
      "host-measured 由受控宿主保证同口径且无中途增长；仅有标签不能证明真实宿主满足条件。",
      "默认 EMA 与实验 affine 学习器分别验证；未把实验模型接管默认核心或 Pi。",
      "低跨度/漂移阶段是独立反馈压力测试，不计入前面的五次摘要账单。",
      "价格为假设计费 fixture，不是任何供应商当前报价；未读取 API key 或请求正文。",
    ],
  };
}

export function renderFeedbackProbe(r: ReturnType<typeof runFeedbackProbe>) {
  return [
    "# 受控压缩反馈闭环：离线验证",
    "",
    `状态：${r.passed ? "通过" : "失败"}；${Object.values(r.checks).filter(Boolean).length}/${Object.keys(r.checks).length} 项检查；付费调用 0。`,
    "",
    `默认 EMA：100k 上下文冷启动预测 ${r.core.coldPrediction}；收到实际 ${r.core.observedAfter} 的一次反馈后预测 ${r.core.afterSingleFeedback}。它向观测移动，并非一次学成真实函数。`,
    `默认摘要费用预测 ${r.core.coldSummaryCost.toFixed(6)} → ${r.core.learnedSummaryCost.toFixed(6)}，实际 ${r.core.observedSummaryCost.toFixed(6)}；压缩后的增长观测为 ${r.core.growthTokens}，不把压缩下降当作负增长。`,
    "",
    "实验模型训练只使用先前 100k/200k/300k 的观测。250k 留出输入先预测、后揭示结果：",
    `压缩后上下文 ${r.heldout.prediction.afterTokens} / 实际 ${r.heldout.actual.afterTokens}；摘要输出 ${r.heldout.prediction.outputTokens} / 实际 ${r.heldout.actual.outputTokens}。`,
    `摘要预测费用 ${r.heldout.predictedSummaryCost.toFixed(6)} / 实际 ${r.heldout.actualSummaryCost.toFixed(6)}（假设美元价格）。`,
    "",
    `独立手算账单：4 次成功摘要 + 1 次失败尝试合计 ${r.accounting.compactionCost.toFixed(6)}；一次预热 ${r.accounting.cacheWarmCost.toFixed(6)}；一次含 5k 新增长的普通请求 ${r.accounting.callCost.toFixed(6)}；总计 ${r.accounting.totalCost.toFixed(6)}。失败不训练成功模型，费用仍计入。`,
    "",
    `一致低跨度反馈：${r.drift.stable}；观测漂移：${r.drift.invalidated}/${r.drift.reason}；足够新反馈后：${r.drift.recovered}。`,
    "",
    "## 检查",
    "",
    ...Object.entries(r.checks).map(([key, passed]) => `- ${key}: ${passed ? "PASS" : "FAIL"}`),
    "",
    "## 限制",
    "",
    ...r.limitations.map((s) => `- ${s}`),
    "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("usage: tsx tools/compactor-feedback-probe.ts");
  const result = runFeedbackProbe();
  writeFileSync(
    fileURLToPath(new URL("../benchmarks/compactor-feedback.md", import.meta.url)),
    renderFeedbackProbe(result),
  );
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
