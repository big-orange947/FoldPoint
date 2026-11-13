import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chooseAdaptiveCycle } from "./adaptive-cycle-choice";
import { chooseRatioCycle } from "./ratio-cycle-choice";
import { validationGrowth } from "./ratio-cycle-validation";
import { predictSize, RetainedSizeChoice, type SizeModel } from "./retained-size-choice";
import {
  billSimulationStep,
  loadTraceSimulationWorld,
  type SimulationWorld,
} from "./trace-driven-simulation";

export function simulateRetentionWorld(
  world: SimulationWorld,
  actualModel: (step: number) => SizeModel,
  policy: "adaptive" | "ratio" | "fixed60" | "fixed50",
) {
  const learner = new RetainedSizeChoice();
  let context = world.initialContext,
    prefix = 0,
    growth: number | undefined,
    ratio = 0.1,
    ordinary = 0,
    summary = 0,
    count = 0,
    overshoots = 0;
  const actions: number[] = [],
    models: Record<string, number> = {},
    predictions: Array<{ step: number; kind: string; predicted: number; actual: number }> = [];
  for (let step = 0; step <= world.growth.length; step++) {
    if (context > 700000) overshoots++;
    const snapshot = learner.snapshot();
    const input = {
      context,
      growth,
      retention: ratio,
      samples: count,
      prices: world.prices,
      summaryInputRate: world.summaryInputRate,
      summaryOutput: world.summaryOutput,
      offset: world.initialContext - world.initialPrompt,
    };
    const choice =
      policy === "adaptive"
        ? chooseAdaptiveCycle(input, snapshot.model)
        : policy === "ratio"
          ? chooseRatioCycle(input)
          : { action: context >= (policy === "fixed50" ? 500000 : 600000) ? "COMPACT" : "KEEP" };
    const compact = choice.action !== "KEEP";
    // The world is consulted only after the controller has chosen its action.
    const after = compact ? predictSize(actualModel(step), context) : context;
    const bill = billSimulationStep(
      { ...world, retentionRatio: after / context },
      context,
      prefix,
      step,
      compact,
    );
    if (compact) {
      predictions.push({
        step,
        kind: snapshot.kind,
        predicted: predictSize(snapshot.model, context),
        actual: after,
      });
      models[snapshot.kind] = (models[snapshot.kind] ?? 0) + 1;
      learner.observe(context, after);
      ratio = count === 0 ? after / context : 0.7 * ratio + (0.3 * after) / context;
      count++;
      actions.push(step);
      context = bill.after;
    }
    ordinary += bill.ordinaryCost;
    summary += bill.summaryCost;
    prefix = bill.prompt;
    const next = world.growth[step];
    if (next !== undefined) {
      context += next;
      growth = growth === undefined ? next : 0.8 * growth + 0.2 * next;
    }
  }
  return {
    ordinaryCost: ordinary,
    summaryCost: summary,
    totalCost: ordinary + summary,
    summaries: count,
    overshoots,
    actions,
    models,
    predictions,
  };
}

export function validateRetainedPredictions() {
  const sizes = [
    200000, 350000, 600000, 250000, 650000, 450000, 300000, 550000, 220000, 680000, 400000, 580000,
  ];
  return ["ratio", "absolute", "affine", "drift"].map((family) => {
    const learner = new RetainedSizeChoice();
    let ratio = 0.1;
    const rows = sizes.map((before, i) => {
      const model =
        family === "ratio"
          ? { slope: 0.14, intercept: 0 }
          : family === "absolute"
            ? { slope: 0, intercept: 24000 }
            : family === "affine"
              ? { slope: 0.06, intercept: 18000 }
              : i < 6
                ? { slope: 0, intercept: 24000 }
                : { slope: 0.14, intercept: 0 };
      const snapshot = learner.snapshot(),
        predicted = predictSize(snapshot.model, before),
        ratioPredicted = Math.round(before * ratio),
        actual = predictSize(model, before);
      const row = {
        before,
        actual,
        predicted,
        ratioPredicted,
        selected: snapshot.kind,
        error: Math.abs(predicted / actual - 1),
        ratioError: Math.abs(ratioPredicted / actual - 1),
      };
      learner.observe(before, actual);
      ratio = i === 0 ? actual / before : 0.7 * ratio + (0.3 * actual) / before;
      return row;
    });
    return {
      family,
      rows,
      meanError: rows.reduce((s, r) => s + r.error, 0) / rows.length,
      ratioMeanError: rows.reduce((s, r) => s + r.ratioError, 0) / rows.length,
    };
  });
}

export function validateRetentionExecution(source: SimulationWorld) {
  const rows = [];
  for (const family of ["ratio", "absolute", "affine", "drift"])
    for (const seed of [3191, 7739, 10513])
      for (const growthFamily of ["steady-jitter", "fast-then-slow-jitter"])
        for (const calls of [360, 720]) {
          const world = {
            ...source,
            initialContext: 100000,
            initialPrompt: 93824,
            growth: validationGrowth(seed, growthFamily, 720).slice(0, calls - 1),
          };
          const model = (step: number) =>
            family === "ratio"
              ? { slope: 0.14, intercept: 0 }
              : family === "absolute"
                ? { slope: 0, intercept: 24000 }
                : family === "affine"
                  ? { slope: 0.06, intercept: 18000 }
                  : step < 360
                    ? { slope: 0, intercept: 24000 }
                    : { slope: 0.14, intercept: 0 };
          const adaptive = simulateRetentionWorld(world, model, "adaptive"),
            ratio = simulateRetentionWorld(world, model, "ratio"),
            fixed60 = simulateRetentionWorld(world, model, "fixed60"),
            fixed50 = simulateRetentionWorld(world, model, "fixed50");
          rows.push({
            family,
            seed,
            growthFamily,
            calls,
            adaptive,
            ratio,
            fixed60,
            fixed50,
            costChangeVsRatio: adaptive.totalCost / ratio.totalCost - 1,
            costChangeVs60: adaptive.totalCost / fixed60.totalCost - 1,
            eligible: [adaptive, ratio, fixed60, fixed50].every((r) => r.overshoots === 0),
          });
        }
  return rows;
}

export function renderRetentionValidation(r: {
  predictions: ReturnType<typeof validateRetainedPredictions>;
  rows: ReturnType<typeof validateRetentionExecution>;
}) {
  const lines = [
    "# 压缩后长度模型选择验证",
    "",
    "零付费，研究模拟。10%冷启动先验；8条滑动观察窗口；比例、绝对量与非负线性模型按此前预测误差选择。线性模型需至少3条且输入跨度≥20%，并有至少2次历史预测误差；比较使用共同已评分样本，不把拟合本次样本的误差当预测误差。宿主估计噪声和置信度未校准。",
    "",
    "先比较长度预测（包含冷启动，四条人为规律共享一组跨尺度输入，不是独立真实任务）：",
    "",
    "|真实规律|新模型平均绝对相对误差|旧比例EMA误差|",
    "|---|---:|---:|",
  ];
  for (const x of r.predictions)
    lines.push(
      `|${x.family}|${(100 * x.meanError).toFixed(2)}%|${(100 * x.ratioMeanError).toFixed(2)}%|`,
    );
  lines.push(
    "",
    "执行矩阵：3种子×2种增长×2种长度×4种保留规律，共48组；相同种子的长短版本共享前缀，漂移固定发生在第360步。真实规律仅在动作决定后用于环境转移，不能传给控制器。摘要费用先验与世界仍共享开发数据，不测费用误差与任务质量。",
    "",
    "|真实规律|格数|比旧比例候选胜/平/负|平均费用变化|比60%平均变化|最差比旧候选变化|",
    "|---|---:|---:|---:|---:|---:|",
  );
  for (const family of ["ratio", "absolute", "affine", "drift"]) {
    const rows = r.rows.filter((x) => x.family === family && x.eligible),
      wins = rows.filter((x) => x.costChangeVsRatio < -1e-9).length,
      losses = rows.filter((x) => x.costChangeVsRatio > 1e-9).length;
    lines.push(
      `|${family}|${rows.length}|${wins}/${rows.length - wins - losses}/${losses}|${((100 * rows.reduce((s, x) => s + x.costChangeVsRatio, 0)) / rows.length).toFixed(2)}%|${((100 * rows.reduce((s, x) => s + x.costChangeVs60, 0)) / rows.length).toFixed(2)}%|${(100 * Math.max(...rows.map((x) => x.costChangeVsRatio))).toFixed(2)}%|`,
    );
  }
  lines.push(
    "",
    "费用下降不由预测误差下降自动推出。阈值可能始终落在50%的边界，即使长度模型不同也会同费；有限任务结束点仍可能导致损失。所有不合格、亏损与平局记录保留在JSON。没有改变生产SDK、Pi插件或默认值，也未证明真实节费。",
    "",
  );
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const loaded = loadTraceSimulationWorld(process.argv.slice(2));
  const hash = (p: string) =>
    createHash("sha256").update(readFileSync(p, "utf8").replace(/\r\n/g, "\n")).digest("hex");
  const report = {
    runner: "foldpoint.adaptive-retention-validation.v1",
    paidCalls: 0,
    sources: Object.fromEntries(
      [
        "tools/retained-size-choice.ts",
        "tools/adaptive-cycle-choice.ts",
        "tools/adaptive-retention-validation.ts",
      ].map((p) => [p, hash(p)]),
    ),
    summaryFeedbackSha256: loaded.feedbackSha256,
    predictions: validateRetainedPredictions(),
    rows: validateRetentionExecution(loaded.world),
  };
  writeFileSync(
    "benchmarks/reports/adaptive-retention-validation.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync("benchmarks/adaptive-retention-validation.md", renderRetentionValidation(report));
  process.stdout.write(renderRetentionValidation(report));
}
