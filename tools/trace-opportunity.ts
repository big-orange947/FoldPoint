/** Evaluator only. Endpoints and future growth never enter an online selector. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  billSimulationStep,
  loadTraceSimulationWorld,
  type SimulationWorld,
  simulateTraceWorld,
} from "./trace-driven-simulation";

const hash = (value: string) =>
  createHash("sha256").update(value.replace(/\r\n/g, "\n")).digest("hex");
export const thresholds = Array.from({ length: 21 }, (_, i) => 500000 + i * 10000);

type Branch = {
  context: number;
  prefix: number;
  ordinaryCost: number;
  summaryCost: number;
  actions: number[];
};
const total = (b: Pick<Branch, "ordinaryCost" | "summaryCost">) => b.ordinaryCost + b.summaryCost;

/** Bounded beam, not a lower bound. Exact only when no unique states were discarded. */
export function searchTimingReference(world: SimulationWorld, width = 256) {
  if (!Number.isSafeInteger(width) || width < 1) throw new Error("invalid beam width");
  // Reuse the simulator's full input validation.
  simulateTraceWorld(world, "fixed60");
  let states: Branch[] = [
    {
      context: world.initialContext,
      prefix: 0,
      ordinaryCost: 0,
      summaryCost: 0,
      actions: [],
    },
  ];
  let discardedStates = 0;
  for (let step = 0; step <= world.growth.length; step++) {
    const next = new Map<string, Branch>();
    for (const state of states) {
      if (state.context > 700000) continue;
      const choices =
        state.context < 500000 ? [false] : state.context >= 700000 ? [true] : [false, true];
      for (const compact of choices) {
        const bill = billSimulationStep(world, state.context, state.prefix, step, compact);
        const b = {
          context: bill.after + (world.growth[step] ?? 0),
          prefix: bill.prompt,
          ordinaryCost: state.ordinaryCost + bill.ordinaryCost,
          summaryCost: state.summaryCost + bill.summaryCost,
          actions: compact ? [...state.actions, step] : state.actions,
        };
        const key = `${b.context}:${b.prefix}`;
        const previous = next.get(key);
        if (!previous || total(b) < total(previous)) next.set(key, b);
      }
    }
    const sorted = [...next.values()].sort((a, b) => total(a) - total(b));
    discardedStates += Math.max(0, sorted.length - width);
    states = sorted.slice(0, width);
  }
  const best = states[0];
  return { best: best ? { ...best, totalCost: total(best) } : null, discardedStates, width };
}

export function diagnoseOpportunity(world: SimulationWorld, width = 256) {
  const fixed = simulateTraceWorld(world, "fixed60");
  const grid = thresholds.map((thresholdTokens) => {
    const run = simulateTraceWorld(world, { thresholdTokens });
    return {
      thresholdTokens,
      totalCost: run.totalCost,
      ordinaryCost: run.ordinaryCost,
      summaryCost: run.summaryCost,
      summaries: run.summaries,
      eligible: run.forceBoundaryOvershoots === 0,
      overshoots: run.forceBoundaryOvershoots,
      actions: run.actions.map((a) => a.step),
    };
  });
  const bestFixed = grid.filter((r) => r.eligible).sort((a, b) => a.totalCost - b.totalCost)[0];
  if (!bestFixed || fixed.forceBoundaryOvershoots) throw new Error("no eligible fixed baseline");
  const search = searchTimingReference(world, width);
  // Always include the best grid path: the bounded search can prune a valuable future state.
  const useSearch = search.best !== null && search.best.totalCost < bestFixed.totalCost;
  const reference =
    useSearch && search.best
      ? { source: "beam" as const, ...search.best }
      : {
          source: "fixed-grid" as const,
          totalCost: bestFixed.totalCost,
          ordinaryCost: bestFixed.ordinaryCost,
          summaryCost: bestFixed.summaryCost,
          actions: bestFixed.actions,
        };
  const supported = simulateTraceWorld(world, "supported");
  const candidate = simulateTraceWorld(world, "cold-prior");
  return {
    calls: fixed.ordinaryCalls,
    offeredGrowth: fixed.offeredGrowth,
    growthFingerprint: hash(JSON.stringify(world.growth)),
    grid,
    bestFixed,
    fixed60: {
      totalCost: fixed.totalCost,
      ordinaryCost: fixed.ordinaryCost,
      summaryCost: fixed.summaryCost,
      summaries: fixed.summaries,
    },
    supported: { totalCost: supported.totalCost, learnedChoices: supported.learnedChoices },
    candidate: {
      totalCost: candidate.totalCost,
      summaries: candidate.summaries,
      differsFromFixed60:
        JSON.stringify(candidate.actions.map((a) => a.step)) !==
        JSON.stringify(fixed.actions.map((a) => a.step)),
    },
    reference: {
      ...reference,
      discardedStates: search.discardedStates,
      width,
      globalOptimumProven: search.discardedStates === 0 && search.best !== null,
    },
    bestFixedSaving: 1 - bestFixed.totalCost / fixed.totalCost,
    referenceSaving: 1 - reference.totalCost / fixed.totalCost,
  };
}

export function runOpportunityStudy(source: SimulationWorld) {
  const low = Array.from({ length: 359 }, (_, i) =>
    Math.max(1, Math.round((source.growth[i % source.growth.length] ?? 16481) / 4)),
  );
  const workloads = [
    {
      name: "observed-segments",
      provenance: "development trace, segments concatenated",
      world: source,
      ends: [40, 80, source.growth.length + 1],
    },
    {
      name: "slow-growth",
      provenance: "hypothetical, observed deltas divided by four and repeated",
      world: { ...source, growth: low },
      ends: [120, 240, 360],
    },
    {
      name: "fast-then-slow",
      provenance: "hypothetical, first 120 deltas at observed rate then divided by four",
      world: {
        ...source,
        growth: low.map((g, i) =>
          i < 120 ? (source.growth[i % source.growth.length] ?? g * 4) : g,
        ),
      },
      ends: [120, 240, 360],
    },
  ];
  return workloads.flatMap(({ name, provenance, world, ends }) =>
    [0.05, 0.11, 0.2].flatMap((retentionRatio) => {
      const full = { ...world, retentionRatio };
      const fixed = simulateTraceWorld(full, "fixed60");
      const lastSummary = fixed.actions.at(-1)?.step;
      const endpoints = [
        ...new Set([
          ...ends,
          ...(lastSummary === undefined ? [] : [lastSummary + 1, lastSummary + 2, lastSummary + 6]),
        ]),
      ]
        .filter((n) => n > 1 && n <= full.growth.length + 1)
        .sort((a, b) => a - b);
      return endpoints.map((calls) => ({
        workload: name,
        provenance,
        retentionRatio,
        endpointRole: ends.includes(calls) ? "length-grid" : "baseline-last-summary-tail",
        ...diagnoseOpportunity({ ...full, growth: full.growth.slice(0, calls - 1) }),
      }));
    }),
  );
}

export function opportunityMarkdown(report: { rows: ReturnType<typeof runOpportunityStudy> }) {
  const lines = [
    "# 真实增长驱动的优化空间诊断",
    "",
    "零付费。扫描 50%–70%，步长 1%；60% 是主对照。金额是给定世界假设下的 USD 模拟费用，不是真实反事实账单。",
    "",
    "事后参考知道未来增长与结束位置，只供评测。宽度 256 的束搜索可能丢弃更优路径，并始终包含最佳固定阈值路径；有丢弃时不能称全局最优或成本下界。",
    "",
    "普通请求和摘要共用原模拟器的计费步骤。首次请求从无缓存前缀开始，后续缓存保持存活，摘要后重建。保留率由评测世界指定；费用使用整个开发任务的摘要反馈，存在约 21 万至 50–70 万 token 的外推。",
    "",
    "真实增长片段被拼接；慢增长和阶段变化是人为压力条件，不是独立真实任务或留出集。结束点包含固定 60% 最后一次摘要后的短尾，不能推广为所有结束位置。在线候选不接收结束点或未来增长。",
    "",
    "请求前上下文已超过 70% 的固定阈值路径标为不合格，不进入最优选择；它们的费用仍保留在 JSON。此诊断没有补造提前预测增长的安全控制。",
    "",
    "|负载|保留率|调用数|60%费用|最佳固定阈值|固定节省|事后参考节省|候选节省|学习决策次数|",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const r of report.rows)
    lines.push(
      `|${r.workload}|${(r.retentionRatio * 100).toFixed(0)}%|${r.calls}|${r.fixed60.totalCost.toFixed(6)}|${r.bestFixed.thresholdTokens / 10000}%|${(100 * r.bestFixedSaving).toFixed(2)}%|${(100 * r.referenceSaving).toFixed(2)}%|${(100 * (1 - r.candidate.totalCost / r.fixed60.totalCost)).toFixed(2)}%|${r.supported.learnedChoices}|`,
    );
  lines.push(
    "",
    "不能证明任务质量、实际时延、服务商缓存行为或真实节费。不可根据此开发诊断挑选获胜行作为发布证据。固定阈值和事后路径的选择都是事后行为，不能作为在线成绩。",
    "",
    "阅读时应分别检查完整长度与短尾，区分固定阈值改善、动态时机改善，以及当前候选是否实际参与决策。短尾的大幅事后改善利用了结束点信息，不是可兑现的在线收益。",
    "",
    "复跑（四个输入依次为增长轨迹、摘要轨迹、即时反馈、绑定报告）：",
    "",
    "```powershell",
    "npm run diagnose:trace-opportunity -- traces/pi-ledger-1m-paid-fixed-full-01-fixed60.jsonl traces/pi-ledger-floor-v2-20261023-full-01-dynamic.jsonl traces/pi-ledger-floor-v2-20261023-full-01-summary-feedback.jsonl benchmarks/reports/pi-floor-v2-20261023.json",
    "```",
    "",
  );
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const loaded = loadTraceSimulationWorld(process.argv.slice(2));
  const report = {
    runner: "foldpoint.trace-opportunity.v1",
    paidCalls: 0,
    sources: {
      growth: loaded.growthTraceSha256,
      summary: loaded.summaryTraceSha256,
      feedback: loaded.feedbackSha256,
      reference: loaded.referenceSha256,
      engine: hash(readFileSync("tools/trace-driven-simulation.ts", "utf8")),
      evaluator: hash(readFileSync("tools/trace-opportunity.ts", "utf8")),
      candidate: hash(readFileSync("tools/cold-start-candidate.ts", "utf8")),
      supported: hash(readFileSync("tools/learned-cycle-choice.ts", "utf8")),
    },
    assumptions: {
      declaredWindowTokens: 1000000,
      retentionRatios: [0.05, 0.11, 0.2],
      summaryInputRate: loaded.inputRate,
      summaryOutput: loaded.output,
      ordinaryOutput: 300,
      cache: "warm-after-first-request-reset-after-summary",
      endpoints: "three lengths plus 0/1/5 subsequent calls after baseline final summary",
      qualityMeasured: false,
      independentHoldout: false,
    },
    rows: runOpportunityStudy(loaded.world),
  };
  writeFileSync(
    "benchmarks/reports/trace-opportunity.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync("benchmarks/trace-opportunity.md", opportunityMarkdown(report));
  process.stdout.write(
    `${JSON.stringify({
      paidCalls: 0,
      cells: report.rows.length,
      gridChanged: report.rows.filter((r) => r.bestFixedSaving > 0.000001).length,
      candidateChanged: report.rows.filter((r) => r.candidate.differsFromFixed60).length,
    })}\n`,
  );
}
