import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadTraceSimulationWorld,
  type SimulationWorld,
  simulateTraceWorld,
} from "./trace-driven-simulation";

export function validationGrowth(seed: number, family: string, length: number) {
  let state = seed >>> 0;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  return Array.from({ length: length - 1 }, (_, i) => {
    const slow = family === "slow-jitter" || (family === "fast-then-slow-jitter" && i >= 240);
    return (slow ? 2000 : 12000) + Math.floor(random() * (slow ? 6001 : 12001));
  });
}

export function compareRatioCycle(world: SimulationWorld) {
  const fixed = simulateTraceWorld(world, "fixed60"),
    candidate = simulateTraceWorld(world, "ratio-cycle");
  const fixed50 = simulateTraceWorld(world, "fixed50");
  const histogram: Record<string, number> = {};
  for (const d of candidate.cycleDecisions ?? []) {
    if (d.cost !== null) histogram[String(d.boundary)] = (histogram[String(d.boundary)] ?? 0) + 1;
  }
  const compact = (r: typeof fixed) => ({
    totalCost: r.totalCost,
    ordinaryCost: r.ordinaryCost,
    summaryCost: r.summaryCost,
    summaries: r.summaries,
    overshoots: r.forceBoundaryOvershoots,
    actions: r.actions,
    ordinaryCalls: r.ordinaryCalls,
    offeredGrowth: r.offeredGrowth,
  });
  return {
    fixed: compact(fixed),
    fixed50: compact(fixed50),
    candidate: compact(candidate),
    saving: 1 - candidate.totalCost / fixed.totalCost,
    savingVsFixed50: 1 - candidate.totalCost / fixed50.totalCost,
    eligible: candidate.forceBoundaryOvershoots === 0 && fixed.forceBoundaryOvershoots === 0,
    growthFingerprint: createHash("sha256").update(JSON.stringify(world.growth)).digest("hex"),
    boundaryHistogram: histogram,
    decisionsUsingPrior:
      candidate.cycleDecisions?.filter((d) => d.source === "retention-prior").length ?? 0,
    decisionsUsingObservations:
      candidate.cycleDecisions?.filter((d) => d.source === "observed-retention").length ?? 0,
  };
}

export function validateRatioCycle(source: SimulationWorld) {
  const rows = [];
  for (const seed of [9173, 28711, 64013])
    for (const family of ["steady-jitter", "slow-jitter", "fast-then-slow-jitter"]) {
      const growth = validationGrowth(seed, family, 720);
      for (const calls of [360, 720])
        for (const retentionRatio of [0.06, 0.14, 0.24]) {
          rows.push({
            seed,
            family,
            calls,
            retentionRatio,
            ...compareRatioCycle({
              ...source,
              initialContext: 100000,
              initialPrompt: 93824,
              growth: growth.slice(0, calls - 1),
              retentionRatio,
            }),
          });
        }
    }
  return rows;
}

export function renderRatioValidation(report: {
  rows: ReturnType<typeof validateRatioCycle>;
  development?: ReturnType<typeof compareRatioCycle>;
  tails?: ReturnType<typeof validateRatioCycle>;
}) {
  const lines = [
    "# 简单保留率周期候选：新合成轨迹验证",
    "",
    "零付费；研究候选，不接管 Pi。先定义候选与计划，再生成三种子、三类增长、两个长度、三种实际保留率的 54 组轨迹；未根据本轮输赢调整参数。360/720 调用共享同一种子前缀，不能当作独立样本。阶段切换固定在第 240 个增长项，不由短轨迹的结束位置决定。",
    "",
    "候选使用 10% 先验与此前成功摘要的保留率，以及此前增长的 EMA；不读取未来增长、实际保留率或任务终点。固定 60% 与候选共用费用模型。摘要费用先验和世界仍共用完整开发反馈，未检验费用冷启动误差；实际保留率与候选先验不同。无缓存首请求后保持暖缓存，摘要后重建。未测任务质量、真实调用波动或时延。",
    "",
    "|负载|调用数|组数|胜/平/负|平均费用变化|最差费用变化|不合格组数|",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const family of ["steady-jitter", "slow-jitter", "fast-then-slow-jitter"])
    for (const calls of [360, 720]) {
      const rows = report.rows.filter((r) => r.family === family && r.calls === calls),
        valid = rows.filter((r) => r.eligible);
      const wins = valid.filter((r) => r.saving > 1e-9).length,
        losses = valid.filter((r) => r.saving < -1e-9).length;
      lines.push(
        `|${family}|${calls}|${rows.length}|${wins}/${valid.length - wins - losses}/${losses}|${((-100 * valid.reduce((s, r) => s + r.saving, 0)) / valid.length).toFixed(2)}%|${(-100 * Math.min(...valid.map((r) => r.saving))).toFixed(2)}%|${rows.length - valid.length}|`,
      );
    }
  lines.push(
    "",
    "费用变化为 (候选费用 / 固定60%费用 − 1)，负值表示节省。只在双方均未超过70%请求前边界的行计算胜负；无效行仍保留全部费用。组均值不是统计置信度，也不能推广为多数真实任务收益。逐组正负结果、所有摘要位置、先验/观察决策次数与边界直方图见 JSON。",
    "",
    `固定50%诊断：主矩阵中 ${report.rows.filter((r) => Math.abs(r.savingVsFixed50) < 1e-9).length}/${report.rows.length} 组与固定50%费用相同。这批输入中周期选择可能退化成某个固定阈值，不能把胜过60%称为动态选择本身的优势。`,
    ...(report.development
      ? [
          "",
          `旧开发序列：固定60% USD ${report.development.fixed.totalCost.toFixed(6)}，候选 USD ${report.development.candidate.totalCost.toFixed(6)}，费用变化 ${(-100 * report.development.saving).toFixed(3)}%。`,
        ]
      : []),
    ...(report.tails
      ? [
          "",
          `补充短尾诊断（不用于调参、独立列账）：双方各自最后摘要后0/1/5个后续调用的 ${report.tails.length} 组中，候选胜 ${report.tails.filter((r) => r.eligible && r.saving > 1e-9).length}、平 ${report.tails.filter((r) => r.eligible && Math.abs(r.saving) <= 1e-9).length}、负 ${report.tails.filter((r) => r.eligible && r.saving < -1e-9).length}，最差费用变化 ${(-100 * Math.min(...report.tails.map((r) => r.saving))).toFixed(2)}%。这些结束点依赖双方动作，且可重复，属于敏感性诊断。`,
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
  const rows = validateRatioCycle(loaded.world);
  const tails = rows.flatMap((r) =>
    ["fixed", "candidate"].flatMap((basis) => {
      const last = (basis === "fixed" ? r.fixed : r.candidate).actions.at(-1)?.step;
      if (last === undefined) return [];
      return [last + 1, last + 2, last + 6]
        .filter((calls) => calls <= r.calls)
        .map((calls) => ({
          tailBasis: basis,
          seed: r.seed,
          family: r.family,
          calls,
          retentionRatio: r.retentionRatio,
          ...compareRatioCycle({
            ...loaded.world,
            initialContext: 100000,
            initialPrompt: 93824,
            growth: validationGrowth(r.seed, r.family, 720).slice(0, calls - 1),
            retentionRatio: r.retentionRatio,
          }),
        }));
    }),
  );
  const report = {
    runner: "foldpoint.ratio-cycle-validation.v1",
    paidCalls: 0,
    sourceHashes: Object.fromEntries(
      [
        "tools/ratio-cycle-choice.ts",
        "tools/trace-driven-simulation.ts",
        "tools/ratio-cycle-validation.ts",
        "benchmarks/ratio-cycle-validation-plan.json",
      ].map((p) => [p, fingerprint(p)]),
    ),
    billingSources: {
      summary: loaded.summaryTraceSha256,
      feedback: loaded.feedbackSha256,
      reference: loaded.referenceSha256,
    },
    assumptions: {
      summaryInputRate: loaded.inputRate,
      summaryOutput: loaded.output,
      ordinaryOutput: 300,
      qualityMeasured: false,
    },
    rows,
    development: compareRatioCycle(loaded.world),
    tails,
  };
  writeFileSync(
    "benchmarks/reports/ratio-cycle-validation.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync("benchmarks/ratio-cycle-validation.md", renderRatioValidation(report));
  process.stdout.write(renderRatioValidation(report));
}
