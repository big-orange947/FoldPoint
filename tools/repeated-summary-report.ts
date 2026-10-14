/** Deterministic, no-network analysis. Only whitelisted public metadata is exported. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRepeatedQualityPlan, repeatedExpected } from "./repeated-summary-corpus";

type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: { total: number };
};
type Source = {
  kind: string;
  mode: string;
  profile: string;
  plan: ReturnType<typeof buildRepeatedQualityPlan>;
  executionModel: {
    provider: string;
    id: string;
    api: string;
    contextWindow: number;
    summaryOutputCap: number;
  };
  piCommit: string;
  piCompactionSourceSha256: string;
  harnessSourceSha256: string;
  corpusSourceSha256: string;
  runArms: string[];
  plannedCalls: number;
  completedPlannedRun: boolean;
  hardFailure: string | null;
  checkpoints: {
    arm: string;
    step: number;
    measured: boolean;
    grade: {
      fields: Record<string, boolean>;
      correct: number;
      total: number;
      exact: boolean;
    } | null;
  }[];
  usageLedger: {
    arm: string;
    kind: string;
    usageKnown: boolean;
    stopReason: string;
    usage: Usage | null;
  }[];
  usage: {
    logicalCalls: number;
    httpCalls: number;
    reportedTokens: number;
    unaccountedHttpAttempts: number;
  };
};
const ARMS = ["fullHistory", "fixed60", "experimental"];
export function analyzeRepeatedSummary(raw: string) {
  const s = JSON.parse(raw) as Source;
  if (
    s.kind !== "foldpoint.pi-repeated-summary-quality.v1" ||
    s.profile !== "repeated" ||
    s.mode !== "live" ||
    !s.completedPlannedRun ||
    s.hardFailure !== null
  )
    throw new Error(
      "requires a completed live repeated-summary run; fake or incomplete runs are not quality evidence",
    );
  if (
    JSON.stringify(s.plan) !== JSON.stringify(buildRepeatedQualityPlan()) ||
    [...s.runArms].sort().join(",") !== [...ARMS].sort().join(",") ||
    s.plannedCalls !== 23 ||
    s.usage.logicalCalls !== 23 ||
    s.usageLedger.length !== 23
  )
    throw new Error("unexpected plan or call set");
  for (const label of [s.executionModel.provider, s.executionModel.id, s.executionModel.api])
    if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(label)) throw new Error("invalid model identifier");
  for (const hash of [s.piCompactionSourceSha256, s.harnessSourceSha256, s.corpusSourceSha256])
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("missing source hash");
  if (!/^[a-f0-9]{40}$/.test(s.piCommit)) throw new Error("invalid Pi commit");
  const expectedKeys = ARMS.flatMap((arm) =>
    s.plan.checkpoints.map((step) => `${arm}/${step}`),
  ).sort();
  if (
    JSON.stringify(s.checkpoints.map((c) => `${c.arm}/${c.step}`).sort()) !==
    JSON.stringify(expectedKeys)
  )
    throw new Error("missing or duplicate probes");
  for (const c of s.checkpoints) {
    const g = c.grade;
    if (
      !c.measured ||
      !g ||
      g.total !== 12 ||
      Object.keys(g.fields).sort().join(",") !==
        Object.keys(repeatedExpected(c.step)).sort().join(",") ||
      Object.values(g.fields).some((v) => typeof v !== "boolean") ||
      g.correct !== Object.values(g.fields).filter(Boolean).length ||
      (g.exact && g.correct !== 12)
    )
      throw new Error("invalid measured grade");
  }
  const usageLedger = s.usageLedger.map((c) => {
    if (
      !ARMS.includes(c.arm) ||
      !["check", "summary"].includes(c.kind) ||
      !c.usageKnown ||
      !c.usage ||
      c.stopReason !== "stop"
    )
      throw new Error("unknown or incomplete request usage");
    const u = c.usage;
    if (
      [u.input, u.output, u.cacheRead, u.cacheWrite].some((n) => !Number.isSafeInteger(n) || n < 0)
    )
      throw new Error("invalid token counts");
    const catalogCost = u.cost?.total;
    if (catalogCost !== undefined && (!Number.isFinite(catalogCost) || catalogCost < 0))
      throw new Error("invalid catalog cost");
    return {
      arm: c.arm,
      kind: c.kind,
      input: u.input,
      output: u.output,
      cacheRead: u.cacheRead,
      cacheWrite: u.cacheWrite,
      catalogCost: catalogCost ?? null,
    };
  });
  const tokens = usageLedger.reduce(
    (n, u) => n + u.input + u.output + u.cacheRead + u.cacheWrite,
    0,
  );
  if (
    tokens !== s.usage.reportedTokens ||
    s.usage.httpCalls > s.plan.maxHttpCalls ||
    s.usage.httpCalls < 23 ||
    s.usage.unaccountedHttpAttempts !== s.usage.httpCalls - 23
  )
    throw new Error("unreconciled HTTP/token ledger");
  const arms = ARMS.map((arm) => {
    const probes = s.checkpoints.filter((c) => c.arm === arm);
    const calls = usageLedger.filter((c) => c.arm === arm);
    const summaries = calls.filter((c) => c.kind === "summary");
    const expectedSummaries =
      arm === "fullHistory" ? 0 : s.plan.schedules[arm as "fixed60" | "experimental"].length;
    if (
      summaries.length !== expectedSummaries ||
      calls.filter((c) => c.kind === "check").length !== 3
    )
      throw new Error("wrong arm request counts");
    const outputs = summaries.map((c) => c.output);
    return {
      arm,
      summaryCalls: summaries.length,
      probeCalls: probes.length,
      correctFields: probes.reduce((n, c) => n + (c.grade?.correct ?? 0), 0),
      totalFields: 36,
      exactProbes: probes.filter((c) => c.grade?.exact).length,
      summaryOutputTokens: outputs,
      firstSummaryOutput: outputs[0] ?? null,
      lastSummaryOutput: outputs.at(-1) ?? null,
    };
  });
  const fieldRegressions = s.plan.checkpoints.flatMap((step) => {
    const fixed = s.checkpoints.find((c) => c.arm === "fixed60" && c.step === step)?.grade;
    const candidate = s.checkpoints.find((c) => c.arm === "experimental" && c.step === step)?.grade;
    if (!fixed || !candidate) throw new Error("missing paired probe");
    return Object.keys(fixed.fields)
      .filter((key) => fixed.fields[key] && !candidate.fields[key])
      .map((field) => ({ step, field }));
  });
  const baselineValid = arms.find((a) => a.arm === "fullHistory")?.exactProbes === 3;
  return {
    kind: "foldpoint.repeated-summary-result.v1",
    sourceReportSha256: createHash("sha256").update(raw).digest("hex"),
    plan: s.plan,
    executionModel: {
      provider: s.executionModel.provider,
      id: s.executionModel.id,
      api: s.executionModel.api,
      contextWindow: s.executionModel.contextWindow,
      summaryOutputCap: s.executionModel.summaryOutputCap,
    },
    provenance: {
      piCommit: s.piCommit,
      piCompactionSourceSha256: s.piCompactionSourceSha256,
      harnessSourceSha256: s.harnessSourceSha256,
      corpusSourceSha256: s.corpusSourceSha256,
    },
    paidHttpCalls: s.usage.httpCalls,
    reportedTokens: tokens,
    unaccountedHttpAttempts: s.usage.unaccountedHttpAttempts,
    catalogEstimatedCost: usageLedger.every((u) => u.catalogCost !== null)
      ? usageLedger.reduce((n, u) => n + (u.catalogCost ?? 0), 0)
      : null,
    costScope:
      "Pi catalog estimate for summary/probe requests only, not a provider invoice or complete agent-session cost comparison",
    arms,
    fieldRegressions,
    probes: s.checkpoints,
    usageLedger,
    interpretation: {
      comparisonReady: baselineValid,
      allProbesCorrect: arms.every((a) => a.exactProbes === 3),
      measuredRetention: true,
      measuredAgentTaskCompletion: false,
      measuredLiveTiming: false,
      measuredOneMillionContext: false,
      statisticalNonInferiorityEstablished: false,
      piDefaultChanged: false,
    },
    limitations: s.plan.limitations,
  };
}
export function renderRepeatedSummary(r: ReturnType<typeof analyzeRepeatedSummary>) {
  return [
    "# 重复摘要：小规模真实证据保留对照",
    "",
    `Pi 配置模型：${r.executionModel.provider}/${r.executionModel.id}。Pi ${r.provenance.piCommit.slice(0, 9)}；该 ID 是本地模型配置标识，不是独立核实的服务端版本号。`,
    "冻结矩阵只提供压缩曝光时间表，三个组均用同一个 DeepSeek 模型；不是 Claude 质量实测，也不是本轮运行动态时机算法。",
    "",
    "| 组 | 真实摘要次数 | 检查点完全正确 | 字段正确 | 摘要调用输出首/末 tokens（provider用量） |",
    "| --- | --- | --- | --- | --- |",
    ...r.arms.map(
      (a) =>
        `| ${a.arm} | ${a.summaryCalls} | ${a.exactProbes}/3 | ${a.correctFields}/36 | ${a.firstSummaryOutput ?? "—"}/${a.lastSummaryOutput ?? "—"} |`,
    ),
    "",
    `实际 HTTP ${r.paidHttpCalls} 次，provider 报告 ${r.reportedTokens} tokens；未对账 HTTP ${r.unaccountedHttpAttempts}。`,
    `目录价格折算约 US$${r.catalogEstimatedCost?.toFixed(6) ?? "未知"}，不是供应商账单，只覆盖摘要和探针调用；不能比较两种时机的完整 Agent 费用。`,
    `完整历史参考有效：${r.interpretation.comparisonReady}；候选相对 fixed60 的字段退化数：${r.fieldRegressions.length}。`,
    "",
    "通过这些检查只说明此公开日志上的关键事实/更正/前置条件被保留，不能证明普遍质量不降或真实任务完成率。输出 token 用量不等于压缩后上下文大小，本轮未独立测量摘要文本长度/保留率；摘要膨胀与后续复用成本仍需实测。未改动算法、默认核心或 Pi。",
    "",
    "## 限制",
    "",
    ...r.limitations.map((s) => `- ${s}`),
    "",
  ].join("\n");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3)
    throw new Error("usage: tsx tools/repeated-summary-report.ts <report.json>");
  const input = process.argv[2];
  if (!input) throw new Error("missing report path");
  const result = analyzeRepeatedSummary(readFileSync(input, "utf8"));
  const root = fileURLToPath(new URL("../", import.meta.url));
  writeFileSync(
    resolve(root, "benchmarks/reports/repeated-summary-result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  writeFileSync(resolve(root, "benchmarks/repeated-summary.md"), renderRepeatedSummary(result));
  console.log(
    JSON.stringify({
      interpretation: result.interpretation,
      calls: result.paidHttpCalls,
      tokens: result.reportedTokens,
      catalogEstimate: result.catalogEstimatedCost,
    }),
  );
}
