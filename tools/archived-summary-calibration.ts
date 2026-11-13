/** Read-only numeric calibration. No provider calls or SessionManager writes. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { costOfUsage, parseTraceJsonl, type TraceEvent, type UnitPrices } from "../src/index";
import { loadTraceSimulationWorld } from "./trace-driven-simulation";

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
export interface ArchiveEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  tokensBefore?: number;
  usage?: Usage;
  message?: { role: string; stopReason?: string; usage?: Usage };
}
const integer = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
function convert(u: Usage | undefined) {
  if (!u || ![u.input, u.output, u.cacheRead, u.cacheWrite].every(integer))
    throw new Error("missing archive usage");
  if (!Number.isSafeInteger(u.input + u.cacheRead + u.cacheWrite))
    throw new Error("invalid usage sum");
  return {
    promptTokens: u.input + u.cacheRead + u.cacheWrite,
    outputTokens: u.output,
    cachedInputTokens: u.cacheRead,
    cacheWriteTokens: u.cacheWrite,
  };
}
function checked(u: {
  promptTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
}) {
  if (
    ![u.promptTokens, u.outputTokens, u.cachedInputTokens, u.cacheWriteTokens].every(integer) ||
    (u.cachedInputTokens ?? 0) + (u.cacheWriteTokens ?? 0) > (u.promptTokens ?? 0)
  )
    throw new Error("missing trace usage");
  return {
    promptTokens: u.promptTokens as number,
    outputTokens: u.outputTokens as number,
    cachedInputTokens: u.cachedInputTokens as number,
    cacheWriteTokens: u.cacheWriteTokens as number,
  };
}
// Compare fields explicitly: object insertion order is not provenance.
const equalUsage = (a: ReturnType<typeof checked>, b: ReturnType<typeof checked>) =>
  a.promptTokens === b.promptTokens &&
  a.outputTokens === b.outputTokens &&
  a.cachedInputTokens === b.cachedInputTokens &&
  a.cacheWriteTokens === b.cacheWriteTokens;

export function calibrateArchive(
  events: readonly TraceEvent[],
  entries: readonly ArchiveEntry[],
  estimateAt: (index: number) => number,
  prices: UnitPrices,
  prior: { inputRate: number; output: number; offset: number },
) {
  if (
    !Number.isFinite(prices.inputPerToken) ||
    prices.inputPerToken <= 0 ||
    ![prior.inputRate, prior.output, prior.offset].every((v) => Number.isFinite(v) && v >= 0)
  )
    throw new Error("invalid calibration prices");
  const requests = events.filter((e) => e.type === "request"),
    summaries = events.filter(
      (e): e is Extract<TraceEvent, { type: "compaction" }> => e.type === "compaction" && e.success,
    );
  if (!requests.length || !summaries.length || !events.some((e) => e.type === "session_end"))
    throw new Error("incomplete trace");
  const sessionIds = new Set(events.flatMap((e) => ("sessionId" in e ? [e.sessionId] : [])));
  if (sessionIds.size !== 1 || new Set(requests.map((e) => e.callId)).size !== requests.length)
    throw new Error("ambiguous trace");
  entries.forEach((e, i) => {
    if (!e.id || (i > 0 && e.parentId !== entries[i - 1]?.id)) throw new Error("nonlinear archive");
  });
  if (new Set(entries.map((e) => e.id)).size !== entries.length)
    throw new Error("duplicate archive ids");
  const assistants = entries
    .map((e, index) => ({ e, index }))
    .filter(({ e }) => e.type === "message" && e.message?.role === "assistant");
  if (assistants.length !== requests.length) throw new Error("request count mismatch");
  assistants.forEach(({ e }, i) => {
    const request = requests[i];
    if (
      request?.outcome !== "ok" ||
      e.message?.stopReason !== "stop" ||
      !equalUsage(convert(e.message.usage), checked(request.usage))
    )
      throw new Error("ordered request mismatch");
  });
  const comps = entries
    .map((e, index) => ({ e, index }))
    .filter(({ e }) => e.type === "compaction");
  if (comps.length !== summaries.length) throw new Error("summary count mismatch");
  return comps.map(({ e, index }, i) => {
    const summary = summaries[i];
    if (
      !summary?.usage ||
      e.tokensBefore !== summary.beforeTokens ||
      !equalUsage(convert(e.usage), checked(summary.usage))
    )
      throw new Error("summary mismatch");
    const next = assistants.find((a) => a.index > index);
    if (!next || entries.slice(index + 1, next.index).some((x) => x.type === "compaction"))
      throw new Error("missing first replay");
    const immediate = estimateAt(index),
      beforeFirst = estimateAt(next.index - 1);
    if (!integer(immediate) || !integer(beforeFirst) || immediate <= 0 || beforeFirst < immediate)
      throw new Error("invalid projected estimates");
    const usage = convert(e.usage),
      replay = convert(next.e.message?.usage),
      before = summary.beforeTokens;
    const actualSummaryCost = costOfUsage(prices, usage),
      firstReplayCost = costOfUsage(prices, replay);
    if (actualSummaryCost <= 0 || costOfUsage(prices, { ...replay, outputTokens: 0 }) <= 0)
      throw new Error("zero calibration cost");
    const projectedNewTokens = beforeFirst - immediate;
    const observedOffset = beforeFirst - replay.promptTokens;
    const estimates = [0.1, 0.11].map((ratio) => {
      const predictedPrompt = Math.max(0, before * ratio + projectedNewTokens - prior.offset);
      const predictedReplayInputCost = predictedPrompt * prices.inputPerToken;
      return {
        ratio,
        predictedAfterHostTokens: before * ratio,
        retentionRelativeError: (before * ratio) / immediate - 1,
        predictedFirstReplayPrompt: predictedPrompt,
        predictedFirstReplayInputCost: predictedReplayInputCost,
        firstReplayInputCostRelativeError:
          predictedReplayInputCost / costOfUsage(prices, { ...replay, outputTokens: 0 }) - 1,
        retentionOnlyConditionedInputCostRelativeError:
          (Math.max(0, before * ratio + projectedNewTokens - observedOffset) *
            prices.inputPerToken) /
            costOfUsage(prices, { ...replay, outputTokens: 0 }) -
          1,
      };
    });
    const predictedSummaryCost = before * prior.inputRate + prior.output * prices.outputPerToken;
    return {
      sequence: i + 1,
      beforeHostTokens: before,
      reconstructedImmediateAfterHostTokens: immediate,
      reconstructedRetention: immediate / before,
      projectedBeforeFirstReplayHostTokens: beforeFirst,
      projectedNewTokens,
      summaryUsage: usage,
      firstReplayUsage: replay,
      firstReplayTraceSeq: requests[assistants.indexOf(next)]?.seq,
      compactionTraceSeq: summary.seq,
      replayRecordedBeforeDeferredCompaction:
        (requests[assistants.indexOf(next)]?.seq ?? Infinity) < summary.seq,
      actualSummaryCost,
      predictedSummaryCost,
      summaryCostRelativeError: predictedSummaryCost / actualSummaryCost - 1,
      firstReplayCost,
      firstReplayInputCost: costOfUsage(prices, { ...replay, outputTokens: 0 }),
      observedFirstReplayHostProviderOffset: observedOffset,
      estimates,
    };
  });
}

export function renderArchiveCalibration(r: { rows: ReturnType<typeof calibrateArchive> }) {
  const lines = [
    "# 历史大上下文摘要与首轮费用校准",
    "",
    "零付费。复用历史固定60%完整会话，将全部普通回复用量与trace逐项、逐顺序匹配，摘要前长度及四项用量也全部匹配。首轮请求按原始会话中的compaction条目定位，不能按延后的trace压缩事件找下一条request。",
    "",
    "即时长度由当前本地Pi源码在历史条目处重建，只是宿主估计；不是历史捕获的即时反馈，也不是provider token真值。重建每次先截断历史，不能读取未来消息。摘要费用先验来自另一批约21万上下文的开发反馈，源批次时间晚于被检查会话；这是跨尺度回顾诊断，不是时间留出测评。",
    "",
    "首轮预测条件使用了重建的新增消息长度，不是请求前端到端预测成绩。固定偏移列同时包含保留率和宿主/provider坐标误差；另列使用本次已知provider用量反推的偏移，仅用于隔离保留率误差，不能当作在线预测。provider费用按记录用量和历史报价核算，不是发票；本轮未请求任何新LLM。",
    "",
    "|序号|摘要前宿主长度|重建即时长度|保留率|摘要实际费用|摘要费用预测误差|首轮实际输入token|首轮缓存读取token|",
    "|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const x of r.rows)
    lines.push(
      `|${x.sequence}|${x.beforeHostTokens}|${x.reconstructedImmediateAfterHostTokens}|${(100 * x.reconstructedRetention).toFixed(2)}%|${x.actualSummaryCost.toFixed(6)}|${(100 * x.summaryCostRelativeError).toFixed(2)}%|${x.firstReplayUsage.promptTokens}|${x.firstReplayUsage.cachedInputTokens}|`,
    );
  lines.push(
    "",
    "|序号|保留率假设|固定偏移的合并误差|对齐坐标后仅保留率误差|",
    "|---:|---:|---:|---:|",
  );
  for (const x of r.rows)
    for (const p of x.estimates)
      lines.push(
        `|${x.sequence}|${100 * p.ratio}%|${(100 * p.firstReplayInputCostRelativeError).toFixed(2)}%|${(100 * p.retentionOnlyConditionedInputCostRelativeError).toFixed(2)}%|`,
      );
  lines.push(
    "",
    "这批会话与此前轨迹来自同一种规则任务，不能证明其他任务的保留率。固定比例假设跨尺度是否成立，应与费用单价误差分别处理；不能把旧trace延迟afterTokens当作即时长度，也不能把重建值回填为历史实测。",
    "",
  );
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 6)
    throw new Error("Expected four bound trace inputs, archive session and Pi root");
  globalThis.fetch = async () => {
    throw new Error("Archive calibration is offline only");
  };
  const loaded = loadTraceSimulationWorld(args.slice(0, 4));
  const traceBytes = readFileSync(args[0] as string),
    archiveBytes = readFileSync(args[4] as string);
  const trace = parseTraceJsonl(new TextDecoder("utf-8", { fatal: true }).decode(traceBytes));
  if (trace.errors.length) throw new Error("invalid trace");
  const raw = new TextDecoder("utf-8", { fatal: true })
    .decode(archiveBytes)
    .trim()
    .split("\n")
    .map((x) => JSON.parse(x));
  if (raw[0]?.type !== "session") throw new Error("invalid archive header");
  const entries = raw.slice(1) as ArchiveEntry[];
  const pi = resolve(args[5] as string);
  const projectionPath = resolve(pi, "packages/coding-agent/src/core/session-manager.ts"),
    estimatePath = resolve(pi, "packages/coding-agent/src/core/compaction/index.ts");
  const [{ buildSessionProjection }, { estimateTokens }] = await Promise.all([
    import(pathToFileURL(projectionPath).href),
    import(pathToFileURL(estimatePath).href),
  ]);
  const estimateAt = (index: number) =>
    buildSessionProjection(entries.slice(0, index + 1), entries[index]?.id).messages.reduce(
      (n: number, m: unknown) => n + estimateTokens(m),
      0,
    );
  const rows = calibrateArchive(trace.events, entries, estimateAt, loaded.world.prices, {
    inputRate: loaded.inputRate,
    output: loaded.output,
    offset: loaded.world.initialContext - loaded.world.initialPrompt,
  });
  const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  const report = {
    runner: "foldpoint.archived-summary-calibration.v1",
    paidCalls: 0,
    prices: loaded.world.prices,
    sources: {
      trace: sha(traceBytes),
      archive: sha(archiveBytes),
      summary: loaded.summaryTraceSha256,
      feedback: loaded.feedbackSha256,
      projectionHelper: sha(readFileSync(projectionPath)),
      estimateHelper: sha(
        readFileSync(resolve(pi, "packages/coding-agent/src/core/compaction/compaction.ts")),
      ),
      calibrationHelper: sha(
        new TextEncoder().encode(
          readFileSync("tools/archived-summary-calibration.ts", "utf8").replace(/\r\n/g, "\n"),
        ),
      ),
    },
    assumptions: {
      hostEstimatesReconstructed: true,
      providerTokenTruth: false,
      summaryInputRate: loaded.inputRate,
      summaryOutput: loaded.output,
      hostProviderOffset: loaded.world.initialContext - loaded.world.initialPrompt,
    },
    rows,
  };
  writeFileSync(
    "benchmarks/reports/archived-summary-calibration.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync("benchmarks/archived-summary-calibration.md", renderArchiveCalibration(report));
  process.stdout.write(renderArchiveCalibration(report));
}
