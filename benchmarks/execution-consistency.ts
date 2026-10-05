/** Seen-case causal ablation, not another held-out test. Fixed 60% primary comparator. */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compactorCases } from "./compactor-model";
import { DURATION_PRIOR } from "./duration-mixture";
import { createRawFixedThresholdStrategy } from "./fixed-threshold";
import { PRICE_PROFILES } from "./provider-ratios";
import { type CompactorPredictionAudit, createFoldPointStrategy, runSession } from "./simulator";

export function executionConsistencyReport() {
  const rows = PRICE_PROFILES.flatMap((profile) =>
    compactorCases().map((base) => {
      const scenario = { ...base, pricing: profile.pricing };
      const errors: Record<
        string,
        Record<
          string,
          {
            samples: number;
            afterSigned: number;
            afterAbsolute: number;
            costSigned: number;
            costAbsolute: number;
          }
        >
      > = {};
      const gates: Record<string, { cooldown: number; reclaim: number }> = {};
      const audit = (name: string) => (a: CompactorPredictionAudit) => {
        errors[name] ??= {};
        const group = errors[name];
        group[a.phase] ??= {
          samples: 0,
          afterSigned: 0,
          afterAbsolute: 0,
          costSigned: 0,
          costAbsolute: 0,
        };
        const cell = group[a.phase];
        if (!cell) throw new Error("Missing calibration cell");
        const after = (a.predictedAfter - a.actualAfter) / Math.max(1, a.actualAfter);
        const cost = (a.predictedCost - a.actualCost) / Math.max(1e-12, a.actualCost);
        cell.samples++;
        cell.afterSigned += after;
        cell.afterAbsolute += Math.abs(after);
        cell.costSigned += cost;
        cell.costAbsolute += Math.abs(cost);
      };
      const strategy = (name: string, consistent: boolean) =>
        createFoldPointStrategy(scenario, {
          learnedCompactorTokens: true,
          enforceForecastExecutionGates: consistent,
          omitRequestCacheEvidence: true,
          verifiedAppendOnlyPrefix: true,
          defaults: { compactOutputRatio: 0.002 },
          onCompactorPrediction: audit(name),
          onSurvivalEstimate: (e) => {
            gates[name] ??= { cooldown: 0, reclaim: 0 };
            const count = gates[name];
            if (e.eligible) {
              count.cooldown += e.forecastCooldownBlocks;
              count.reclaim += e.forecastReclaimBlocks;
            }
          },
          runtimeSurvival: {
            continuationProbability: 0.95,
            maxImmediateLossRatio: 1,
            maxCalls: 256,
            rolloutMode: "renewal",
            endingRiskMode: "survival-weighted",
            endingLossBudgetRatio: 1,
            savingMarginBasis: "timing",
            durationModel: { completedCalls: 0, components: DURATION_PRIOR },
          },
        });
      const strategies = {
        fixed60: createRawFixedThresholdStrategy(0.6),
        previous: strategy("previous", false),
        feasible: strategy("feasible", true),
      };
      const arms = Object.fromEntries(
        Object.entries(strategies).map(([name, s]) => {
          const run = runSession(scenario, s);
          return [
            name,
            {
              cost: run.metrics.totalSimulatedCost,
              attempts: run.metrics.compactionAttemptCount,
              overflow: run.metrics.overflowCount,
              fingerprint: run.metrics.growthSequenceFingerprint,
              compactionSteps: run.compactions.map((c) => c.step),
            },
          ];
        }),
      );
      return {
        id: base.id,
        profile: profile.id,
        suite: base.id.startsWith("heldout-floor-")
          ? "seen-floor"
          : base.id.startsWith("heldout-margin-")
            ? "seen-proportional"
            : "seen-model",
        arms,
        errors,
        gates,
      };
    }),
  );
  const summary = PRICE_PROFILES.flatMap((profile) =>
    ["seen-floor", "seen-proportional", "seen-model"].flatMap((suite) =>
      ["previous", "feasible"].map((candidate) => {
        const selected = rows.filter((r) => r.profile === profile.id && r.suite === suite);
        const delta = selected.map(
          (r) => (r.arms[candidate]?.cost ?? NaN) / (r.arms.fixed60?.cost ?? NaN) - 1,
        );
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
          attempts: selected.reduce((s, r) => s + (r.arms[candidate]?.attempts ?? 0), 0),
        };
      }),
    ),
  );
  const calibration = ["previous", "feasible"].flatMap((candidate) =>
    ["cold-start", "low-span", "interpolation", "extrapolation"].map((phase) => {
      const cells = rows.map((r) => r.errors[candidate]?.[phase]).filter((c) => c !== undefined);
      const samples = cells.reduce((s, c) => s + c.samples, 0);
      const mean = (key: "afterSigned" | "afterAbsolute" | "costSigned" | "costAbsolute") =>
        samples ? cells.reduce((s, c) => s + c[key], 0) / samples : null;
      return {
        candidate,
        phase,
        samples,
        afterSigned: mean("afterSigned"),
        afterAbsolute: mean("afterAbsolute"),
        costSigned: mean("costSigned"),
        costAbsolute: mean("costAbsolute"),
      };
    }),
  );
  return {
    kind: "foldpoint.execution-consistency.v1",
    comparator: "fixed60",
    paidCalls: 0,
    rows,
    summary,
    calibration,
    limitations: [
      "全部 24 个组合已经看过，只作执行一致性归因回归，不称盲测；价格、先验、拟合与余量均未重调。",
      "未来经济压缩现在应用宿主冷却、最小回收量/比例与 soft-window；安全 FORCE 不受这些经济门阻拦。",
      "预测中的最小回收使用预测压缩结果；真实分支仍依赖核心已学习比例的门，因此不是完整递归执行策略。",
      "成功压缩才有保留长度误差；误差表受策略选择影响，不能证明所有 KEEP 点的压缩结果准确。",
      "误差按实际压缩后的反馈结算，不提前反馈诊断结果；费用相对误差与长度相对误差逐样本平均。",
      "预测阻拦数是各次 eligible 决策选中 NOW 路径里的假设事件，重复预测会重复计数，不是实际否决次数。",
      "八组冻结价格含一组等比例缩放控制；合成任务和误差不能证明真实 Pi 的任务质量或供应商缓存语义。",
      "不读取 key、不进行付费调用、不切换核心或 Pi 默认策略，保留所有旧结果。",
    ],
  };
}

export function renderExecution(report: ReturnType<typeof executionConsistencyReport>) {
  const percent = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(2)}%`);
  return [
    "# 执行一致性与预测误差（固定 60% 对照）",
    "",
    "负数为省钱，所有案例为已见回归场景。",
    "",
    "| 价格 | 分组 | 策略 | 胜/负/平 | 平均变化 | 最差变化 | 压缩次数 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.summary.map(
      (s) =>
        `| ${s.profile} | ${s.suite} | ${s.candidate} | ${s.wins}/${s.losses}/${s.ties} | ${percent(s.mean)} | ${percent(s.worst)} | ${s.attempts} |`,
    ),
    "",
    "## 成功压缩的预测误差",
    "",
    "有符号正数为高估；绝对误差不是任务质量指标。",
    "",
    "| 策略 | 阶段 | 样本 | 长度有符号 | 长度绝对 | 费用有符号 | 费用绝对 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.calibration.map(
      (c) =>
        `| ${c.candidate} | ${c.phase} | ${c.samples} | ${percent(c.afterSigned)} | ${percent(c.afterAbsolute)} | ${percent(c.costSigned)} | ${percent(c.costAbsolute)} |`,
    ),
    "",
    "## 限制",
    "",
    ...report.limitations.map((l) => `- ${l}`),
    "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = executionConsistencyReport();
  mkdirSync(new URL("./reports/", import.meta.url), { recursive: true });
  writeFileSync(
    new URL("./reports/execution-consistency.json", import.meta.url),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("../node_modules/@biomejs/biome/bin/biome", import.meta.url)),
      "format",
      "--write",
      fileURLToPath(new URL("./reports/execution-consistency.json", import.meta.url)),
    ],
    { stdio: "pipe" },
  );
  writeFileSync(new URL("./execution-consistency.md", import.meta.url), renderExecution(report));
  console.log(
    JSON.stringify(
      {
        calibration: report.calibration,
        summary: report.summary.filter((s) => s.candidate === "feasible"),
      },
      null,
      2,
    ),
  );
}
