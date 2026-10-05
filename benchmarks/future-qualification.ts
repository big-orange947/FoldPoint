/** Partial future-rule screening, with frozen complete-task and short-task controls. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cycleExecutionCase } from "./cycle-execution";
import { attributionCases } from "./forecast-attribution";
import type { buildWarmLengthReport } from "./warm-length-seed";

export const FUTURE_CHECK_BUDGET = 2;
export function futureQualificationCase(scenario: Parameters<typeof cycleExecutionCase>[0]) {
  return cycleExecutionCase(scenario, "paired-policy", undefined, undefined, {
    maxChecksPerPath: FUTURE_CHECK_BUDGET,
  });
}
type LongRow = {
  profile: string;
  sourceFixture: string;
  seed: number;
  steps: number;
  fixed60: ReturnType<typeof cycleExecutionCase>["fixed60"];
  incumbent: ReturnType<typeof cycleExecutionCase>["dynamic"];
  candidate: ReturnType<typeof cycleExecutionCase>["dynamic"];
  audit: ReturnType<typeof cycleExecutionCase>["audit"];
  vsFixed60: number;
  vsIncumbent: number;
  historyCost: number;
};
export function summarizeFutureQualification(rows: LongRow[]) {
  return [...new Set(rows.map((r) => r.profile))].map((profile) => {
    const group = rows.filter((r) => r.profile === profile);
    return {
      profile,
      cases: group.length,
      wins: group.filter((r) => r.vsFixed60 < -1e-9).length,
      losses: group.filter((r) => r.vsFixed60 > 1e-9).length,
      meanVsFixed60: group.reduce((n, r) => n + r.vsFixed60, 0) / group.length,
      meanVsIncumbent: group.reduce((n, r) => n + r.vsIncumbent, 0) / group.length,
      betterThanIncumbent: group.filter((r) => r.vsIncumbent < -1e-9).length,
      worseThanIncumbent: group.filter((r) => r.vsIncumbent > 1e-9).length,
      worstVsFixed60: Math.max(...group.map((r) => r.vsFixed60)),
      checks: group.reduce((n, r) => n + (r.audit.futureRuleChecks ?? 0), 0),
      rejected: group.reduce((n, r) => n + (r.audit.futureRuleRejected ?? 0), 0),
      unassessed: group.reduce((n, r) => n + (r.audit.futureRuleUnassessed ?? 0), 0),
      ordinaryDelta:
        group.reduce((n, r) => n + r.candidate.ordinaryCost - r.incumbent.ordinaryCost, 0) /
        group.length,
      summaryDelta:
        group.reduce((n, r) => n + r.candidate.summaryCost - r.incumbent.summaryCost, 0) /
        group.length,
    };
  });
}
export function futureQualificationReport() {
  const raw = readFileSync(new URL("./reports/warm-length-seed.json", import.meta.url), "utf8");
  const frozen = JSON.parse(raw) as ReturnType<typeof buildWarmLengthReport>;
  const rows: LongRow[] = attributionCases().map((c) => {
    const old = frozen.rows.find(
      (r) =>
        r.profile === c.profile &&
        r.sourceFixture === c.sourceFixture &&
        r.seed === c.seed &&
        r.steps === c.steps &&
        r.suite === c.suite &&
        r.contract === c.contract,
    );
    if (!old) throw new Error("missing frozen control");
    const run = futureQualificationCase(c.scenario);
    if (
      JSON.stringify(run.fixed60) !== JSON.stringify(old.fixed60) ||
      run.historyCost !== old.historyCost ||
      run.dynamic.fingerprint !== old.paired.fingerprint
    )
      throw new Error("controls changed");
    console.log(`future-rule complete: ${c.profile} ${c.sourceFixture}`);
    return {
      profile: c.profile,
      sourceFixture: c.sourceFixture,
      seed: c.seed,
      steps: c.steps,
      fixed60: run.fixed60,
      incumbent: old.paired,
      candidate: run.dynamic,
      audit: run.audit,
      vsFixed60: run.change,
      vsIncumbent: run.dynamic.cost / old.paired.cost - 1,
      historyCost: run.historyCost,
    };
  });
  const short = attributionCases()
    .filter((c) => c.sourceFixture === attributionCases()[0]?.sourceFixture)
    .flatMap((c) =>
      [1, 4, 12].map((steps) => {
        const scenario = { ...c.scenario, steps, startTokens: 500000 };
        const old = cycleExecutionCase(scenario, "paired-policy");
        const candidate = futureQualificationCase(scenario);
        if (
          JSON.stringify(old.fixed60) !== JSON.stringify(candidate.fixed60) ||
          old.dynamic.fingerprint !== candidate.dynamic.fingerprint
        )
          throw new Error("short controls changed");
        return {
          profile: c.profile,
          steps,
          fixed60Cost: candidate.fixed60.cost,
          incumbentCost: old.dynamic.cost,
          candidateCost: candidate.dynamic.cost,
          vsFixed60: candidate.change,
          vsIncumbent: candidate.dynamic.cost / old.dynamic.cost - 1,
          incumbentAttempts: old.dynamic.summaryCalls,
          candidateAttempts: candidate.dynamic.summaryCalls,
          audit: candidate.audit,
        };
      }),
    );
  return {
    kind: "foldpoint.selected-future-qualification.v1",
    externalCalls: 0,
    paidCalls: 0,
    maxChecksPerPath: FUTURE_CHECK_BUDGET,
    frozenControlSha256: createHash("sha256").update(raw).digest("hex"),
    rows,
    short,
    summary: summarizeFutureQualification(rows),
    shortSummary: {
      cases: short.length,
      better: short.filter((r) => r.vsIncumbent < -1e-9).length,
      worse: short.filter((r) => r.vsIncumbent > 1e-9).length,
      unchanged: short.filter((r) => Math.abs(r.vsIncumbent) <= 1e-9).length,
      worstVsFixed60: Math.max(...short.map((r) => r.vsFixed60)),
    },
    limitations: [
      "28 个已见暖缓存主组合：seed 151、360 次调用、七组冻结价格、四种增长/底噪、摘要无共享缓存；另有 21 个近结束对照，不是盲测或真实任务。",
      "仅复核已经选出的名义 NOW/WAIT 路径，每路最早两次通过执行/立即风险门的未来经济尝试；不重新搜索整个候选族，不递归。预算之外保留原续行假设，未检查次数显式计数。",
      "两侧都保留只在安全边界压缩的合法备选；复核不能通过把 WAIT 变差来凭空制造收益。备选是否采用、筛选路径与安全路径费用均保留。",
      "未来复核使用原算法完整收益/压力/结束风险门，年龄按普通调用推进，投影上下文/缓存/冷却，无未来终点、压缩器真值或学习反馈。非完整逐轮执行一致性证明。",
      "名义复核决定按调用位置冻结供压力复算，压力路径仍执行独立安全/冷却/回收/立即风险门；不是所有压力状态的最坏情况保证。",
      "暂不支持累计风险预算、共同续行或单周期门混用；默认核心与 Pi 未变。普通输出、摘要、重建、独立预热完整计费，历史采集费用另列。",
      "单个 seed、相关组合、成功压缩与稳定暖缓存假设；不能推广为跨供应商实测或任务质量结论。候选的费用变化不自动证明其更准确。",
    ],
  };
}
export function renderFutureQualification(r: ReturnType<typeof futureQualificationReport>) {
  return [
    "# 有界未来经济规则复核（未推广）",
    "",
    "负数表示完整模拟费用更低；固定 60% 是主对照，原配对压力算法是消融对照。",
    "复核/拒绝/未复核是每次预测中的候选尝试计数，不是实际摘要调用次数；安全备选被采用时，计数仍保留被筛选路径的诊断。",
    "",
    "| 冻结价格 | 胜/负 vs60 | 平均 vs60 | 平均 vs原算法 | 更好/更差 vs原算法 | 复核/拒绝/未复核 |",
    "| --- | --- | --- | --- | --- | --- |",
    ...r.summary.map(
      (s) =>
        `| ${s.profile} | ${s.wins}/${s.losses} | ${(s.meanVsFixed60 * 100).toFixed(2)}% | ${(s.meanVsIncumbent * 100).toFixed(2)}% | ${s.betterThanIncumbent}/${s.worseThanIncumbent} | ${s.checks}/${s.rejected}/${s.unassessed} |`,
    ),
    "",
    `近结束 ${r.shortSummary.cases} 组：相对原算法 ${r.shortSummary.better} 更好、${r.shortSummary.worse} 更差、${r.shortSummary.unchanged} 不变；相对固定 60% 最坏增支 ${(r.shortSummary.worstVsFixed60 * 100).toFixed(2)}%。`,
    "",
    "## 限制",
    "",
    ...r.limitations.map((l) => `- ${l}`),
    "",
  ].join("\n");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = futureQualificationReport();
  mkdirSync(new URL("./reports/", import.meta.url), { recursive: true });
  writeFileSync(
    new URL("./reports/future-qualification.json", import.meta.url),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync(
    new URL("./future-qualification.md", import.meta.url),
    renderFutureQualification(report),
  );
  console.log(JSON.stringify({ summary: report.summary, short: report.shortSummary }, null, 2));
}
