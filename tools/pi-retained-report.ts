/** Publish only whitelisted numeric capture metadata; no session identifiers or prompt contents. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { costOfUsage, resolveUnitPrices } from "../src/pricing";

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
interface Capture {
  completed: boolean;
  mode: string;
  sourceSha256: string;
  piCommit: string;
  model: { provider: string; id: string; contextWindow: number };
  checks: Record<string, boolean>;
  usage: { httpCalls: number; unaccountedHttpAttempts: number; reportedTokens: number };
  ledger: Array<{ stage: string; usage: Usage | null; stopReason: string }>;
  retainedShadow: {
    samples: number;
    pendingRequests: number;
    pendingSummary: boolean;
    applied: boolean;
    helperSha256?: string;
    learnerSha256?: string;
    events: Array<Record<string, unknown>>;
  };
  analysis: { sessionCosts: Array<{ totalCost: number }> };
}
export function publishRetainedCapture(r: Capture) {
  if (
    !r.completed ||
    r.mode !== "live" ||
    !Object.values(r.checks).every(Boolean) ||
    r.usage.httpCalls !== 4 ||
    r.usage.unaccountedHttpAttempts !== 0 ||
    r.ledger.length !== 4
  )
    throw new Error("incomplete capture");
  if (!r.checks.fourCompletedCalls || !r.checks.oneNativeCompaction || !r.checks.noHiddenHttp)
    throw new Error("missing capture checks");
  const s = r.retainedShadow;
  if (s.applied || s.samples !== 1 || s.pendingRequests !== 0 || s.pendingSummary)
    throw new Error("incomplete shadow");
  const prices = resolveUnitPrices({
    inputPerMillion: 0.3,
    outputPerMillion: 1.2,
    cacheReadPerMillion: 0.006,
  });
  const calls = r.ledger.map((row) => {
    const u = row.usage;
    if (
      !u ||
      row.stopReason !== "stop" ||
      !Object.values(u).every((v) => Number.isSafeInteger(v) && v >= 0)
    )
      throw new Error("incomplete usage");
    const pred = s.events.filter((e) => e.type === "request_prediction" && e.stage === row.stage),
      actual = s.events.filter((e) => e.type === "request_usage" && e.stage === row.stage);
    if (
      !/^(pre-compaction|summary|first-post|second-post)$/.test(row.stage) ||
      !Number.isSafeInteger(pred[0]?.seq) ||
      !Number.isSafeInteger(actual[0]?.seq)
    )
      throw new Error("invalid prediction metadata");
    if (
      pred.length !== 1 ||
      actual.length !== 1 ||
      Number(pred[0]?.seq) >= Number(actual[0]?.seq) ||
      actual[0]?.predictionSeq !== pred[0]?.seq ||
      pred[0]?.cacheUsageKnown !== false
    )
      throw new Error("unpaired forecast");
    const prompt = u.input + u.cacheRead + u.cacheWrite;
    const recorded = actual[0]?.usage as {
      promptTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      cacheWriteTokens: number;
    };
    if (
      !recorded ||
      recorded.promptTokens !== prompt ||
      recorded.outputTokens !== u.output ||
      recorded.cachedInputTokens !== u.cacheRead ||
      recorded.cacheWriteTokens !== u.cacheWrite
    )
      throw new Error("usage mismatch");
    const estimate = Number(pred[0]?.promptHostEstimate);
    if (!Number.isFinite(estimate) || estimate < 0) throw new Error("invalid forecast");
    return {
      stage: row.stage,
      promptTokens: prompt,
      cachedInputTokens: u.cacheRead,
      cacheWriteTokens: u.cacheWrite,
      outputTokens: u.output,
      promptHostEstimate: estimate,
      promptRelativeError: estimate / prompt - 1,
      priorSamples: Number(pred[0]?.priorSamples),
      hypotheticalAfterHostTokens: pred[0]?.predictedAfterHostTokensIfCompacted ?? null,
      totalCost: costOfUsage(prices, recorded),
    };
  });
  const prediction = s.events.find((e) => e.type === "summary_prediction"),
    feedback = s.events.find((e) => e.type === "summary_feedback");
  if (
    !prediction ||
    !feedback ||
    Number(prediction.seq) >= Number(feedback.seq) ||
    prediction.priorSamples !== 0 ||
    feedback.predictionSeq !== prediction.seq ||
    calls.find((c) => c.stage === "first-post")?.priorSamples !== 1
  )
    throw new Error("invalid learning order");
  const totalCost = calls.reduce((s, c) => s + c.totalCost, 0);
  if (
    !Number.isFinite(r.analysis.sessionCosts[0]?.totalCost) ||
    Math.abs(totalCost - (r.analysis.sessionCosts[0]?.totalCost ?? NaN)) > 1e-10
  )
    throw new Error("bill mismatch");
  return {
    provider: r.model.provider,
    model: r.model.id,
    declaredWindowTokens: r.model.contextWindow,
    piCommit: r.piCommit,
    producerSha256: r.sourceSha256,
    helperSha256: s.helperSha256 ?? null,
    learnerSha256: s.learnerSha256 ?? null,
    httpCalls: r.usage.httpCalls,
    reportedTokens: r.usage.reportedTokens,
    totalCost,
    calls,
    maxActualPromptTokens: Math.max(...calls.map((c) => c.promptTokens)),
    summaryPrediction: {
      beforeHostTokens: Number(prediction.beforeHostTokens),
      predictedAfterHostTokens: Number(prediction.predictedAfterHostTokens),
      actualAfterHostEstimate: Number(feedback.afterHostEstimate),
    },
    promptMeanAbsoluteRelativeError:
      calls.reduce((s, c) => s + Math.abs(c.promptRelativeError), 0) / calls.length,
    policyChanged: false,
    timingControlExercised: false,
    qualityMeasured: false,
  };
}

export function renderRetainedReport(report: {
  runs: ReturnType<typeof publishRetainedCapture>[];
}) {
  const lines = [
    "# Pi 请求前保留长度旁路：真实小额验证",
    "",
    "两次真实DeepSeek采集，合计8次HTTP。第一轮接通后补充显式的假设压缩后长度字段及helper指纹，第二轮使用最终版本复验；两轮都计费，没有把第一次的producer当成最终版本。",
    "",
    "仅验证真实Pi SDK下的请求前预测、成功摘要后的宿主长度学习和provider用量闭环。声明窗口1M，实际最大prompt只有数千token；不是1M压力测试、动态时机对照或任务质量证据。摘要手动触发，缓存预热关闭，生产Pi插件未改。",
    "",
    "金额按历史目录价 input=$0.3/M、output=$1.2/M、cacheRead=$0.006/M核算，不是已核实的实时价格或发票。",
    "",
    "|轮次|HTTP|报告token|最大实际prompt|目录价费用USD|",
    "|---:|---:|---:|---:|---:|",
  ];
  report.runs.forEach((r, i) => {
    lines.push(
      `|${i + 1}|${r.httpCalls}|${r.reportedTokens}|${r.maxActualPromptTokens}|${r.totalCost.toFixed(9)}|`,
    );
  });
  lines.push(
    "",
    `合计目录价费用 USD ${report.runs.reduce((s, r) => s + r.totalCost, 0).toFixed(9)}。`,
    "",
    "最终轮的逐次结果：",
    "",
    "|阶段|请求前prompt宿主估计|provider实际prompt|缓存读取|输出|预测前已有摘要样本|",
    "|---|---:|---:|---:|---:|---:|",
  );
  const last = report.runs.at(-1);
  for (const c of last?.calls ?? [])
    lines.push(
      `|${c.stage}|${c.promptHostEstimate}|${c.promptTokens}|${c.cachedInputTokens}|${c.outputTokens}|${c.priorSamples}|`,
    );
  if (last)
    lines.push(
      "",
      `最终轮10%先验预测压缩后 ${last.summaryPrediction.predictedAfterHostTokens} token，Pi即时宿主估计为 ${last.summaryPrediction.actualAfterHostEstimate}；该冷启动误差完整保留。请求前全prompt宿主估计的平均绝对相对误差约 ${(100 * last.promptMeanAbsoluteRelativeError).toFixed(2)}%，它来自当前上下文估计，不能归功于新保留长度模型。`,
      "",
      "假设压缩后长度字段确实使用已学习模型计算，但后续没有再次实际压缩，不能评分这些假设预测。一次摘要也不足以验证跨尺度模型选择。缓存用量在结果返回前保持未知；冷/全命中费用只表达两种假设，不是统计置信区间，也不涵盖所有缓存写价制度。摘要输出预测为未知，不把未知输出当作零费用预测。",
    );
  lines.push(
    "",
    "原始文件保留在本地忽略目录，公开JSON只保留数字、模型标识与指纹，不含会话标识、时间戳、prompt、摘要正文或密钥。",
    "",
  );
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = process.argv.slice(2);
  if (paths.length !== 2) throw new Error("Expected two capture reports");
  const bytes = paths.map((p) => readFileSync(p));
  const runs = bytes.map((b) => publishRetainedCapture(JSON.parse(b.toString("utf8"))));
  const report = {
    runner: "foldpoint.pi-retained-shadow-live.v1",
    paidCallsByAnalyzer: 0,
    recordedPaidHttpCalls: runs.reduce((s, r) => s + r.httpCalls, 0),
    rawReportSha256: bytes.map((b) => createHash("sha256").update(b).digest("hex")),
    runs,
  };
  writeFileSync(
    "benchmarks/reports/pi-retained-shadow-live.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync("benchmarks/pi-retained-shadow-live.md", renderRetainedReport(report));
  process.stdout.write(renderRetainedReport(report));
}
