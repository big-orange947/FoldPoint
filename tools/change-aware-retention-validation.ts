import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { actualRetainedModel, type runAdaptivePrices } from "./adaptive-price-validation";
import { simulateRetentionWorld } from "./adaptive-retention-validation";
import { ChangeAwareRetainedSize } from "./change-aware-retained-size";
import { priceSensitivityWorld } from "./ratio-price-sensitivity";
import { predictSize, RetainedSizeChoice } from "./retained-size-choice";
import { loadTraceSimulationWorld, type SimulationWorld } from "./trace-driven-simulation";

export function feedbackNoiseChecks() {
  const rows = [];
  for (const family of ["absolute", "ratio", "affine"])
    for (const scenario of [
      "steady-noise",
      "spike-up",
      "spike-down",
      "alternating",
      "abrupt-up",
      "abrupt-down",
    ]) {
      const learner = new ChangeAwareRetainedSize(),
        old = new RetainedSizeChoice();
      let error = 0,
        oldError = 0,
        postError = 0,
        oldPostError = 0;
      for (let i = 0; i < 120; i++) {
        const before = 500000,
          base = family === "absolute" ? 24000 : family === "ratio" ? 70000 : 48000;
        const scale =
          scenario === "steady-noise"
            ? 1 + 0.1 * Math.sin(i)
            : scenario === "alternating"
              ? 1 + (i % 2 ? 0.2 : -0.2)
              : scenario === "spike-up" && i === 60
                ? 3
                : scenario === "spike-down" && i === 60
                  ? 1 / 3
                  : scenario === "abrupt-up" && i >= 60
                    ? 3
                    : scenario === "abrupt-down" && i >= 60
                      ? 1 / 3
                      : 1;
        const after = Math.round(base * scale),
          e = Math.abs(predictSize(learner.snapshot().model, before) / after - 1),
          o = Math.abs(predictSize(old.snapshot().model, before) / after - 1);
        error += e;
        oldError += o;
        if (i >= 60) {
          postError += e;
          oldPostError += o;
        }
        learner.observe(before, after);
        old.observe(before, after);
      }
      rows.push({
        family,
        scenario,
        meanError: error / 120,
        oldMeanError: oldError / 120,
        postChangeMeanError: postError / 60,
        oldPostChangeMeanError: oldPostError / 60,
        ...learner.diagnostics(),
      });
    }
  return rows;
}

export function validateChangeAware(
  source: SimulationWorld,
  baseline: ReturnType<typeof runAdaptivePrices>,
) {
  return baseline.map((b) => {
    const world = priceSensitivityWorld(
        source,
        b.cacheRatio,
        b.outputMultiplier,
        b.summaryRateMultiplier,
        b.growth,
        b.calls,
      ),
      model = (step: number) => actualRetainedModel(b.family, step);
    const old = simulateRetentionWorld(world, model, "adaptive");
    if (
      Math.abs(old.totalCost - b.adaptive.totalCost) > 1e-10 ||
      JSON.stringify(old.actions) !== JSON.stringify(b.adaptive.actions)
    )
      throw new Error("frozen baseline mismatch");
    const learner = new ChangeAwareRetainedSize(),
      run = simulateRetentionWorld(world, model, "adaptive", learner);
    return {
      family: b.family,
      cacheRatio: b.cacheRatio,
      outputMultiplier: b.outputMultiplier,
      summaryRateMultiplier: b.summaryRateMultiplier,
      growth: b.growth,
      calls: b.calls,
      baselineCost: old.totalCost,
      candidate: {
        ordinaryCost: run.ordinaryCost,
        summaryCost: run.summaryCost,
        totalCost: run.totalCost,
        summaries: run.summaries,
        actions: run.actions,
        overshoots: run.overshoots,
      },
      costChange: run.totalCost / old.totalCost - 1,
      changeVsRatio: run.totalCost / b.oldRatio.totalCost - 1,
      changeVs60: run.totalCost / b.fixed60.totalCost - 1,
      actionChanged: JSON.stringify(run.actions) !== JSON.stringify(old.actions),
      diagnostics: learner.diagnostics(),
      eligible: b.eligible && run.overshoots === 0,
    };
  });
}

export function renderChangeAware(r: {
  rows: ReturnType<typeof validateChangeAware>;
  noise: ReturnType<typeof feedbackNoiseChecks>;
}) {
  const lines = [
    "# 保留规律突变处理验证",
    "",
    "零付费，研究路径。旧估计器仍是默认；新候选只包装旧模型选择器，不改变周期成本、边界或10%冷启动先验。至少3次观察后，连续两次同方向的对数残差超过 max(log(1.5), 过去最多8次绝对残差中位数×3) 才重置；第二次结果到达后，仅用这两次观察重建学习器和评分历史。阈值是研究假设，不是统计置信界。",
    "",
    "主矩阵复用864格假设条件，并逐格重新执行旧候选核对历史费用及动作，不能以修改基线制造收益。720/1440共享前缀，不是独立真实任务；费用先验仍与世界共用，任务质量和真实反馈噪声未测。",
    "",
    "|保留规律|格数|比旧自适应胜/平/负|平均费用变化|最差变化|发生重置格数|不合格格数|",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const family of ["ratio", "absolute", "affine", "drift"]) {
    const all = r.rows.filter((x) => x.family === family),
      rows = all.filter((x) => x.eligible),
      win = rows.filter((x) => x.costChange < -1e-9).length,
      loss = rows.filter((x) => x.costChange > 1e-9).length;
    lines.push(
      `|${family}|${all.length}|${win}/${rows.length - win - loss}/${loss}|${((100 * rows.reduce((s, x) => s + x.costChange, 0)) / rows.length).toFixed(3)}%|${(100 * Math.max(...rows.map((x) => x.costChange))).toFixed(3)}%|${all.filter((x) => x.diagnostics.resets.length > 0).length}|${all.length - rows.length}|`,
    );
  }
  lines.push(
    "",
    "额外反馈流：恒定输入50万，3种基础保留量×6种扰动，每条120次，先预测再观察。漂移在第61个样本发生；固定输入不能验证跨尺度模型识别。脉冲和正弦是合成噪声，不覆盖连续同方向异常、相关误差或缓慢漂移。",
    "",
    "|扰动|流数|总重置次数|后60次新预测误差|后60次旧预测误差|",
    "|---|---:|---:|---:|---:|",
  );
  for (const scenario of [
    "steady-noise",
    "spike-up",
    "spike-down",
    "alternating",
    "abrupt-up",
    "abrupt-down",
  ]) {
    const rows = r.noise.filter((x) => x.scenario === scenario);
    lines.push(
      `|${scenario}|${rows.length}|${rows.reduce((s, x) => s + x.resets.length, 0)}|${((100 * rows.reduce((s, x) => s + x.postChangeMeanError, 0)) / rows.length).toFixed(2)}%|${((100 * rows.reduce((s, x) => s + x.oldPostChangeMeanError, 0)) / rows.length).toFixed(2)}%|`,
    );
  }
  lines.push(
    "",
    "首次突变无法提前知道；确认机制至少要付出两次观察的适应成本。两次相关噪声仍可能误触发，渐变也可能达不到门槛。只按此有限网格报告正负结果，不宣称通用节费或已解决未知任务终点。",
    "",
  );
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const loaded = loadTraceSimulationWorld(process.argv.slice(2)),
    bytes = readFileSync("benchmarks/reports/adaptive-price-validation.json"),
    baseline = JSON.parse(bytes.toString("utf8")) as { rows: ReturnType<typeof runAdaptivePrices> };
  const hash = (p: string) =>
    createHash("sha256").update(readFileSync(p, "utf8").replace(/\r\n/g, "\n")).digest("hex");
  const report = {
    runner: "foldpoint.change-aware-retention.v1",
    paidCalls: 0,
    baselineSha256: createHash("sha256").update(bytes).digest("hex"),
    sources: Object.fromEntries(
      [
        "tools/change-aware-retained-size.ts",
        "tools/change-aware-retention-validation.ts",
        "tools/retained-size-choice.ts",
        "tools/adaptive-cycle-choice.ts",
        "tools/adaptive-retention-validation.ts",
        "benchmarks/change-aware-retention-plan.json",
      ].map((p) => [p, hash(p)]),
    ),
    noise: feedbackNoiseChecks(),
    rows: validateChangeAware(loaded.world, baseline.rows),
  };
  writeFileSync(
    "benchmarks/reports/change-aware-retention.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync("benchmarks/change-aware-retention.md", renderChangeAware(report));
  process.stdout.write(renderChangeAware(report));
}
