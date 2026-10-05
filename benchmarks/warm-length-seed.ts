/** Frozen algorithms; vary endpoint and growth RNG only. No provider or key access. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compactorCases } from "./compactor-model";
import { cycleExecutionCase } from "./cycle-execution";
import { CYCLE_CONTRACTS } from "./cycle-reference";
import { PRICE_PROFILES } from "./provider-ratios";
import { buildGrowthSequence, fingerprintSequence, type Scenario } from "./scenarios";

export const WARM_LENGTH_MANIFEST = JSON.parse(
  readFileSync(new URL("./datasets/warm-length-seed-v1.json", import.meta.url), "utf8"),
) as {
  version: string;
  algorithmBaselineCommit: string;
  seeds: number[];
  lengths: number[];
  sourceFixtures: string[];
  profiles: string[];
  mainContract: string;
  sensitivity: { seed: number; sourceFixture: string; contracts: string[] };
  mainCases: number;
  sensitivityCases: number;
  excludedScalarControl: string;
  exclusionReason: string;
  scope: string;
};
export function warmLengthCases() {
  const bases = compactorCases();
  const m = WARM_LENGTH_MANIFEST;
  const build = (
    source: string,
    seed: number,
    steps: number,
    profile: string,
    contract: string,
    suite: string,
  ) => {
    const base: Scenario | undefined = bases.find((b) => b.id === source);
    const p = PRICE_PROFILES.find((p) => p.id === profile);
    const c = CYCLE_CONTRACTS.find((c) => c.id === contract);
    if (!base || !p || !c) throw new Error("unknown manifest component");
    const scenario: Scenario = {
      ...base,
      id: `length-seed-${seed}-${steps}-${base.growthPerStep}-${base.compactor.retainedFloorTokens}`,
      seed,
      steps,
      pricing: p.pricing,
      cycleBilling: c.billing,
    };
    return { profile, contract, suite, sourceFixture: source, seed, steps, scenario };
  };
  return [
    ...m.profiles.flatMap((p) =>
      m.sourceFixtures.flatMap((b) =>
        m.seeds.flatMap((seed) =>
          m.lengths.map((steps) => build(b, seed, steps, p, m.mainContract, "main")),
        ),
      ),
    ),
    ...m.profiles.flatMap((p) =>
      m.sensitivity.contracts.flatMap((c) =>
        m.lengths.map((steps) =>
          build(
            m.sensitivity.sourceFixture,
            m.sensitivity.seed,
            steps,
            p,
            c,
            "billing-sensitivity",
          ),
        ),
      ),
    ),
  ];
}
type Row = ReturnType<typeof evaluateWarmLengthCase>;
export function evaluateWarmLengthCase(c: ReturnType<typeof warmLengthCases>[number]) {
  const paired = cycleExecutionCase(c.scenario, "paired-policy");
  const common = cycleExecutionCase(
    c.scenario,
    "paired-policy",
    undefined,
    "shared-wait-continuation",
  );
  if (
    JSON.stringify(paired.fixed60) !== JSON.stringify(common.fixed60) ||
    paired.historyCost !== common.historyCost ||
    paired.dynamic.fingerprint !== common.dynamic.fingerprint
  )
    throw new Error("paired controls differ");
  const growth = buildGrowthSequence(c.scenario);
  const { scenario, ...identity } = c;
  return {
    ...identity,
    growthPerStep: scenario.growthPerStep,
    retainedFloorTokens: scenario.compactor.retainedFloorTokens,
    growthPrefixFingerprints: WARM_LENGTH_MANIFEST.lengths
      .filter((n) => n <= c.steps)
      .map((steps) => ({ steps, fingerprint: fingerprintSequence(growth.slice(0, steps)) })),
    historyCost: paired.historyCost,
    fixed60: paired.fixed60,
    paired: paired.dynamic,
    common: common.dynamic,
    pairedChange: paired.change,
    commonChange: common.change,
    pairedAudit: paired.audit,
    commonAudit: common.audit,
  };
}
const arms = ["fixed60", "paired", "common"] as const;
export function summarizeWarmLengths(rows: Row[]) {
  const keys = [...new Set(rows.map((r) => `${r.suite}/${r.profile}/${r.contract}`))];
  return keys.flatMap((key) =>
    [undefined, ...WARM_LENGTH_MANIFEST.lengths].flatMap((steps) => {
      const group = rows.filter(
        (r) =>
          `${r.suite}/${r.profile}/${r.contract}` === key &&
          (steps === undefined || r.steps === steps),
      );
      const first = group[0];
      if (!first) return [];
      return (["paired", "common"] as const).map((arm) => {
        const deltas = group.map((r) => r[arm].cost / r.fixed60.cost - 1);
        return {
          suite: first.suite,
          profile: first.profile,
          contract: first.contract,
          steps: steps ?? "all",
          arm,
          cases: group.length,
          wins: deltas.filter((d) => d < -1e-9).length,
          losses: deltas.filter((d) => d > 1e-9).length,
          ties: deltas.filter((d) => Math.abs(d) <= 1e-9).length,
          meanChange: deltas.reduce((a, b) => a + b, 0) / group.length,
          aggregateCostChange:
            group.reduce((n, r) => n + r[arm].cost, 0) /
              group.reduce((n, r) => n + r.fixed60.cost, 0) -
            1,
          worstChange: Math.max(...deltas),
          bestChange: Math.min(...deltas),
          economic: group.reduce((n, r) => n + r[arm].economic, 0),
          forced: group.reduce((n, r) => n + r[arm].forced, 0),
          meanOrdinaryCostDelta:
            group.reduce((n, r) => n + r[arm].ordinaryCost - r.fixed60.ordinaryCost, 0) /
            group.length,
          meanSummaryCostDelta:
            group.reduce((n, r) => n + r[arm].summaryCost - r.fixed60.summaryCost, 0) /
            group.length,
          meanPrewarmCostDelta:
            group.reduce((n, r) => n + r[arm].prewarmCost - r.fixed60.prewarmCost, 0) /
            group.length,
          meanCostDelta: group.reduce((n, r) => n + r[arm].cost - r.fixed60.cost, 0) / group.length,
        };
      });
    }),
  );
}
export function auditWarmPrefixes(rows: Row[]) {
  const keys = [
    ...new Set(rows.map((r) => `${r.profile}/${r.contract}/${r.sourceFixture}/${r.seed}`)),
  ];
  return keys.flatMap((key) => {
    const stream = rows
      .filter((r) => `${r.profile}/${r.contract}/${r.sourceFixture}/${r.seed}` === key)
      .sort((a, b) => a.steps - b.steps);
    return stream.slice(1).flatMap((later, i) => {
      const earlier = stream[i];
      if (!earlier) throw new Error("missing prefix");
      const sameGrowth =
        later.growthPrefixFingerprints.find((f) => f.steps === earlier.steps)?.fingerprint ===
        earlier.fixed60.fingerprint;
      return arms.map((arm) => {
        const sameCompactions =
          JSON.stringify(earlier[arm].compactions) ===
          JSON.stringify(later[arm].compactions.filter((c) => c.step < earlier.steps));
        const checkpoints =
          arm === "fixed60"
            ? undefined
            : arm === "paired"
              ? [earlier.pairedAudit.checkpoints, later.pairedAudit.checkpoints]
              : [earlier.commonAudit.checkpoints, later.commonAudit.checkpoints];
        // Ordinary checkpoints common to every endpoint; compaction records checked in full above.
        const commonCheckpoints = checkpoints?.map((ts) =>
          ts.filter((t) => [0, 20, 60, 100].includes(t.step)),
        );
        const sameCheckpoints =
          !commonCheckpoints ||
          JSON.stringify(commonCheckpoints[0]) === JSON.stringify(commonCheckpoints[1]);
        if (!sameGrowth || !sameCompactions || !sameCheckpoints)
          throw new Error(`prefix instability: ${key}/${arm}`);
        return {
          stream: key,
          arm,
          from: earlier.steps,
          to: later.steps,
          sameGrowth,
          sameCompactions,
          sameCheckpoints,
          // Only diagnostic subtraction AFTER runs. The policy never receives the endpoint.
          incrementalCost: later[arm].cost - earlier[arm].cost,
          incrementalOrdinaryCost: later[arm].ordinaryCost - earlier[arm].ordinaryCost,
          incrementalSummaryCost: later[arm].summaryCost - earlier[arm].summaryCost,
          incrementalPrewarmCost: later[arm].prewarmCost - earlier[arm].prewarmCost,
          incrementalSummaryCalls: later[arm].summaryCalls - earlier[arm].summaryCalls,
          tailCallsSinceLastCompaction:
            later.steps - 1 - (later[arm].compactions.at(-1)?.step ?? -1),
        };
      });
    });
  });
}
export function warmStreamStability(rows: Row[]) {
  const main = rows.filter((r) => r.suite === "main");
  const keys = [...new Set(main.map((r) => `${r.profile}/${r.sourceFixture}/${r.seed}`))];
  const streams = keys.flatMap((key) => {
    const group = main
      .filter((r) => `${r.profile}/${r.sourceFixture}/${r.seed}` === key)
      .sort((a, b) => a.steps - b.steps);
    const first = group[0];
    if (!first) throw new Error("missing stream");
    return (["paired", "common"] as const).map((arm) => {
      const deltas = group.map((r) => r[arm].cost / r.fixed60.cost - 1);
      return {
        stream: key,
        profile: first.profile,
        arm,
        endpoints: group.map((r, i) => ({ steps: r.steps, change: deltas[i] ?? 0 })),
        allWin: deltas.every((d) => d < -1e-9),
        allLose: deltas.every((d) => d > 1e-9),
        signFlip: deltas.some((d) => d < -1e-9) && deltas.some((d) => d > 1e-9),
      };
    });
  });
  const summary = [...new Set(main.map((r) => r.profile))].flatMap((profile) =>
    (["paired", "common"] as const).map((arm) => {
      const group = streams.filter((s) => s.profile === profile && s.arm === arm);
      return {
        profile,
        arm,
        streams: group.length,
        allWin: group.filter((s) => s.allWin).length,
        allLose: group.filter((s) => s.allLose).length,
        signFlip: group.filter((s) => s.signFlip).length,
      };
    }),
  );
  return { streams, summary };
}
export function buildWarmLengthReport(rows: Row[], sourceHashes: Record<string, string>) {
  const key = (r: {
    suite: string;
    profile: string;
    contract: string;
    sourceFixture: string;
    seed: number;
    steps: number;
  }) => `${r.suite}/${r.profile}/${r.contract}/${r.sourceFixture}/${r.seed}/${r.steps}`;
  const expected = new Set(warmLengthCases().map(key));
  if (
    rows.length !== expected.size ||
    new Set(rows.map(key)).size !== expected.size ||
    rows.some((r) => !expected.has(key(r)))
  )
    throw new Error("frozen matrix is incomplete, duplicated or changed");
  return {
    kind: WARM_LENGTH_MANIFEST.version,
    manifest: WARM_LENGTH_MANIFEST,
    sourceHashes,
    paidCalls: 0,
    externalCalls: 0,
    rows,
    summary: summarizeWarmLengths(rows),
    prefixAudits: auditWarmPrefixes(rows),
    stability: warmStreamStability(rows),
    limitations: [
      "算法与参数冻结在 69d2752；新 seeds/长度首次扩展验证，读完结果后即为已见合成数据，不再称盲测。",
      "252 组主表为完整价格×底座×增长×种子×长度组合；42 组计费敏感性只覆盖 22k 增长/20k 底座/seed151，不外推到全部组合。",
      "主对照固定 60%；配对压力候选与共同后续候选都保留，未选择表现最好的版本替换负结果。offpeak 标量对照不重复计作独立价格比例。",
      "除首请求建立缓存外，TTL 内持续暖缓存；所有压缩成功、恒定增长分布、兼容历史为合成前提，不代表真实任务质量或 provider 缓存行为。",
      "摘要/重建/独立预热与普通输出全部计费，历史采集成本单列。费用平均变化与总账比例是不同统计口径，无人口分布或置信区间保证。",
      "共同增长前缀、实际压缩与公共决策点相同后，区间账单才用长减短。结束位置敏感性是诊断，不证明全部差异来自最后周期；尚未分解预测误差原因。",
      "不读 API key、不调用模型，不改默认核心/Pi 策略，不把真实未来长度喂给决策。",
    ],
  };
}
export function renderWarmLengths(r: ReturnType<typeof buildWarmLengthReport>) {
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
  const table = (suite: string, all: boolean) =>
    r.summary
      .filter((s) => s.suite === suite && (all ? s.steps === "all" : s.steps !== "all"))
      .map(
        (s) =>
          `| ${s.profile} | ${s.contract} | ${s.steps} | ${s.arm} | ${s.cases} | ${s.wins}/${s.losses}/${s.ties} | ${pct(s.meanChange)} | ${pct(s.aggregateCostChange)} | ${pct(s.worstChange)} |`,
      );
  const header = [
    "| 冻结价格 | 计费假设 | 调用长度 | 候选 | 数量 | 胜/负/平 | 平均变化 | 总账变化 | 最差变化 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  return [
    "# 暖缓存长任务：冻结参数的长度与种子扩展",
    "",
    "负数为相对固定 60% 更便宜；全部合成费用，非真实模型质量成绩。",
    "",
    "## 主表",
    "",
    ...header,
    ...table("main", true),
    "",
    "## 按长度",
    "",
    ...header,
    ...table("main", false),
    "",
    "## 360 次调用的平均费用差拆分",
    "",
    "每列为候选减固定 60% 的模拟 USD/任务；普通请求含压缩后重建，摘要与独立预热另列。不是实际账单。",
    "",
    "| 冻结价格 | 候选 | 普通请求（含重建） | 摘要 | 独立预热 | 总差额 |",
    "| --- | --- | --- | --- | --- | --- |",
    ...r.summary
      .filter((s) => s.suite === "main" && s.steps === 360)
      .map(
        (s) =>
          `| ${s.profile} | ${s.arm} | ${s.meanOrdinaryCostDelta.toFixed(4)} | ${s.meanSummaryCostDelta.toFixed(4)} | ${s.meanPrewarmCostDelta.toFixed(4)} | ${s.meanCostDelta.toFixed(4)} |`,
      ),
    "",
    "## 同一增长流换结束位置的稳定性",
    "",
    "每个流固定种子/增长/底座，只改变 120/240/360 的结束位置。符号翻转只证明结束位置敏感，不自动归因为最后一个周期。",
    "",
    "| 冻结价格 | 候选 | 流数 | 三个长度都胜 | 三个长度都负 | 胜负翻转 |",
    "| --- | --- | --- | --- | --- | --- |",
    ...r.stability.summary.map(
      (s) =>
        `| ${s.profile} | ${s.arm} | ${s.streams} | ${s.allWin} | ${s.allLose} | ${s.signFlip} |`,
    ),
    "",
    "## 有限计费敏感性",
    "",
    ...header,
    ...table("billing-sensitivity", true),
    "",
    "## 前缀一致性",
    "",
    `${r.prefixAudits.length} 条区间/策略检查通过：相同增长前缀、完整压缩记录和公共决策点。区间账单见 JSON，不反馈给算法。`,
    "",
    "## 限制",
    "",
    ...r.limitations.map((l) => `- ${l}`),
    "",
  ].join("\n");
}
export function warmLengthReport(onProgress?: (s: string) => void) {
  const rows: Row[] = [];
  const cases = warmLengthCases();
  const paths = [
    "src/experimental-runtime.ts",
    "src/experimental-compactor.ts",
    "src/experimental-cycle.ts",
    "src/cache.ts",
    "src/pricing.ts",
    "src/defaults.ts",
    "src/engine.ts",
    "src/estimator.ts",
    "src/learner.ts",
    "benchmarks/cycle-execution.ts",
    "benchmarks/simulator.ts",
    "benchmarks/history-reuse.ts",
    "benchmarks/duration-mixture.ts",
    "benchmarks/provider-ratios.ts",
  ];
  const hash = (path: string) =>
    createHash("sha256")
      .update(readFileSync(new URL(`../${path}`, import.meta.url)))
      .digest("hex");
  const sourceHashes = Object.fromEntries(paths.map((p) => [p, hash(p)]));
  for (const p of WARM_LENGTH_MANIFEST.profiles) {
    for (const c of cases.filter((c) => c.profile === p)) rows.push(evaluateWarmLengthCase(c));
    onProgress?.(`completed ${p}: ${rows.length}/${cases.length}`);
  }
  for (const p of paths)
    if (hash(p) !== sourceHashes[p]) throw new Error(`source changed during run: ${p}`);
  return buildWarmLengthReport(rows, sourceHashes);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Reprojection consumes completed rows only, never replays requests or changes policies.
  const existing = process.argv.includes("--analyze-existing")
    ? (JSON.parse(
        readFileSync(new URL("./reports/warm-length-seed.json", import.meta.url), "utf8"),
      ) as ReturnType<typeof buildWarmLengthReport>)
    : undefined;
  if (existing && JSON.stringify(existing.manifest) !== JSON.stringify(WARM_LENGTH_MANIFEST))
    throw new Error("cannot reproject a different frozen manifest");
  const r = existing
    ? buildWarmLengthReport(existing.rows, existing.sourceHashes)
    : warmLengthReport(console.log);
  mkdirSync(new URL("./reports/", import.meta.url), { recursive: true });
  writeFileSync(
    new URL("./reports/warm-length-seed.json", import.meta.url),
    `${JSON.stringify(r, null, 2)}\n`,
  );
  writeFileSync(new URL("./warm-length-seed.md", import.meta.url), renderWarmLengths(r));
  console.log(
    JSON.stringify(
      r.summary.filter((s) => s.suite === "main" && s.steps === "all"),
      null,
      2,
    ),
  );
}
