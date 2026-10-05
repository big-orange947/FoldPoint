/** Compatible prior observations versus cold starts. No test endpoint goes into policy. */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CompactorTokenObservation, resolveUnitPrices } from "../src/index";
import { compactorCases } from "./compactor-model";
import { DURATION_PRIOR } from "./duration-mixture";
import { createRawFixedThresholdStrategy, type Strategy } from "./fixed-threshold";
import { PRICE_PROFILES } from "./provider-ratios";
import type { Scenario } from "./scenarios";
import { createFoldPointStrategy, runSession } from "./simulator";

export function runBillLedger(scenario: Scenario, strategy: Strategy) {
  const bills = Array<number>(scenario.steps).fill(0);
  const wrapped: Strategy = {
    ...strategy,
    onRequest: (e) => {
      bills[e.step] = (bills[e.step] ?? 0) + e.cost;
      strategy.onRequest?.(e);
    },
    onCompaction: (e) => {
      bills[e.step] = (bills[e.step] ?? 0) + e.cost;
      strategy.onCompaction?.(e);
    },
  };
  const run = runSession(scenario, wrapped);
  if (run.metrics.overflowRecoveryCount)
    throw new Error("Recovery needs separate ledger attribution");
  if (Math.abs(bills.reduce((a, b) => a + b, 0) - run.metrics.totalSimulatedCost) > 1e-8)
    throw new Error("Ledger does not reconcile");
  return { run, bills };
}

/** Separate earlier sessions, fixed collection recipe. Only actual successful feedback is exported. */
export function collectCompactorHistory(base: Scenario) {
  const observations: CompactorTokenObservation[] = [];
  let cost = 0;
  const sources: string[] = [];
  for (const threshold of [0.25, 0.6]) {
    const training: Scenario = {
      ...base,
      id: `prior-${threshold}`,
      steps: 85,
      seed: 601,
      startTokens: 4000,
      growthPerStep: 17500,
      growthJitter: 2500,
    };
    sources.push(training.id);
    const prices = resolveUnitPrices(training.pricing);
    const fixed = createRawFixedThresholdStrategy(threshold);
    const run = runSession(training, {
      ...fixed,
      onCompaction: (e) => {
        if (e.success)
          observations.push({
            beforeTokens: e.beforeTokens,
            afterTokens: e.afterTokens,
            outputTokens: e.outputTokens,
            summaryInputCostPerToken:
              Math.max(0, e.cost - e.outputTokens * prices.outputPerToken) / e.beforeTokens,
          });
      },
    });
    cost += run.metrics.totalSimulatedCost;
  }
  return { observations: observations.slice(-32), cost, sources };
}

export function historyReuseReport() {
  const histories: {
    id: string;
    observations: CompactorTokenObservation[];
    cost: number;
    sources: string[];
  }[] = [];
  const rows = PRICE_PROFILES.flatMap((profile) => {
    const byCompatibleFixture = new Map<
      string,
      ReturnType<typeof collectCompactorHistory> & { id: string }
    >();
    return compactorCases().map((base) => {
      const scenario = { ...base, pricing: profile.pricing };
      // Controlled SAME-compactor experiment, not automatic compatibility detection in production.
      const fixtureKey = JSON.stringify(base.compactor);
      let historical = byCompatibleFixture.get(fixtureKey);
      if (!historical) {
        historical = {
          ...collectCompactorHistory(scenario),
          id: `${profile.id}/history-${byCompatibleFixture.size}`,
        };
        byCompatibleFixture.set(fixtureKey, historical);
        histories.push(historical);
      }
      const common = {
        learnedCompactorTokens: true,
        enforceForecastExecutionGates: true,
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
        cold: createFoldPointStrategy(scenario, common),
        warmTokens: createFoldPointStrategy(scenario, {
          ...common,
          compactorHistory: historical.observations,
        }),
        warmCore: createFoldPointStrategy(scenario, {
          ...common,
          compactorHistory: historical.observations,
          warmCoreFromHistory: true,
        }),
      };
      const runs = Object.fromEntries(
        Object.entries(strategies).map(([name, s]) => [name, runBillLedger(scenario, s)]),
      );
      const cutoff =
        runs.fixed60?.run.compactions.find((c) => c.success)?.step ?? scenario.steps - 1;
      const arms = Object.fromEntries(
        Object.entries(runs).map(([name, { run, bills }]) => {
          const first = run.compactions.find((c) => c.success);
          return [
            name,
            {
              cost: run.metrics.totalSimulatedCost,
              attempts: run.metrics.compactionAttemptCount,
              overflow: run.metrics.overflowCount,
              fingerprint: run.metrics.growthSequenceFingerprint,
              firstStep: first?.step ?? null,
              firstUtilization: first ? first.beforeTokens / scenario.contextWindowTokens : null,
              earlyBill: bills.slice(0, cutoff + 1).reduce((a, b) => a + b, 0),
              laterBill: bills.slice(cutoff + 1).reduce((a, b) => a + b, 0),
            },
          ];
        }),
      );
      return {
        id: base.id,
        profile: profile.id,
        historyId: historical.id,
        cutoffStep: cutoff,
        suite: base.id.startsWith("heldout-floor-")
          ? "seen-floor"
          : base.id.startsWith("heldout-margin-")
            ? "seen-proportional"
            : "seen-model",
        arms,
      };
    });
  });
  const summary = PRICE_PROFILES.flatMap((profile) =>
    ["seen-floor", "seen-proportional", "seen-model"].flatMap((suite) =>
      ["cold", "warmTokens", "warmCore"].map((candidate) => {
        const selected = rows.filter((r) => r.profile === profile.id && r.suite === suite);
        const delta = selected.map(
          (r) => (r.arms[candidate]?.cost ?? NaN) / (r.arms.fixed60?.cost ?? NaN) - 1,
        );
        const contribution = (part: "earlyBill" | "laterBill") =>
          selected.reduce(
            (s, r) =>
              s +
              ((r.arms[candidate]?.[part] ?? NaN) - (r.arms.fixed60?.[part] ?? NaN)) /
                (r.arms.fixed60?.cost ?? NaN),
            0,
          ) / selected.length;
        return {
          profile: profile.id,
          suite,
          candidate,
          baseline: "fixed60",
          wins: delta.filter((d) => d < -1e-9).length,
          losses: delta.filter((d) => d > 1e-9).length,
          ties: delta.filter((d) => Math.abs(d) <= 1e-9).length,
          mean: delta.reduce((a, b) => a + b, 0) / delta.length,
          worst: Math.max(...delta),
          earlyContribution: contribution("earlyBill"),
          laterContribution: contribution("laterBill"),
          attempts: selected.reduce((s, r) => s + (r.arms[candidate]?.attempts ?? 0), 0),
        };
      }),
    ),
  );
  return {
    kind: "foldpoint.history-reuse.v1",
    comparator: "fixed60",
    paidCalls: 0,
    histories,
    rows,
    summary,
    limitations: [
      "历史由两次独立的此前合成任务产生（85 步、seed 601、固定 25%/60% 采集），不来自待评测任务的未来压缩。",
      "这是已知兼容的同一合成压缩器对照；fixture 分组只用于控制实验，不是生产自动识别压缩器/底座的算法。",
      "warmTokens 只复用 token/输入费用模型，warmCore 也复用保留率/输出统计；都不继承缓存、当前调用计数、任务终点或 horizon。",
      "历史采集费用单独保留，评测费用假设已有这些历史；不是学习免费，也不建议额外付费强制压缩来制造训练数据。",
      "阶段分界统一取固定 60% 首次成功压缩的那一轮；差额相加严格等于总差额，但不是首压造成损失的因果证明。",
      "全部评测组合已经看过；固定采集配方没有按评测成绩调参，但不能称为新的盲测或真实任务质量验证。",
      "不换核心/Pi 默认策略、不读 key、不调用付费 API；冻结价格只是报价比例模拟，包含等比例控制。",
    ],
  };
}

export function renderHistory(report: ReturnType<typeof historyReuseReport>) {
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
  return [
    "# 历史复用与首压阶段账单（固定 60%）",
    "",
    "负数为省钱；早期/后期贡献以固定 60% 的完整任务费用为分母，二者相加为平均变化。",
    "",
    "| 价格 | 分组 | 策略 | 胜/负/平 | 平均变化 | 最差变化 | 早期贡献 | 后期贡献 | 压缩次数 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.summary.map(
      (s) =>
        `| ${s.profile} | ${s.suite} | ${s.candidate} | ${s.wins}/${s.losses}/${s.ties} | ${pct(s.mean)} | ${pct(s.worst)} | ${pct(s.earlyContribution)} | ${pct(s.laterContribution)} | ${s.attempts} |`,
    ),
    "",
    "## 限制",
    "",
    ...report.limitations.map((l) => `- ${l}`),
    "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = historyReuseReport();
  const path = fileURLToPath(new URL("./reports/history-reuse.json", import.meta.url));
  mkdirSync(new URL("./reports/", import.meta.url), { recursive: true });
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
  writeFileSync(new URL("./history-reuse.md", import.meta.url), renderHistory(report));
  console.log(
    JSON.stringify(
      report.summary.filter((s) => s.candidate === "warmCore"),
      null,
      2,
    ),
  );
}
