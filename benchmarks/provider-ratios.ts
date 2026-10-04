/** Price sensitivity only: never connects to a model provider. */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PricingSnapshot } from "../src/index";
import { createRawFixedThresholdStrategy } from "./fixed-threshold";
import { buildRuntimeSurvivalScenarios } from "./runtime-survival";
import type { Scenario } from "./scenarios";
import { createFoldPointStrategy, runSession } from "./simulator";

const deepseek = "https://api-docs.deepseek.com/quick_start/pricing/";
const claude = "https://platform.claude.com/docs/en/about-claude/pricing";
const gemini = "https://ai.google.dev/gemini-api/docs/pricing";
function required<T>(arms: Record<string, T>, name: string): T {
  const value = arms[name];
  if (value === undefined) throw new Error(`Missing arm: ${name}`);
  return value;
}
function profile(
  id: string,
  source: string,
  input: number,
  output: number,
  read: number,
  write = input,
) {
  return {
    id,
    source,
    pricing: {
      currency: "USD",
      inputPerMillion: input,
      outputPerMillion: output,
      cacheReadPerMillion: read,
      cacheWritePerMillion: write,
    } satisfies PricingSnapshot,
  };
}
/** Frozen standard text prices, USD/MTok, verified 2026-10-04. */
export const PRICE_PROFILES = [
  profile("deepseek-flash-peak", deepseek, 0.3, 1.2, 0.006),
  profile("deepseek-flash-offpeak", deepseek, 0.15, 0.6, 0.003),
  profile("deepseek-v4-pro-peak", deepseek, 1.32, 3.96, 0.044),
  profile("claude-sonnet-5.5-5m-price", claude, 2, 10, 0.2, 2.5),
  profile("claude-sonnet-5.5-1h-price", claude, 2, 10, 0.2, 4),
  profile("claude-opus-5.5-5m-price", claude, 4, 20, 0.2, 5),
  profile("gemini-2.5-flash-text", gemini, 0.3, 2.5, 0.03),
  profile("gemini-2.5-flash-lite-text", gemini, 0.1, 0.4, 0.01),
];

export function ratioScenarios() {
  // One price family only; no triplicate behavior fixtures or price-dependent tuning.
  return buildRuntimeSurvivalScenarios().filter((s) => s.id.includes("cheapRead-"));
}

export function providerRatioReport(scenarios = ratioScenarios(), profiles = PRICE_PROFILES) {
  const rows = profiles.flatMap((p) =>
    scenarios.map((base) => {
      const scenario: Scenario = { ...base, pricing: p.pricing };
      const common = {
        omitRequestCacheEvidence: true,
        verifiedAppendOnlyPrefix: true,
        defaults: { compactOutputRatio: 0.002 },
        runtimeSurvival: { continuationProbability: 0.95, maxImmediateLossRatio: 1 },
      };
      const strategies = {
        nativeTimingProxy: createRawFixedThresholdStrategy((1_000_000 - 16_384) / 1_000_000),
        fixed60: createRawFixedThresholdStrategy(0.6),
        current: createFoldPointStrategy(scenario, {
          omitRequestCacheEvidence: true,
          defaults: { compactOutputRatio: 0.002 },
        }),
        experimental: createFoldPointStrategy(scenario, common),
        cumulativeRisk: createFoldPointStrategy(scenario, { ...common, runtimeRiskBudgetRatio: 1 }),
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
              steps: run.compactions.map((c) => c.step),
            },
          ];
        }),
      );
      return {
        profile: p.id,
        id: base.id,
        calls: base.steps,
        suite: base.id.startsWith("near-end-") ? "near-end" : "matrix",
        cache: base.id.includes("-warm-")
          ? "warm"
          : base.id.includes("-coldAfterMidpoint-")
            ? "midpoint"
            : "cold",
        arms,
      };
    }),
  );
  const summary = profiles.flatMap((p) =>
    ["matrix", "near-end"].flatMap((suite) =>
      ["all", "warm", "cold", "midpoint"].flatMap((cache) =>
        ["fixed60", "nativeTimingProxy", "current"].map((baseline) => {
          const selected = rows.filter(
            (r) =>
              r.profile === p.id && r.suite === suite && (cache === "all" || r.cache === cache),
          );
          const compared = selected.filter(
            (r) =>
              required(r.arms, "experimental").attempts > 0 ||
              required(r.arms, baseline).attempts > 0,
          );
          const deltas = compared.map(
            (r) => required(r.arms, "experimental").cost / required(r.arms, baseline).cost - 1,
          );
          return {
            profile: p.id,
            suite,
            cache,
            baseline,
            cases: selected.length,
            compared: compared.length,
            excludedNoCompaction: selected.length - compared.length,
            wins: deltas.filter((d) => d < -1e-9).length,
            losses: deltas.filter((d) => d > 1e-9).length,
            ties: deltas.filter((d) => Math.abs(d) <= 1e-9).length,
            meanRelativeChange: deltas.length
              ? deltas.reduce((a, b) => a + b, 0) / deltas.length
              : null,
            worstRelativeChange: deltas.length ? Math.max(...deltas) : null,
            attempts: selected.reduce((a, r) => a + required(r.arms, "experimental").attempts, 0),
            overflow: selected.reduce((a, r) => a + required(r.arms, "experimental").overflow, 0),
          };
        }),
      ),
    ),
  );
  return {
    kind: "foldpoint.provider-price-ratios.v1",
    verifiedAt: "2026-10-04",
    paidCalls: 0,
    providers: 3,
    behaviorCasesPerProfile: scenarios.length,
    profiles,
    limitations: [
      "只替换价格；所有模型保持相同 1M 窗口、token 数、缓存寿命、增长和压缩器质量，不证明真实模型支持该配置或任务质量。",
      "实验分支固定 q=0.95/loss=1，不按供应商调参；不是默认算法，也不是已上线 Pi 策略。",
      "价格名中的 5m/1h 只选择写价，缓存寿命仍是共同场景假设，不是对应服务商的完整制度模拟。",
      "未列独立写价的服务商按 input 价映射 write；忽略显式缓存存储费、最低缓存门槛、长上下文阶梯、tokenizer 差异和额外思考 token。",
      "共享模拟器把存活缓存的新增尾部按 input 计价；不模拟 Claude 新尾部 cache-write 的完整账单。",
      "Pi 原生是阈值代理，不是真实 Pi 执行；有权威 append-only 前缀的实验条件不保证真实宿主提供。",
      "相对变化为逐场景算术平均，不是按真实流量加权；无压缩双方排除胜负但保留明细。",
      "DeepSeek peak/offpeak 是同一比例缩放控制，不算独立价格比例；所有旧报告保留。",
    ],
    summary,
    rows,
  };
}

export function renderProviderRatios(report: ReturnType<typeof providerRatioReport>) {
  return [
    "# 多供应商价格比例：零付费敏感性实验",
    "",
    "固定同一批场景和参数，只替换公开价格。负数表示实验分支更便宜。",
    "",
    "| 价格配置 | 缓存 | 对比 | 胜/负/平 | 平均费用变化 | 最差费用变化 |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.summary
      .filter((s) => s.suite === "matrix" && s.baseline === "fixed60")
      .map(
        (s) =>
          `| ${s.profile} | ${s.cache} | ${s.compared} | ${s.wins}/${s.losses}/${s.ties} | ${((s.meanRelativeChange ?? 0) * 100).toFixed(2)}% | ${((s.worstRelativeChange ?? 0) * 100).toFixed(2)}% |`,
      ),
    "",
    "## 价格来源（2026-10-04，USD/百万 token）",
    "",
    ...report.profiles.map(
      (p) =>
        `- [${p.id}](${p.source}): input ${p.pricing.inputPerMillion}; output ${p.pricing.outputPerMillion}; read ${p.pricing.cacheReadPerMillion}; write/mapping ${p.pricing.cacheWritePerMillion}.`,
    ),
    "",
    "## 边界",
    "",
    ...report.limitations.map((s) => `- ${s}`),
    "",
    "完整 JSON 含近结束反例、原生阈值代理和核心默认分支对照、每条成本与压缩步骤。不得将结果当作多模型真实付费账单或质量结论。",
    "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = providerRatioReport();
  const path = fileURLToPath(new URL("./reports/provider-ratios.json", import.meta.url));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
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
  writeFileSync(new URL("./provider-ratios.md", import.meta.url), renderProviderRatios(report));
  console.log(
    JSON.stringify(
      report.summary.filter(
        (s) => s.suite === "matrix" && s.cache === "all" && s.baseline === "fixed60",
      ),
      null,
      2,
    ),
  );
}
