import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveUnitPrices } from "../src/pricing";
import { chooseRatioCycle, ratioCycleCost } from "./ratio-cycle-choice";
import {
  loadTraceSimulationWorld,
  type SimulationWorld,
  simulateTraceWorld,
} from "./trace-driven-simulation";

export const sensitivityPlan = {
  ratios: [0.002, 0.02, 0.1, 0.5],
  outputs: [1, 8, 32],
  summaryRates: [0.5, 1, 2],
  growth: [4000, 16000, 32000],
  lengths: [720, 1440],
};

export function priceSensitivityWorld(
  source: SimulationWorld,
  ratio: number,
  outputMultiplier: number,
  summaryRateMultiplier: number,
  growth: number,
  calls: number,
) {
  const world: SimulationWorld = {
    ...source,
    initialContext: 100000,
    initialPrompt: 93824,
    growth: Array(calls - 1).fill(growth),
    retentionRatio: 0.14,
    prices: resolveUnitPrices({
      inputPerMillion: source.prices.inputPerToken * 1e6,
      outputPerMillion: source.prices.outputPerToken * 1e6,
      cacheReadPerMillion: source.prices.inputPerToken * ratio * 1e6,
    }),
    summaryInputRate: source.summaryInputRate * summaryRateMultiplier,
    summaryOutput: source.summaryOutput * outputMultiplier,
  };
  return world;
}

export function priceSensitivityCell(
  source: SimulationWorld,
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
  const fixed60 = simulateTraceWorld(world, "fixed60"),
    fixed50 = simulateTraceWorld(world, "fixed50"),
    candidate = simulateTraceWorld(world, "ratio-cycle");
  const grid = Array.from({ length: 21 }, (_, i) => {
    const thresholdTokens = 500000 + i * 10000,
      run = simulateTraceWorld(world, { thresholdTokens });
    return { thresholdTokens, totalCost: run.totalCost, overshoots: run.forceBoundaryOvershoots };
  });
  const best = grid.filter((r) => r.overshoots === 0).sort((a, b) => a.totalCost - b.totalCost)[0];
  if (!best) throw new Error("no eligible comparator");
  const histogram: Record<string, number> = {};
  for (const d of candidate.cycleDecisions ?? [])
    if (d.cost !== null) histogram[d.boundary] = (histogram[d.boundary] ?? 0) + 1;
  // Known constant retention/growth only for a separate long-run model diagnostic.
  const prediction = chooseRatioCycle({
    context: 550000,
    growth,
    retention: 0.14,
    samples: 1,
    prices: world.prices,
    summaryInputRate: world.summaryInputRate,
    summaryOutput: world.summaryOutput,
    offset: 6176,
  });
  const bill = (r: typeof candidate) => ({
    totalCost: r.totalCost,
    ordinaryCost: r.ordinaryCost,
    summaryCost: r.summaryCost,
    summaries: r.summaries,
    overshoots: r.forceBoundaryOvershoots,
  });
  const atHindsight = ratioCycleCost(
    {
      context: 550000,
      growth,
      retention: 0.14,
      samples: 1,
      prices: world.prices,
      summaryInputRate: world.summaryInputRate,
      summaryOutput: world.summaryOutput,
      offset: 6176,
    },
    best.thresholdTokens,
  );
  return {
    ratio,
    outputMultiplier,
    summaryRateMultiplier,
    growth,
    calls,
    fixed60: bill(fixed60),
    fixed50: bill(fixed50),
    candidate: bill(candidate),
    grid,
    bestFixed: best,
    savingVs60: 1 - candidate.totalCost / fixed60.totalCost,
    savingVs50: 1 - candidate.totalCost / fixed50.totalCost,
    gapVsHindsightFixed: candidate.totalCost / best.totalCost - 1,
    eligible: candidate.forceBoundaryOvershoots === 0 && fixed60.forceBoundaryOvershoots === 0,
    selectedBoundaries: histogram,
    predictedBoundaryWithKnownRetention: prediction.boundary,
    predictedLongRunCostExcludingOrdinaryOutput: prediction.cost,
    predictedLongRunCostAtFiniteHindsightBoundary: Number.isFinite(atHindsight)
      ? atHindsight
      : null,
    realizedFiniteCostExcludingOrdinaryOutput:
      (candidate.totalCost - calls * world.ordinaryOutput * world.prices.outputPerToken) / calls,
  };
}

export function runPriceSensitivity(source: SimulationWorld) {
  return sensitivityPlan.ratios.flatMap((ratio) =>
    sensitivityPlan.outputs.flatMap((output) =>
      sensitivityPlan.summaryRates.flatMap((rate) =>
        sensitivityPlan.growth.flatMap((growth) =>
          sensitivityPlan.lengths.map((calls) =>
            priceSensitivityCell(source, ratio, output, rate, growth, calls),
          ),
        ),
      ),
    ),
  );
}

export function endpointDiagnostic(
  source: SimulationWorld,
  rows: ReturnType<typeof runPriceSensitivity>,
) {
  const worst = [...rows]
    .filter((r) => r.eligible)
    .sort((a, b) => b.gapVsHindsightFixed - a.gapVsHindsightFixed)[0];
  if (!worst) throw new Error("missing diagnostic source");
  return {
    selection: "post-hoc largest finite gap, diagnostic only",
    ratio: worst.ratio,
    outputMultiplier: worst.outputMultiplier,
    summaryRateMultiplier: worst.summaryRateMultiplier,
    growth: worst.growth,
    referenceBoundary: worst.bestFixed.thresholdTokens,
    rows: [720, 1440, 14400].map((calls) => {
      const world = priceSensitivityWorld(
        source,
        worst.ratio,
        worst.outputMultiplier,
        worst.summaryRateMultiplier,
        worst.growth,
        calls,
      );
      const candidate = simulateTraceWorld(world, "ratio-cycle"),
        reference = simulateTraceWorld(world, { thresholdTokens: worst.bestFixed.thresholdTokens });
      return {
        calls,
        candidateCost: candidate.totalCost,
        referenceCost: reference.totalCost,
        costChange: candidate.totalCost / reference.totalCost - 1,
        candidateOvershoots: candidate.forceBoundaryOvershoots,
        referenceOvershoots: reference.forceBoundaryOvershoots,
      };
    }),
  };
}

export function renderPriceSensitivity(report: {
  rows: ReturnType<typeof runPriceSensitivity>;
  endpointCheck?: ReturnType<typeof endpointDiagnostic>;
}) {
  const lines = [
    "# 周期候选的价格与摘要成本敏感性",
    "",
    "零付费。固定上一轮候选参数，改变假设的缓存读价/输入价、摘要输出量、摘要输入有效单价和每轮增长。不是 Claude、DeepSeek 等服务商的实测，也不模拟不同 tokenizer、缓存制度或压缩器质量。",
    "",
    "每格同时运行固定50%、固定60%、候选及50%–70%的事后固定阈值扫描。720与1440调用共享前缀，所有分支使用相同增长。首次请求没有前缀缓存，后续保持暖缓存，摘要后重建。实际保留率14%，候选从10%先验逐步学习；摘要费用参数同时提供给世界与候选，未验证费用估计误差。",
    "",
    "|缓存读价/输入价|摘要输出倍数|格数|比60%胜/平/负|比50%胜/平/负|相对60%平均变化|最差变化|不合格格数|",
    "|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const ratio of sensitivityPlan.ratios)
    for (const output of sensitivityPlan.outputs) {
      const all = report.rows.filter((r) => r.ratio === ratio && r.outputMultiplier === output),
        rows = all.filter((r) => r.eligible);
      const counts = (key: "savingVs60" | "savingVs50") =>
        [
          rows.filter((r) => r[key] > 1e-9).length,
          rows.filter((r) => Math.abs(r[key]) <= 1e-9).length,
          rows.filter((r) => r[key] < -1e-9).length,
        ].join("/");
      lines.push(
        `|${ratio}|${output}|${all.length}|${counts("savingVs60")}|${counts("savingVs50")}|${((-100 * rows.reduce((s, r) => s + r.savingVs60, 0)) / rows.length).toFixed(2)}%|${(-100 * Math.min(...rows.map((r) => r.savingVs60))).toFixed(2)}%|${all.length - rows.length}|`,
      );
    }
  const hist: Record<string, number> = {};
  for (const r of report.rows)
    for (const [b, n] of Object.entries(r.selectedBoundaries)) hist[b] = (hist[b] ?? 0) + n;
  lines.push(
    "",
    `所有有费用估算的决策所选阈值（token:次数）：${JSON.stringify(hist)}。`,
    "",
    "费用变化为候选/对照−1，负值为节省。不合格行保留完整账单但不计胜负。事后最佳固定阈值使用完整终点；它是诊断参照，不是在线成绩。已知保留率的长期预测与有限任务单次费用分别记录，两者之差包括启动、结束和安全边界效应，不能直接叫预测误差。",
    "",
    "这批成本比是人为敏感性网格，不是用户分布；各格权重、长任务长度、缓存存活和保留率假设都会影响汇总。即使全胜，也不证明真实任务质量或发布级节费优势。",
    ...(report.endpointCheck
      ? [
          "",
          `另取主矩阵中事后固定阈值差距最大的格子（事后选择，仅诊断），固定参照阈值 ${report.endpointCheck.referenceBoundary / 10000}%，延长同一增长序列：`,
          "",
          "|调用数|候选费用|固定参照费用|候选费用变化|",
          "|---:|---:|---:|---:|",
          ...report.endpointCheck.rows.map(
            (r) =>
              `|${r.calls}|${r.candidateCost.toFixed(6)}|${r.referenceCost.toFixed(6)}|${(r.costChange * 100).toFixed(2)}%|`,
          ),
          "",
          "这是同一条合成序列的长度检查，不是新增独立胜场。有限任务与长期平均费用的目标可能不同；长期更便宜不保证720或1440次调用时更便宜。",
        ]
      : []),
    "",
  );
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const loaded = loadTraceSimulationWorld(process.argv.slice(2));
  const fingerprint = (p: string) =>
    createHash("sha256").update(readFileSync(p, "utf8").replace(/\r\n/g, "\n")).digest("hex");
  const rows = runPriceSensitivity(loaded.world);
  const report = {
    runner: "foldpoint.ratio-price-sensitivity.v1",
    paidCalls: 0,
    sourceHashes: Object.fromEntries(
      [
        "tools/ratio-price-sensitivity.ts",
        "tools/ratio-cycle-choice.ts",
        "tools/trace-driven-simulation.ts",
        "benchmarks/ratio-price-sensitivity-plan.json",
      ].map((p) => [p, fingerprint(p)]),
    ),
    billingSources: { summary: loaded.summaryTraceSha256, feedback: loaded.feedbackSha256 },
    billingAssumptions: {
      prices: loaded.world.prices,
      summaryInputRate: loaded.inputRate,
      summaryOutput: loaded.output,
      ordinaryOutput: loaded.world.ordinaryOutput,
    },
    rows,
    endpointCheck: endpointDiagnostic(loaded.world, rows),
  };
  writeFileSync(
    "benchmarks/reports/ratio-price-sensitivity.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync("benchmarks/ratio-price-sensitivity.md", renderPriceSensitivity(report));
  process.stdout.write(renderPriceSensitivity(report));
}
