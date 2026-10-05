/** Common WAIT continuation ablation; no recursive planner or provider calls. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compactorCases } from "./compactor-model";
import { cycleExecutionCase } from "./cycle-execution";
import { CYCLE_CONTRACTS } from "./cycle-reference";
import type { pairedStressReport } from "./paired-stress";
import { PRICE_PROFILES } from "./provider-ratios";

export function commonContinuationReport(onProgress?: (s: string) => void) {
  const previous = JSON.parse(
    readFileSync(new URL("./reports/paired-stress.json", import.meta.url), "utf8"),
  ) as ReturnType<typeof pairedStressReport>;
  const bases = compactorCases().filter((s) => s.id.startsWith("heldout-floor-180-"));
  const rows = PRICE_PROFILES.flatMap((p) => {
    const rows = bases.flatMap((base) =>
      CYCLE_CONTRACTS.map((c) => {
        const old = previous.rows.find(
          (r) => r.profile === p.id && r.id === base.id && r.contract === c.id,
        );
        if (!old) throw new Error("missing paired control");
        const r = cycleExecutionCase(
          { ...base, pricing: p.pricing, cycleBilling: c.billing },
          "paired-policy",
          undefined,
          "shared-wait-continuation",
        );
        if (
          Math.abs(r.fixed60.cost - old.fixed60.cost) > 1e-10 ||
          r.dynamic.fingerprint !== old.paired.fingerprint ||
          r.historyCost !== old.historyCost
        )
          throw new Error("control mismatch");
        return {
          profile: p.id,
          contract: c.id,
          id: base.id,
          historyCost: r.historyCost,
          fixed60: old.fixed60,
          legacy: old.legacy,
          paired: old.paired,
          common: r.dynamic,
          change: r.change,
          commonVsPaired: r.dynamic.cost / old.paired.cost - 1,
          audit: r.audit,
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
        pairedMeanChange:
          group.reduce((n, r) => n + r.paired.cost / r.fixed60.cost - 1, 0) / group.length,
        meanChange: group.reduce((n, r) => n + r.change, 0) / group.length,
        meanVsPaired: group.reduce((n, r) => n + r.commonVsPaired, 0) / group.length,
        worstChange: Math.max(...group.map((r) => r.change)),
        wins: group.filter((r) => r.change < -1e-9).length,
        losses: group.filter((r) => r.change > 1e-9).length,
        pairedEconomic: group.reduce((n, r) => n + r.paired.economic, 0),
        economic: group.reduce((n, r) => n + r.common.economic, 0),
        forced: group.reduce((n, r) => n + r.common.forced, 0),
      };
    }),
  );
  const base = bases[0];
  if (!base) throw new Error("missing short base");
  const nearEnd = previous.nearEnd.map((old) => {
    const p = PRICE_PROFILES.find((p) => p.id === old.profile);
    const c = CYCLE_CONTRACTS.find((c) => c.id === old.contract);
    if (!p || !c) throw new Error("missing short control");
    const r = cycleExecutionCase(
      {
        ...base,
        id: `short-${old.steps}`,
        steps: old.steps,
        startTokens: 500000,
        pricing: p.pricing,
        cycleBilling: c.billing,
      },
      "paired-policy",
      undefined,
      "shared-wait-continuation",
    );
    if (Math.abs(r.fixed60.cost - old.fixed60Cost) > 1e-10)
      throw new Error("short control mismatch");
    return {
      ...old,
      commonCost: r.dynamic.cost,
      change: r.change,
      commonVsPaired: r.dynamic.cost / old.pairedCost - 1,
      commonCompactions: r.dynamic.summaryCalls,
    };
  });
  return {
    kind: "foldpoint.common-continuation.v1",
    externalCalls: 0,
    paidCalls: 0,
    rows,
    summary,
    nearEnd,
    limitations: [
      "WAIT 按名义费用选择首压类型与重复边界，NOW 复用同一重复边界；压力分支也保持这一策略。每条路径独立计费、保留各自缓存/冷却/保留量。",
      "这是相对一个共同 WAIT 基线策略的单步改进评估，不是全局最优控制或完整递归一致性修复；下一次真实决策仍会重新选策略，未来未复用完整当前收益门。",
      "不增加单周期回本限制；继续先验、压力幅度、余量、风险和原候选范围不变。不因特定模型或任务调整参数。",
      "96 组已见长任务与 63 组短任务，保留旧/配对/固定 60% 控制；完整费用包含普通输出、摘要与预热。历史采集成本单列，不冒充当前费用。",
      "冻结价格比例、假设摘要共享缓存及预热为合成条件，不是真实模型实测。默认核心/Pi 未改，无质量结论。",
    ],
  };
}

export function renderCommonContinuation(r: ReturnType<typeof commonContinuationReport>) {
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
  return [
    "# 共同 WAIT 后续策略：完整任务消融",
    "",
    "负数表示完整模拟账单更低。不是全局最优或真实任务质量证明。",
    "",
    "| 冻结价格 | 计费假设 | 配对 vs 60% | 共同后续 vs 60% | 共同 vs 配对 | 胜/负 | 最差变化 | 配对/共同经济压缩 | 共同强制压缩 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...r.summary.map(
      (s) =>
        `| ${s.profile} | ${s.contract} | ${pct(s.pairedMeanChange)} | ${pct(s.meanChange)} | ${pct(s.meanVsPaired)} | ${s.wins}/${s.losses} | ${pct(s.worstChange)} | ${s.pairedEconomic}/${s.economic} | ${s.forced} |`,
    ),
    "",
    "## 短任务",
    "",
    "| 计费假设 | 数量 | 比配对更贵 | 比配对更便宜 | 比 60% 最差变化 |",
    "| --- | --- | --- | --- | --- |",
    ...CYCLE_CONTRACTS.map((c) => {
      const rows = r.nearEnd.filter((n) => n.contract === c.id);
      return `| ${c.id} | ${rows.length} | ${rows.filter((n) => n.commonVsPaired > 1e-9).length} | ${rows.filter((n) => n.commonVsPaired < -1e-9).length} | ${pct(Math.max(...rows.map((n) => n.change)))} |`;
    }),
    "",
    "## 限制",
    "",
    ...r.limitations.map((l) => `- ${l}`),
    "",
  ].join("\n");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = commonContinuationReport(console.log);
  mkdirSync(new URL("./reports/", import.meta.url), { recursive: true });
  writeFileSync(
    new URL("./reports/common-continuation.json", import.meta.url),
    `${JSON.stringify(r, null, 2)}\n`,
  );
  writeFileSync(new URL("./common-continuation.md", import.meta.url), renderCommonContinuation(r));
  console.log(JSON.stringify(r.summary, null, 2));
}
