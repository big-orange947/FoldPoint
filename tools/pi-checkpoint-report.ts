import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { costOfUsage, type UnitPrices } from "../src/pricing";

interface Capture {
  mode: string;
  completed: boolean;
  archiveUnchanged: boolean;
  unknownHttpCalls: number;
  httpCalls: number;
  archiveSha256: string;
  producerSha256: string;
  helperSha256: string;
  declaredWindowTokens: number;
  preparedBefore: number;
  historicalBefore: number;
  prices: UnitPrices;
  totalCost: number;
  compaction: { beforeHostTokens: number; immediateAfterHostEstimate: number };
  ledger: Array<{
    stage: string;
    promptHostEstimate: number;
    httpAttempts: number;
    stopReason: string;
    cost: number;
    usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  }>;
  shadow: {
    samples: number;
    pendingRequests: number;
    pendingSummary: boolean;
    applied: boolean;
    events: Array<Record<string, unknown>>;
  };
}
export function publishCheckpoint(r: Capture) {
  if (
    r.mode !== "live" ||
    !r.completed ||
    !r.archiveUnchanged ||
    r.unknownHttpCalls !== 0 ||
    r.httpCalls !== r.ledger.length ||
    r.httpCalls < 3 ||
    r.httpCalls > 4 ||
    r.preparedBefore !== r.historicalBefore ||
    r.preparedBefore < 500000 ||
    r.preparedBefore > 650000
  )
    throw new Error("incomplete target-size capture");
  if (
    r.shadow.samples !== 1 ||
    r.shadow.applied ||
    r.shadow.pendingSummary ||
    r.shadow.pendingRequests !== 0
  )
    throw new Error("incomplete shadow");
  const calls = r.ledger.map((row) => {
    const u = row.usage;
    if (
      !u ||
      row.stopReason !== "stop" ||
      row.httpAttempts !== 1 ||
      !Object.values(u).every((v) => Number.isSafeInteger(v) && v >= 0) ||
      !Number.isFinite(row.promptHostEstimate)
    )
      throw new Error("incomplete usage");
    if (!["summary", "summary-part2", "first-post", "second-post"].includes(row.stage))
      throw new Error("invalid stage");
    const prompt = u.input + u.cacheRead + u.cacheWrite,
      usage = {
        promptTokens: prompt,
        outputTokens: u.output,
        cachedInputTokens: u.cacheRead,
        cacheWriteTokens: u.cacheWrite,
      };
    const cost = costOfUsage(r.prices, usage);
    if (!Number.isFinite(row.cost) || Math.abs(cost - row.cost) > 1e-10)
      throw new Error("usage bill mismatch");
    const pred = r.shadow.events.find(
        (e) => e.type === "request_prediction" && e.stage === row.stage,
      ),
      actual = r.shadow.events.find((e) => e.type === "request_usage" && e.stage === row.stage);
    if (
      !pred ||
      !actual ||
      !Number.isSafeInteger(pred.seq) ||
      !Number.isSafeInteger(actual.seq) ||
      Number(pred.seq) >= Number(actual.seq) ||
      actual.predictionSeq !== pred.seq ||
      pred.cacheUsageKnown !== false
    )
      throw new Error("unpaired prediction");
    const recorded = actual.usage as typeof usage;
    if (
      !recorded ||
      Object.keys(usage).some(
        (k) => recorded[k as keyof typeof usage] !== usage[k as keyof typeof usage],
      )
    )
      throw new Error("shadow usage mismatch");
    return {
      stage: row.stage,
      promptHostEstimate: row.promptHostEstimate,
      ...usage,
      cost,
      promptEstimateRelativeError: row.promptHostEstimate / prompt - 1,
    };
  });
  if (
    calls.filter((x) => x.stage === "first-post").length !== 1 ||
    calls.filter((x) => x.stage === "second-post").length !== 1
  )
    throw new Error("missing replay");
  const before = r.shadow.events.find((e) => e.type === "summary_prediction"),
    after = r.shadow.events.find((e) => e.type === "summary_feedback");
  if (
    !before ||
    !after ||
    before.priorSamples !== 0 ||
    after.predictionSeq !== before.seq ||
    before.beforeHostTokens !== r.preparedBefore ||
    after.afterHostEstimate !== r.compaction.immediateAfterHostEstimate
  )
    throw new Error("invalid summary binding");
  const cost = calls.reduce((s, c) => s + c.cost, 0);
  if (!Number.isFinite(r.totalCost) || Math.abs(cost - r.totalCost) > 1e-10)
    throw new Error("incomplete total bill");
  return {
    runner: "foldpoint.pi-checkpoint-retained-public.v1",
    recordedPaidHttpCalls: r.httpCalls,
    archiveSha256: r.archiveSha256,
    producerSha256: r.producerSha256,
    helperSha256: r.helperSha256,
    declaredWindowTokens: r.declaredWindowTokens,
    preparedBeforeHostTokens: r.preparedBefore,
    actualAfterHostEstimate: r.compaction.immediateAfterHostEstimate,
    priorAfterHostPrediction: Number(before.predictedAfterHostTokens),
    retainedHostRatio: r.compaction.immediateAfterHostEstimate / r.preparedBefore,
    prices: r.prices,
    calls,
    totalCost: cost,
    reportedTokens: calls.reduce((s, c) => s + c.promptTokens + c.outputTokens, 0),
    archiveUnchanged: true,
    unknownHttpCalls: 0,
    policyChanged: false,
    qualityMeasured: false,
    summaryInitiator: "manual",
    restoredInMemory: true,
  };
}

export function renderCheckpoint(r: ReturnType<typeof publishCheckpoint>) {
  const lines = [
    "# 约61万上下文的真实Pi检查点验证",
    "",
    "恢复历史合成账本会话到首次摘要前，SessionManager仅在内存中加载此前条目，历史摘要及其后的消息未载入。Pi原生摘要准备长度与历史609860完全一致，原会话文件指纹未变。没有重跑填充轮次，也没有为预热补一次大请求。",
    "",
    `本轮真实HTTP ${r.recordedPaidHttpCalls} 次，provider报告共 ${r.reportedTokens} token；按捕获的历史目录价核算 USD ${r.totalCost.toFixed(9)}。不是供应商实时价格或发票。声明窗口1M，原生摘要前宿主长度 ${r.preparedBeforeHostTokens}；这是真实目标尺度的单次手动摘要验证，不是跑满1M、动态策略对照或质量成绩。`,
    "",
    "|请求|发送前完整消息宿主估计|provider实际输入|缓存读取|输出|目录价费用USD|",
    "|---|---:|---:|---:|---:|---:|",
  ];
  for (const c of r.calls)
    lines.push(
      `|${c.stage}|${c.promptHostEstimate}|${c.promptTokens}|${c.cachedInputTokens}|${c.outputTokens}|${c.cost.toFixed(9)}|`,
    );
  lines.push(
    "",
    `冷启动10%先验预测保留 ${r.priorAfterHostPrediction} token；本次Pi即时宿主估计为 ${r.actualAfterHostEstimate}，即 ${(100 * r.retainedHostRatio).toFixed(2)}%。不是provider压缩后token真值，也不应把此比例设为通用默认。`,
    "",
    "直接对规范化完整消息使用Pi字符估计，当前摘要和后续请求都显著高估provider输入；这与原生tokensBefore基于历史usage的口径不同，不能混用固定偏移。预算预检采用该保守估计和输出上限；0.50美元预检不是账单硬上限。缓存读取在请求前未知，本轮实际用量按返回值计费。",
    "",
    "新估计器的预测事件早于结果事件，成功摘要后获得一个宿主估计样本。没有第二次实际摘要，不能据此证明模型选择更准或策略节费。保留最近内容20000、摘要输出上限13107、普通输出128；自动摘要、重试及SDK缓存预热关闭。至多两次摘要子请求，总HTTP上限4，隐式重复HTTP会被拦截。",
    "",
    "请求仅使用既有合成会话，公开报告不含原文、摘要、会话标识、文件路径、时间戳或密钥。原始数字保存在本地traces忽略目录。下一步先分开校准摘要与普通请求的token口径，再做成对时机对照。",
    "",
  );
  return lines.join("\n");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Expected checkpoint capture report");
  const bytes = readFileSync(process.argv[2] as string),
    r = {
      ...publishCheckpoint(JSON.parse(bytes.toString("utf8"))),
      rawReportSha256: createHash("sha256").update(bytes).digest("hex"),
      paidCallsByAnalyzer: 0,
    };
  writeFileSync(
    "benchmarks/reports/pi-checkpoint-retained-live.json",
    `${JSON.stringify(r, null, 2)}\n`,
  );
  writeFileSync("benchmarks/pi-checkpoint-retained-live.md", renderCheckpoint(r));
  process.stdout.write(renderCheckpoint(r));
}
