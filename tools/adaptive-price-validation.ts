import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { simulateRetentionWorld } from "./adaptive-retention-validation";
import { priceSensitivityWorld, sensitivityPlan } from "./ratio-price-sensitivity";
import type { SizeModel } from "./retained-size-choice";
import { loadTraceSimulationWorld, type SimulationWorld } from "./trace-driven-simulation";

export const retentionFamilies = ["ratio", "absolute", "affine", "drift"] as const;
export type RetentionFamily = (typeof retentionFamilies)[number];
export function actualRetainedModel(family: RetentionFamily, step: number): SizeModel {
  switch (family) {
    case "ratio":
      return { slope: 0.14, intercept: 0 };
    case "absolute":
      return { slope: 0, intercept: 24000 };
    case "affine":
      return { slope: 0.06, intercept: 18000 };
    case "drift":
      return step < 720 ? { slope: 0, intercept: 24000 } : { slope: 0.14, intercept: 0 };
  }
}

export function adaptivePriceCell(
  source: SimulationWorld,
  family: RetentionFamily,
  ratio: number,
  outputMultiplier: number,
  summaryRateMultiplier: number,
  growth: number,
  calls: number,
) {
  const world = priceSensitivityWorld(
    source,
    ratio,
    outputMultiplier,
    summaryRateMultiplier,
    growth,
    calls,
  );
  const model = (step: number) => actualRetainedModel(family, step);
  const runs = {
    adaptive: simulateRetentionWorld(world, model, "adaptive"),
    ratio: simulateRetentionWorld(world, model, "ratio"),
    fixed50: simulateRetentionWorld(world, model, "fixed50"),
    fixed60: simulateRetentionWorld(world, model, "fixed60"),
  };
  const compact = (r: typeof runs.adaptive) => ({
    ordinaryCost: r.ordinaryCost,
    summaryCost: r.summaryCost,
    totalCost: r.totalCost,
    summaries: r.summaries,
    overshoots: r.overshoots,
    actions: r.actions,
  });
  return {
    family,
    cacheRatio: ratio,
    outputMultiplier,
    summaryRateMultiplier,
    growth,
    calls,
    growthFingerprint: createHash("sha256").update(JSON.stringify(world.growth)).digest("hex"),
    adaptive: {
      ...compact(runs.adaptive),
      models: runs.adaptive.models,
      meanOwnTriggerPredictionError: runs.adaptive.predictions.length
        ? runs.adaptive.predictions.reduce((s, p) => s + Math.abs(p.predicted / p.actual - 1), 0) /
          runs.adaptive.predictions.length
        : null,
    },
    oldRatio: compact(runs.ratio),
    fixed50: compact(runs.fixed50),
    fixed60: compact(runs.fixed60),
    changeVsOldRatio: runs.adaptive.totalCost / runs.ratio.totalCost - 1,
    changeVs50: runs.adaptive.totalCost / runs.fixed50.totalCost - 1,
    changeVs60: runs.adaptive.totalCost / runs.fixed60.totalCost - 1,
    actionChanged: JSON.stringify(runs.adaptive.actions) !== JSON.stringify(runs.ratio.actions),
    eligible: Object.values(runs).every((r) => r.overshoots === 0),
  };
}

export function runAdaptivePrices(source: SimulationWorld) {
  return retentionFamilies.flatMap((family) =>
    sensitivityPlan.ratios.flatMap((ratio) =>
      sensitivityPlan.outputs.flatMap((output) =>
        sensitivityPlan.summaryRates.flatMap((rate) =>
          sensitivityPlan.growth.flatMap((growth) =>
            sensitivityPlan.lengths.map((calls) =>
              adaptivePriceCell(source, family, ratio, output, rate, growth, calls),
            ),
          ),
        ),
      ),
    ),
  );
}

export function renderAdaptivePrices(r: { rows: ReturnType<typeof runAdaptivePrices> }) {
  const lines = [
    "# 新长度估计器的完整价格对照",
    "",
    "零付费，冻结上一轮算法参数。复用216格价格/摘要费用/增长/长度网格，乘四种预设保留规律，共864格。每格共用增长、费用和环境规律，分别运行新估计器、旧比例候选、固定50%和固定60%。实际环境规律只在动作之后计算，不能传给控制器。",
    "",
    "比例=14%；固定长度=24000；混合=18000+6%输入；漂移在第720步从固定长度变为14%比例。720/1440版本共享前缀与漂移位置。费用参数仍是世界与候选共用的先验，尚未检验费用估计误差；价格比例并非真实供应商试验。",
    "",
    "|环境保留规律|格数|比旧比例胜/平/负|动作改变格数|平均费用变化|最差变化|比50%平均变化|比60%平均变化|不合格格数|",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const family of retentionFamilies) {
    const all = r.rows.filter((x) => x.family === family),
      rows = all.filter((x) => x.eligible);
    const wins = rows.filter((x) => x.changeVsOldRatio < -1e-9).length,
      losses = rows.filter((x) => x.changeVsOldRatio > 1e-9).length;
    lines.push(
      `|${family}|${all.length}|${wins}/${rows.length - wins - losses}/${losses}|${rows.filter((x) => x.actionChanged).length}|${((100 * rows.reduce((s, x) => s + x.changeVsOldRatio, 0)) / rows.length).toFixed(3)}%|${(100 * Math.max(...rows.map((x) => x.changeVsOldRatio))).toFixed(3)}%|${((100 * rows.reduce((s, x) => s + x.changeVs50, 0)) / rows.length).toFixed(3)}%|${((100 * rows.reduce((s, x) => s + x.changeVs60, 0)) / rows.length).toFixed(3)}%|${all.length - rows.length}|`,
    );
  }
  lines.push(
    "",
    "费用变化=新候选/对照−1，负值为节省。只在四臂均未越过70%请求前边界的格子计算胜负。全部格子、费用拆分、摘要位置、模型使用次数保留在JSON。各格非独立样本，也不是用户负载分布，不能把胜率推广到真实任务。",
    "",
    "另按缓存读价分组，检查收益是否集中在特定成本区间：",
    "",
    "|缓存读价/输入价|格数|比旧比例胜/平/负|平均费用变化|最差变化|",
    "|---:|---:|---:|---:|---:|",
  );
  for (const cacheRatio of sensitivityPlan.ratios) {
    const rows = r.rows.filter((x) => x.cacheRatio === cacheRatio && x.eligible),
      wins = rows.filter((x) => x.changeVsOldRatio < -1e-9).length,
      losses = rows.filter((x) => x.changeVsOldRatio > 1e-9).length;
    lines.push(
      `|${cacheRatio}|${rows.length}|${wins}/${rows.length - wins - losses}/${losses}|${((100 * rows.reduce((s, x) => s + x.changeVsOldRatio, 0)) / rows.length).toFixed(3)}%|${(100 * Math.max(...rows.map((x) => x.changeVsOldRatio))).toFixed(3)}%|`,
    );
  }
  lines.push(
    "",
    "每个策略的预测误差按它自己的压缩时机计算，触发样本不同，不能直接当作相同检查点的精度胜负。长度预测更准、动作发生变化和费用降低是三个不同指标。没有更改生产SDK或Pi控制，也没有测试任务质量。",
    "",
  );
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const loaded = loadTraceSimulationWorld(process.argv.slice(2));
  const hash = (p: string) =>
    createHash("sha256").update(readFileSync(p, "utf8").replace(/\r\n/g, "\n")).digest("hex");
  const report = {
    runner: "foldpoint.adaptive-price-validation.v1",
    paidCalls: 0,
    sourceHashes: Object.fromEntries(
      [
        "tools/adaptive-price-validation.ts",
        "tools/adaptive-retention-validation.ts",
        "tools/adaptive-cycle-choice.ts",
        "tools/retained-size-choice.ts",
        "tools/ratio-cycle-choice.ts",
        "tools/ratio-price-sensitivity.ts",
        "tools/trace-driven-simulation.ts",
        "benchmarks/adaptive-price-validation-plan.json",
      ].map((p) => [p, hash(p)]),
    ),
    billingSources: { summary: loaded.summaryTraceSha256, feedback: loaded.feedbackSha256 },
    assumptions: {
      prices: loaded.world.prices,
      summaryInputRate: loaded.inputRate,
      summaryOutput: loaded.output,
      ordinaryOutput: loaded.world.ordinaryOutput,
    },
    rows: runAdaptivePrices(loaded.world),
  };
  writeFileSync(
    "benchmarks/reports/adaptive-price-validation.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync("benchmarks/adaptive-price-validation.md", renderAdaptivePrices(report));
  process.stdout.write(renderAdaptivePrices(report));
}
