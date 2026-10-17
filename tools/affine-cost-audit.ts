/** Frozen-result audit. Intervention schedules are evaluator-only, never a production policy. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CompactionEvent,
  createRawFixedThresholdStrategy,
  type Strategy,
} from "../benchmarks/fixed-threshold";
import type { Scenario } from "../benchmarks/scenarios";
import { resolveUnitPrices } from "../src/index";
import {
  affineCostCases,
  assertAffineCostSources,
  type buildAffineCostReport,
  costLedger,
  createApproximateCostStrategy,
  hostFeedback,
} from "./affine-cost";
import { sourceHash } from "./affine-holdout";
import { ApproximateRetentionTracker } from "./approximate-feedback";
import { UncertainAffineFeedback } from "./uncertain-affine-feedback";

const ARMS = ["fixed60", "approximateEma", "uncertainAffine"] as const;
type Arm = (typeof ARMS)[number];
type Frozen = ReturnType<typeof buildAffineCostReport>;
type Row = Frozen["rows"][number];
type Case = ReturnType<typeof affineCostCases>[number];
export class AuditInputOverflow extends Error {}
const close = (a: number, b: number) => {
  if (Math.abs(a - b) > 1e-8) throw new Error(`Audit arithmetic mismatch ${a} / ${b}`);
};
export function selectAuditRows(rows: Row[]) {
  const main = rows
    .filter((r) => r.profile === "deepseek-flash-peak" && r.suite === "main")
    .sort(
      (a, b) =>
        b.arms.uncertainAffine.cost / b.arms.fixed60.cost -
        a.arms.uncertainAffine.cost / a.arms.fixed60.cost,
    );
  const failure = rows.find((r) => r.profile === "deepseek-flash-peak" && r.suite === "failure");
  if (!main[0] || !failure) throw new Error("Missing explicitly selected worst/failure row");
  return [main[0], failure];
}

export function traceArm(
  scenario: Scenario,
  arm: Arm,
  schedule?: readonly Pick<CompactionEvent, "step" | "action">[],
) {
  const built = arm === "fixed60" ? null : createApproximateCostStrategy(scenario, arm);
  const observer =
    arm === "uncertainAffine"
      ? new UncertainAffineFeedback("cost-host/v1")
      : new ApproximateRetentionTracker("cost-host/v1");
  const byStep = schedule === undefined ? null : new Map(schedule.map((e) => [e.step, e.action]));
  const base: Strategy = byStep
    ? {
        id: "frozen-evaluator-schedule",
        label: "Evaluator intervention",
        decide(r) {
          return { action: byStep.get(r.step) ?? "KEEP" };
        },
      }
    : (built?.strategy ?? createRawFixedThresholdStrategy(0.6));
  const prices = resolveUnitPrices(scenario.pricing);
  let sequence = 0,
    outputRatio = 0.002;
  const requests: {
    step: number;
    cost: number;
    read: number;
    tail: number;
    write: number;
    output: number;
  }[] = [];
  const attempts: (CompactionEvent & {
    predictedAfter: number | null;
    predictedOutput: number | null;
    predictedSummaryCost: number | null;
  })[] = [];
  const decisions: {
    step: number;
    context: number;
    action: string;
    predictedAfter: number | null;
    fitted: boolean;
  }[] = [];
  let prediction: number | null = null;
  const bill = costLedger(scenario, {
    ...base,
    decide(r) {
      if (r.contextTokens > scenario.contextWindowTokens)
        throw new AuditInputOverflow("Audit intervention exceeds input window");
      prediction =
        arm === "fixed60"
          ? null
          : (observer.predict(r.contextTokens)?.pointTokens ?? r.contextTokens * 0.1);
      const decision = base.decide(r);
      decisions.push({
        step: r.step,
        context: r.contextTokens,
        action: decision.action,
        predictedAfter: prediction,
        fitted: observer instanceof UncertainAffineFeedback && observer.snapshot().model !== null,
      });
      return decision;
    },
    onRequest(e) {
      // These selected fixtures declare a warm append-only cache, a write tariff and no prewarm.
      const read = e.cachedInputTokens * prices.cacheReadPerToken;
      const write = e.cachedInputTokens === 0 ? e.promptTokens * prices.cacheWritePerToken : 0;
      const tail =
        e.cachedInputTokens === 0
          ? 0
          : (e.promptTokens - e.cachedInputTokens) * prices.inputPerToken;
      const output = e.outputTokens * prices.outputPerToken;
      close(read + tail + write + output, e.cost);
      requests.push({ step: e.step, cost: e.cost, read, tail, write, output });
      base.onRequest?.(e);
    },
    onCompaction(e) {
      const predictedOutput = arm === "fixed60" ? null : e.beforeTokens * outputRatio;
      attempts.push({
        ...e,
        predictedAfter: prediction,
        predictedOutput,
        predictedSummaryCost:
          predictedOutput === null
            ? null
            : e.beforeTokens * prices.inputPerToken + predictedOutput * prices.outputPerToken,
      });
      close(e.beforeTokens * prices.inputPerToken + e.outputTokens * prices.outputPerToken, e.cost);
      observer.observe(hostFeedback(e, ++sequence));
      if (e.success) outputRatio += 0.25 * (e.outputTokens / e.beforeTokens - outputRatio);
      base.onCompaction?.(e);
    },
  });
  const independentMae = attempts.filter((e) => e.success && e.predictedAfter !== null);
  if (built && schedule === undefined && independentMae.length)
    close(
      independentMae.reduce((s, e) => s + Math.abs((e.predictedAfter ?? 0) - e.afterTokens), 0) /
        independentMae.length,
      built.diagnostic().summaryPredictionMae ?? -1,
    );
  return { bill, requests, attempts, decisions };
}

export function traceSlice(trace: ReturnType<typeof traceArm>, start: number, end: number) {
  const requests = trace.requests.filter((e) => e.step >= start && e.step < end);
  const attempts = trace.attempts.filter((e) => e.step >= start && e.step < end);
  const sum = (pick: (e: (typeof requests)[number]) => number) =>
    requests.reduce((s, e) => s + pick(e), 0);
  const ordinary = sum((e) => e.cost);
  const summary = attempts.reduce((s, e) => s + e.cost, 0);
  return {
    start,
    end,
    cost: ordinary + summary,
    ordinary,
    summary,
    read: sum((e) => e.read),
    tail: sum((e) => e.tail),
    write: sum((e) => e.write),
    output: sum((e) => e.output),
    attempts: attempts.length,
    failures: attempts.filter((e) => !e.success).length,
    failedSummaryCost: attempts.filter((e) => !e.success).reduce((s, e) => s + e.cost, 0),
  };
}

export function auditCostCase(c: Case, frozen: Row) {
  if (
    c.scenario.cycleBilling?.prewarmOutputTokens !== undefined ||
    c.scenario.cycleBilling?.summarySharedPrefixRatio !== undefined
  )
    throw new Error("This component audit requires uncached summaries and no prewarm");
  const traces = Object.fromEntries(ARMS.map((arm) => [arm, traceArm(c.scenario, arm)])) as Record<
    Arm,
    ReturnType<typeof traceArm>
  >;
  const intervention = Object.fromEntries(
    ARMS.map((arm) => {
      const trace = traces[arm];
      // The legacy compactions array is settlement-ordered; event callbacks above are chronological.
      if (JSON.stringify(trace.bill) !== JSON.stringify(frozen.arms[arm]))
        throw new Error("Live capture changed frozen bill");
      const replay = traceArm(c.scenario, arm, trace.attempts);
      if (JSON.stringify(replay.bill) !== JSON.stringify(trace.bill))
        throw new Error("Frozen schedule failed to reproduce bill");
      const last = trace.attempts.at(-1);
      let withoutLast: ReturnType<typeof costLedger> | null = null;
      let withoutLastStatus = "last-attempt-not-successful";
      if (last?.success) {
        try {
          withoutLast = traceArm(c.scenario, arm, trace.attempts.slice(0, -1)).bill;
          withoutLastStatus = "input-window-feasible";
        } catch (error) {
          if (!(error instanceof AuditInputOverflow)) throw error;
          withoutLastStatus = "unavailable-window-overflow";
        }
      }
      const allSuccess = traceArm(
        { ...c.scenario, compactor: { ...c.scenario.compactor, successRate: 1 } },
        arm,
        trace.attempts,
      ).bill;
      return [
        arm,
        {
          replayMatches: true,
          lastStep: last?.step ?? null,
          lastAttemptSucceeded: last?.success ?? null,
          withoutLast,
          withoutLastStatus,
          lastAttemptNetCost: withoutLast ? trace.bill.cost - withoutLast.cost : null,
          allSuccessSameSchedule: allSuccess,
          failurePathNetCost: trace.bill.cost - allSuccess.cost,
          components: traceSlice(trace, 0, c.scenario.steps),
        },
      ];
    }),
  ) as Record<
    Arm,
    {
      replayMatches: boolean;
      lastStep: number | null;
      lastAttemptSucceeded: boolean | null;
      withoutLast: ReturnType<typeof costLedger> | null;
      withoutLastStatus: string;
      lastAttemptNetCost: number | null;
      allSuccessSameSchedule: ReturnType<typeof costLedger>;
      failurePathNetCost: number;
      components: ReturnType<typeof traceSlice>;
    }
  >;
  const deltas = ["fixed60", "approximateEma"].map((against) => {
    const other = traces[against as Arm];
    const parts = [
      [0, 120],
      [120, c.scenario.steps],
    ]
      .filter(([a, b]) => (a ?? 0) < (b ?? 0))
      .map(([a, b]) => {
        const candidate = traceSlice(traces.uncertainAffine, a ?? 0, b ?? 0);
        const control = traceSlice(other, a ?? 0, b ?? 0);
        const delta = Object.fromEntries(
          ["cost", "ordinary", "summary", "read", "tail", "write", "output"].map((key) => [
            key,
            candidate[key as "cost"] - control[key as "cost"],
          ]),
        );
        close(delta.cost ?? 0, (delta.ordinary ?? 0) + (delta.summary ?? 0));
        return { start: a, end: b, candidate, control, delta };
      });
    return {
      against,
      parts,
      totalDelta: traces.uncertainAffine.bill.cost - other.bill.cost,
      failurePenaltyDifference:
        intervention.uncertainAffine.failurePathNetCost -
        intervention[against as Arm].failurePathNetCost,
      endingPenaltyDifference:
        intervention.uncertainAffine.lastAttemptNetCost !== null &&
        intervention[against as Arm].lastAttemptNetCost !== null
          ? (intervention.uncertainAffine.lastAttemptNetCost ?? 0) -
            (intervention[against as Arm].lastAttemptNetCost ?? 0)
          : null,
    };
  });
  return {
    profile: c.profile,
    fixture: c.fixture,
    suite: c.suite,
    steps: c.scenario.steps,
    traces,
    intervention,
    deltas,
  };
}

export function runAffineCostAudit() {
  assertAffineCostSources();
  const raw = readFileSync(
    new URL("../benchmarks/reports/affine-cost.json", import.meta.url),
    "utf8",
  );
  const frozen = JSON.parse(raw) as Frozen;
  for (const [path, expected] of Object.entries(frozen.sourceHashes))
    if (sourceHash(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")) !== expected)
      throw new Error(`Frozen source changed: ${path}`);
  const cases = affineCostCases();
  const rows = selectAuditRows(frozen.rows).map((r) => {
    const c = cases.find(
      (c) =>
        c.profile === r.profile &&
        c.fixture === r.fixture &&
        c.suite === r.suite &&
        c.scenario.steps === r.steps,
    );
    if (!c) throw new Error("Missing matching scenario");
    return auditCostCase(c, r);
  });
  return {
    runner: "foldpoint.affine-cost-audit.v1",
    paidCalls: 0,
    baselineCommit: "7f36924",
    frozenReportSha256: sourceHash(raw),
    auditSourceSha256: sourceHash(readFileSync(fileURLToPath(import.meta.url), "utf8")),
    selection:
      "Worst DeepSeek main by relative cost vs fixed60, plus existing DeepSeek failure sensitivity; no retuning",
    rows,
  };
}

export function renderAffineCostAudit(r: ReturnType<typeof runAffineCostAudit>) {
  const f = (n: number | null) => (n === null ? "—" : n.toFixed(6));
  return [
    "# 冻结费用轨迹归因：长任务最差分支与失败敏感性",
    "",
    "冻结7f36924的候选、控制器和场景；新增付费调用0，未调整参数。先验证事件捕获及冻结触发日程都能逐项重现旧账单，再做评测侧干预。",
    ...r.rows.flatMap((row) => [
      "",
      `## ${row.suite} / ${row.fixture} / ${row.steps}调用`,
      "",
      "| 对照 | 区间（0起始、右端不含） | 总费用差 | 普通请求差 | 摘要差 | 缓存读差 | 写入差 | 新增尾部差 |",
      "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...row.deltas.flatMap((d) =>
        d.parts.map(
          (p) =>
            `| ${d.against} | ${p.start}–${p.end} | ${f(p.delta.cost ?? 0)} | ${f(p.delta.ordinary ?? 0)} | ${f(p.delta.summary ?? 0)} | ${f(p.delta.read ?? 0)} | ${f(p.delta.write ?? 0)} | ${f(p.delta.tail ?? 0)} |`,
        ),
      ),
      "",
      "费用差均为新候选−对照；正数更贵。普通输出差在原始JSON另列，分量逐项对账。",
      "",
      "| 方法 | 摘要次数/失败次数 | 直接失败摘要费用 | 最后尝试位置 | 去掉最后成功尝试的净费用差 | 同日程全成功：失败路径净费用影响 |",
      "| --- | ---: | ---: | ---: | ---: | ---: |",
      ...ARMS.map((a) => {
        const v = row.intervention[a];
        return `| ${a} | ${v.components.attempts}/${v.components.failures} | ${f(v.components.failedSummaryCost)} | ${v.lastStep} | ${f(v.lastAttemptNetCost)} (${v.withoutLastStatus}) | ${f(v.failurePathNetCost)} |`;
      }),
      "",
      "| 对照 | 实际总费用差 | 双方最后尝试净影响之差 | 双方失败路径净影响之差 |",
      "| --- | ---: | ---: | ---: |",
      ...row.deltas.map(
        (d) =>
          `| ${d.against} | ${f(d.totalDelta)} | ${f(d.endingPenaltyDifference)} | ${f(d.failurePenaltyDifference)} |`,
      ),
    ]),
    "",
    "## 解释边界",
    "",
    "- 只按既有规则选择最差长任务和失败场景进行定位，不代表全体性能。所有对照完整保留，没有修改旧报告、策略参数或候选。",
    "- 原账单、事件捕获、同日程重放逐项一致；保存列表可能按结算时机排列，只有实际事件顺序用于构造日程。",
    "- 去掉最后成功尝试会改变后续上下文及缓存，模拟器沿新分支重新计费，不是只减摘要账单。知道任务终点属于评测oracle，不能据此教策略在结束前不压缩。",
    "- 若去掉最后压缩后输入超窗，该项标为不可用，不启用模拟器紧急恢复或把不可执行路径当作节费证据；双方差值也保持null，不把缺失当0。",
    "- 同日程全成功只将尝试成败改为全成功，保留尝试位置，重新演化上下文与缓存；它不是一个重新优化过的无失败控制器，也不等于直接失败账单。",
    "- 两种干预各自独立，不构成可相加的因果分摊。差值的正负只说明该冻结轨迹的局部影响，不证明通用规则。",
    "- 只支持选定的无摘要共享/无预热暖缓存场景；普通请求按读/尾部/写入/输出独立手算，摘要输入输出也核对原账单。",
    "- 附带的after与摘要输出预测只使用当时已有观测，还原后误差与原诊断一致；仍为宿主估算，不是精确用量学习。",
    "- 无真实模型、任务质量或供应商费用结论；默认核心和Pi插件不变。",
    "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("usage: tsx tools/affine-cost-audit.ts");
  const result = runAffineCostAudit();
  writeFileSync(
    new URL("../benchmarks/reports/affine-cost-audit.json", import.meta.url),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  writeFileSync(
    new URL("../benchmarks/affine-cost-audit.md", import.meta.url),
    renderAffineCostAudit(result),
  );
  console.log(
    JSON.stringify(
      result.rows.map((r) => ({ suite: r.suite, deltas: r.deltas.map(({ parts: _, ...d }) => d) })),
      null,
      2,
    ),
  );
}
