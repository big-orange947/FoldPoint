/** Single-cycle qualification ablation, not a recursive policy solver. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compactorCases } from "./compactor-model";
import { cycleExecutionCase } from "./cycle-execution";
import { CYCLE_CONTRACTS } from "./cycle-reference";
import type { pairedStressReport } from "./paired-stress";
import { PRICE_PROFILES } from "./provider-ratios";

export function forecastPaybackReport(onProgress?: (s: string) => void) {
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
          "single-cycle",
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
          gated: r.dynamic,
          pairedChange: old.pairedChange,
          gatedChange: r.change,
          gatedVsPaired: r.dynamic.cost / old.paired.cost - 1,
          audit: r.audit,
        };
      }),
    );
    onProgress?.(`long tasks complete: ${p.id}`);
    return rows;
  });
  const summary = PRICE_PROFILES.flatMap((p) =>
    CYCLE_CONTRACTS.map((c) => {
      const g = rows.filter((r) => r.profile === p.id && r.contract === c.id);
      const mean = (pick: (r: (typeof g)[number]) => number) =>
        g.reduce((s, r) => s + pick(r), 0) / g.length;
      return {
        profile: p.id,
        contract: c.id,
        cases: g.length,
        meanPairedChange: mean((r) => r.pairedChange),
        meanGatedChange: mean((r) => r.gatedChange),
        meanGatedVsPaired: mean((r) => r.gatedVsPaired),
        worstGatedChange: Math.max(...g.map((r) => r.gatedChange)),
        wins: g.filter((r) => r.gatedChange < -1e-9).length,
        losses: g.filter((r) => r.gatedChange > 1e-9).length,
        pairedEconomic: g.reduce((s, r) => s + r.paired.economic, 0),
        gatedEconomic: g.reduce((s, r) => s + r.gated.economic, 0),
        gatedForced: g.reduce((s, r) => s + r.gated.forced, 0),
        cycleRejections: g.reduce((s, r) => s + (r.audit.cycleRejections ?? 0), 0),
      };
    }),
  );
  const base = bases[0];
  if (!base) throw new Error("missing short base");
  const nearEnd = previous.nearEnd.map((old) => {
    const p = PRICE_PROFILES.find((p) => p.id === old.profile),
      c = CYCLE_CONTRACTS.find((c) => c.id === old.contract);
    if (!p || !c) throw new Error("missing short contract");
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
      "single-cycle",
    );
    if (Math.abs(r.fixed60.cost - old.fixed60Cost) > 1e-10)
      throw new Error("short control mismatch");
    return {
      ...old,
      gatedCost: r.dynamic.cost,
      gatedVsPaired: r.dynamic.cost / old.pairedCost - 1,
      gatedChange: r.change,
      gatedCompactions: r.dynamic.summaryCalls,
    };
  });
  return {
    kind: "foldpoint.forecast-payback.v1",
    paidCalls: 0,
    externalCalls: 0,
    rows,
    summary,
    nearEnd,
    limitations: [
      "只增加 single-cycle 资格假设：当前与预测中的经济候选都要在 KEEP 下一次安全压缩前，按相同存活先验和压力预测覆盖摘要/重建/预热费用及收益余量；安全 FORCE 不受影响。它不是全任务省钱的数学必要条件。",
      "闭式折现未来缓存节省，不递归求解。当前仍需通过原 NOW/WAIT 整体收益门，未来没有完全复用那项门。因此这不是完整策略一致性修复。",
      "截断周期是额外保守假设，可能排除跨安全压缩后才能兑现的长期收益。拒绝更多压缩不代表性能改善，必须保留所有负结果。",
      "96 组已见暖缓存长任务，旧/配对/固定 60% 控制原样保留。63 组短任务首请求建缓存；缓存共享是假设、质量未验证，默认核心/Pi 未切换。",
    ],
  };
}
export function renderForecastPayback(r: ReturnType<typeof forecastPaybackReport>) {
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  return [
    "# 单周期资格假设：完整任务消融",
    "",
    "负数为完整模拟费用更低，不是完整递归一致性证明。",
    "",
    "| 冻结价格 | 计费假设 | 配对 vs 60% | 单周期 vs 60% | 胜/负 | 最差变化 | 单周期 vs 配对 | 配对/单周期经济压缩 | 单周期强制压缩 | 拒绝次数 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...r.summary.map(
      (s) =>
        `| ${s.profile} | ${s.contract} | ${pct(s.meanPairedChange)} | ${pct(s.meanGatedChange)} | ${s.wins}/${s.losses} | ${pct(s.worstGatedChange)} | ${pct(s.meanGatedVsPaired)} | ${s.pairedEconomic}/${s.gatedEconomic} | ${s.gatedForced} | ${s.cycleRejections} |`,
    ),
    "",
    "## 短任务",
    "",
    "| 计费假设 | 数量 | 比配对更贵 | 比配对最差变化 | 比 60%最差变化 |",
    "| --- | --- | --- | --- | --- |",
    ...CYCLE_CONTRACTS.map((c) => {
      const rows = r.nearEnd.filter((n) => n.contract === c.id);
      return `| ${c.id} | ${rows.length} | ${rows.filter((n) => n.gatedVsPaired > 1e-9).length} | ${pct(Math.max(...rows.map((n) => n.gatedVsPaired)))} | ${pct(Math.max(...rows.map((n) => n.gatedChange)))} |`;
    }),
    "",
    "## 限制",
    "",
    ...r.limitations.map((l) => `- ${l}`),
    "",
  ].join("\n");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = forecastPaybackReport(console.log);
  mkdirSync(new URL("./reports/", import.meta.url), { recursive: true });
  writeFileSync(
    new URL("./reports/forecast-payback.json", import.meta.url),
    `${JSON.stringify(r, null, 2)}\n`,
  );
  writeFileSync(new URL("./forecast-payback.md", import.meta.url), renderForecastPayback(r));
  console.log(JSON.stringify(r.summary, null, 2));
}
