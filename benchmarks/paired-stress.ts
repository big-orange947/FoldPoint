/** One semantic ablation only; reuses frozen full-task controls without paid requests. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compactorCases } from "./compactor-model";
import { cycleExecutionCase, type cycleExecutionReport } from "./cycle-execution";
import { CYCLE_CONTRACTS } from "./cycle-reference";
import { PRICE_PROFILES } from "./provider-ratios";

export function pairedStressReport(onProgress?: (message: string) => void) {
  const previous = JSON.parse(
    readFileSync(new URL("./reports/cycle-execution.json", import.meta.url), "utf8"),
  ) as ReturnType<typeof cycleExecutionReport>;
  const bases = compactorCases().filter((s) => s.id.startsWith("heldout-floor-180-"));
  const rows = PRICE_PROFILES.flatMap((p) => {
    const rows = bases.flatMap((base) =>
      CYCLE_CONTRACTS.map((c) => {
        const old = previous.rows.find(
          (r) => r.profile === p.id && r.id === base.id && r.contract === c.id,
        );
        if (!old) throw new Error("missing frozen control");
        const paired = cycleExecutionCase(
          { ...base, pricing: p.pricing, cycleBilling: c.billing },
          "paired-policy",
        );
        if (
          Math.abs(paired.fixed60.cost - old.fixed60.cost) > 1e-10 ||
          paired.dynamic.fingerprint !== old.dynamic.fingerprint ||
          paired.historyCost !== old.historyCost
        )
          throw new Error("control mismatch");
        return {
          profile: p.id,
          contract: c.id,
          id: base.id,
          historyCost: paired.historyCost,
          fixed60: paired.fixed60,
          legacy: old.dynamic,
          paired: paired.dynamic,
          legacyChange: old.change,
          pairedChange: paired.change,
          pairedVsLegacy: paired.dynamic.cost / old.dynamic.cost - 1,
          legacyAudit: old.audit,
          pairedAudit: paired.audit,
        };
      }),
    );
    onProgress?.(`long tasks complete: ${p.id}`);
    return rows;
  });
  const summary = PRICE_PROFILES.flatMap((p) =>
    CYCLE_CONTRACTS.map((c) => {
      const group = rows.filter((r) => r.profile === p.id && r.contract === c.id);
      return {
        profile: p.id,
        contract: c.id,
        cases: group.length,
        meanLegacyChange: group.reduce((s, r) => s + r.legacyChange, 0) / group.length,
        meanPairedChange: group.reduce((s, r) => s + r.pairedChange, 0) / group.length,
        worstPairedChange: Math.max(...group.map((r) => r.pairedChange)),
        wins: group.filter((r) => r.pairedChange < -1e-9).length,
        losses: group.filter((r) => r.pairedChange > 1e-9).length,
        meanPairedVsLegacy: group.reduce((s, r) => s + r.pairedVsLegacy, 0) / group.length,
        legacyEconomic: group.reduce((s, r) => s + r.legacy.economic, 0),
        pairedEconomic: group.reduce((s, r) => s + r.paired.economic, 0),
        legacyLongestKeep: Math.max(...group.map((r) => r.legacyAudit.longest?.calls ?? 0)),
        pairedLongestKeep: Math.max(...group.map((r) => r.pairedAudit.longest?.calls ?? 0)),
      };
    }),
  );
  const base = bases[0];
  if (!base) throw new Error("missing near-end base");
  const nearEnd = PRICE_PROFILES.filter((p) => p.id !== "deepseek-flash-offpeak").flatMap((p) =>
    [1, 4, 12].flatMap((steps) =>
      CYCLE_CONTRACTS.map((c) => {
        const scenario = {
          ...base,
          id: `short-${steps}`,
          steps,
          startTokens: 500000,
          pricing: p.pricing,
          cycleBilling: c.billing,
        };
        const legacy = cycleExecutionCase(scenario);
        const paired = cycleExecutionCase(scenario, "paired-policy");
        return {
          profile: p.id,
          contract: c.id,
          steps,
          fixed60Cost: paired.fixed60.cost,
          legacyCost: legacy.dynamic.cost,
          pairedCost: paired.dynamic.cost,
          pairedChange: paired.change,
          pairedVsLegacy: paired.dynamic.cost / legacy.dynamic.cost - 1,
          legacyCompactions: legacy.dynamic.summaryCalls,
          pairedCompactions: paired.dynamic.summaryCalls,
        };
      }),
    ),
  );
  return {
    kind: "foldpoint.paired-stress.v1",
    paidCalls: 0,
    externalCalls: 0,
    rows,
    summary,
    nearEnd,
    limitations: [
      "只修改 WAIT 压力对照的选择语义：与 NOW 一样，先按名义预测选策略，再压力测试同一个策略。继续概率、压力幅度、收益余量、安全与执行门均未放宽。",
      "旧方式是在压力情景里独立取最便宜 WAIT，是额外保守的包络比较；它不是少收费的账本错误。新方式不是对所有 WAIT 策略的最坏情形保证。",
      "未来重复压缩仍未完整复用当前的收益/压力门，本轮没有修复完整递归预测一致性；不能称为该问题已全部解决。",
      "96 组长任务沿用上一轮完整控制，固定 60% 费用、增长指纹和历史费用逐项匹配；组合已看过，不是盲测。缓存共享仍为假设，任务质量未验证，默认核心/Pi 未切换。",
      "63 组短任务从 500k 上下文开始，首个普通请求建立缓存，包含一轮结束及 4/12 轮结束；用于检查损失面，不是新暖缓存长任务收益样本。",
    ],
  };
}

export function renderPairedStress(r: ReturnType<typeof pairedStressReport>) {
  return [
    "# 名义策略配对压力检查：固定 60% 对照",
    "",
    "负数为完整模拟账单更低；没有模型实测或质量证明。",
    "",
    "| 冻结价格 | 计费假设 | 旧 vs 60% | 配对 vs 60% | 胜/负 | 最差变化 | 配对 vs 旧 | 旧/配对经济压缩 | 旧/配对最长等待 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...r.summary.map(
      (s) =>
        `| ${s.profile} | ${s.contract} | ${(s.meanLegacyChange * 100).toFixed(2)}% | ${(s.meanPairedChange * 100).toFixed(2)}% | ${s.wins}/${s.losses} | ${(s.worstPairedChange * 100).toFixed(2)}% | ${(s.meanPairedVsLegacy * 100).toFixed(2)}% | ${s.legacyEconomic}/${s.pairedEconomic} | ${s.legacyLongestKeep}/${s.pairedLongestKeep} |`,
    ),
    "",
    "## 短任务损失面",
    "",
    "| 计费假设 | 样本数 | 配对比旧更贵的次数 | 配对 vs 旧最差变化 | 配对 vs 60%最差变化 |",
    "| --- | --- | --- | --- | --- |",
    ...CYCLE_CONTRACTS.map((c) => {
      const rows = r.nearEnd.filter((n) => n.contract === c.id);
      return `| ${c.id} | ${rows.length} | ${rows.filter((n) => n.pairedVsLegacy > 1e-9).length} | ${(Math.max(...rows.map((n) => n.pairedVsLegacy)) * 100).toFixed(2)}% | ${(Math.max(...rows.map((n) => n.pairedChange)) * 100).toFixed(2)}% |`;
    }),
    "",
    "## 限制",
    "",
    ...r.limitations.map((l) => `- ${l}`),
    "",
  ].join("\n");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = pairedStressReport(console.log);
  mkdirSync(new URL("./reports/", import.meta.url), { recursive: true });
  writeFileSync(
    new URL("./reports/paired-stress.json", import.meta.url),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync(new URL("./paired-stress.md", import.meta.url), renderPairedStress(report));
  console.log(JSON.stringify(report.summary, null, 2));
}
