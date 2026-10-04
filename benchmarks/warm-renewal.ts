/** Opt-in warm-cache screen. No real API calls or task endpoint given to the policy. */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRawFixedThresholdStrategy } from "./fixed-threshold";
import { PRICE_PROFILES, ratioScenarios } from "./provider-ratios";
import { createFoldPointStrategy, runSession } from "./simulator";

export function warmCases() {
  const original = ratioScenarios();
  const warm = original.filter((s) => s.id.includes("-warm-"));
  const base = warm[0];
  if (!base) throw new Error("Missing scenario");
  const heldout = [80, 180].flatMap((steps) =>
    [22000, 41000].flatMap((growthPerStep) =>
      [0.08, 0.17, 0.27].map((retentionRatio) => ({
        ...base,
        id: `heldout-${steps}-${growthPerStep}-${retentionRatio}`,
        seed: 191,
        steps,
        growthPerStep,
        growthJitter: 4000,
        compactor: { retentionRatio, outputRatio: 0.003, successRate: 1 },
      })),
    ),
  );
  const cold = original.filter(
    (s) =>
      s.steps === 140 &&
      !s.id.includes("-warm-") &&
      s.compactor.retentionRatio === 0.1 &&
      s.compactor.outputRatio === 0.002,
  );
  return [...warm, ...heldout, ...cold];
}

export function warmRenewalReport(
  cases = warmCases(),
  profiles = PRICE_PROFILES,
  experiment?: { durationComponents: import("../src/index").RuntimeDurationModel["components"] },
) {
  const rows = profiles.flatMap((profile) =>
    cases.map((base) => {
      const scenario = { ...base, pricing: profile.pricing };
      const diagnostics: Record<
        string,
        {
          decisions: number;
          eligible: number;
          positiveNominal: number;
          positiveStress: number;
          endingRiskBlocked: number;
          triggered: number;
          forecastSamples?: number;
          brierSum?: number;
        }
      > = {};
      function audit(name: string) {
        return (e: import("../src/index").RuntimeSurvivalEstimate) => {
          const d = diagnostics[name] ?? {
            decisions: 0,
            eligible: 0,
            positiveNominal: 0,
            positiveStress: 0,
            endingRiskBlocked: 0,
            triggered: 0,
          };
          d.decisions++;
          if (e.eligible) {
            d.eligible++;
            if (e.expectedSaving > 0) d.positiveNominal++;
            if (e.stressedSaving > 0) d.positiveStress++;
            if (e.assessedEndingLoss > e.immediateLossBudget) d.endingRiskBlocked++;
            if (e.shouldCompact) d.triggered++;
          }
          if (experiment) {
            // Endpoint scoring is audit-only, after the estimate; never sent to policy.
            d.forecastSamples = (d.forecastSamples ?? 0) + 1;
            const actual = d.decisions < base.steps ? 1 : 0;
            d.brierSum = (d.brierSum ?? 0) + (e.continuationProbabilityNext - actual) ** 2;
          }
          diagnostics[name] = d;
        };
      }
      const common = {
        omitRequestCacheEvidence: true,
        verifiedAppendOnlyPrefix: true,
        defaults: { compactOutputRatio: 0.002 },
        runtimeSurvival: { continuationProbability: 0.95, maxImmediateLossRatio: 1 },
      };
      const strategies = {
        fixed50: createRawFixedThresholdStrategy(0.5),
        fixed60: createRawFixedThresholdStrategy(0.6),
        fixed70: createRawFixedThresholdStrategy(0.7),
        legacy: createFoldPointStrategy(scenario, {
          ...common,
          onSurvivalEstimate: audit("legacy"),
        }),
        renewalStrict: createFoldPointStrategy(scenario, {
          ...common,
          onSurvivalEstimate: audit("renewalStrict"),
          runtimeSurvival: { ...common.runtimeSurvival, rolloutMode: "renewal" },
        }),
        renewalWeighted: createFoldPointStrategy(scenario, {
          ...common,
          onSurvivalEstimate: audit("renewalWeighted"),
          runtimeSurvival: {
            ...common.runtimeSurvival,
            rolloutMode: "renewal",
            endingRiskMode: "survival-weighted",
            endingLossBudgetRatio: 1,
          },
        }),
        ...(experiment
          ? {
              geometric256: createFoldPointStrategy(scenario, {
                ...common,
                onSurvivalEstimate: audit("geometric256"),
                runtimeSurvival: {
                  ...common.runtimeSurvival,
                  maxCalls: 256,
                  rolloutMode: "renewal" as const,
                  endingRiskMode: "survival-weighted" as const,
                  endingLossBudgetRatio: 1,
                },
              }),
              durationMixture: createFoldPointStrategy(scenario, {
                ...common,
                onSurvivalEstimate: audit("durationMixture"),
                runtimeSurvival: {
                  ...common.runtimeSurvival,
                  maxCalls: 256,
                  rolloutMode: "renewal" as const,
                  endingRiskMode: "survival-weighted" as const,
                  endingLossBudgetRatio: 1,
                  durationModel: { completedCalls: 0, components: experiment.durationComponents },
                },
              }),
              frozenDuration: createFoldPointStrategy(scenario, {
                ...common,
                advanceDurationAge: false,
                onSurvivalEstimate: audit("frozenDuration"),
                runtimeSurvival: {
                  ...common.runtimeSurvival,
                  maxCalls: 256,
                  rolloutMode: "renewal" as const,
                  endingRiskMode: "survival-weighted" as const,
                  endingLossBudgetRatio: 1,
                  durationModel: { completedCalls: 0, components: experiment.durationComponents },
                },
              }),
            }
          : {}),
      };
      const arms = Object.fromEntries(
        Object.entries(strategies).map(([arm, strategy]) => {
          const run = runSession(scenario, strategy);
          return [
            arm,
            {
              cost: run.metrics.totalSimulatedCost,
              attempts: run.metrics.compactionAttemptCount,
              overflow: run.metrics.overflowCount,
              fingerprint: run.metrics.growthSequenceFingerprint,
              economic: run.metrics.economicAttemptCount,
              forced: run.metrics.forcedAttemptCount,
              summaryCost: run.compactions.reduce((a, c) => a + c.attemptCost, 0),
              compactionSteps: run.compactions.map((c) => c.step),
            },
          ];
        }),
      );
      return {
        profile: profile.id,
        id: base.id,
        calls: base.steps,
        suite: base.id.startsWith("heldout-")
          ? "heldout-warm"
          : base.id.startsWith("near-end-")
            ? "near-end"
            : !base.id.includes("-warm-")
              ? "cold-regression"
              : "dev-warm",
        arms,
        diagnostics,
      };
    }),
  );
  function arm(row: (typeof rows)[number], name: string) {
    const value = row.arms[name];
    if (!value) throw new Error(`Missing arm ${name}`);
    return value;
  }
  // Select fixed comparator only on development warm cases, then freeze on heldout.
  const frozenFixed = Object.fromEntries(
    profiles.map((p) => {
      const dev = rows.filter((r) => r.profile === p.id && r.suite === "dev-warm");
      const choices = ["fixed50", "fixed60", "fixed70"].map((name) => ({
        name,
        cost: dev.reduce((a, r) => a + arm(r, name).cost, 0),
      }));
      choices.sort((a, b) => a.cost - b.cost);
      return [p.id, choices[0]?.name ?? "fixed60"];
    }),
  );
  const summary = profiles.flatMap((p) =>
    ["dev-warm", "dev-warm-long", "heldout-warm", "near-end", "cold-regression"].flatMap((suite) =>
      [
        "renewalStrict",
        "renewalWeighted",
        ...(experiment ? ["geometric256", "durationMixture"] : []),
      ].flatMap((candidate) =>
        ["fixed60", "frozenFixed", "legacy"].map((baseline) => {
          const selected = rows.filter(
            (r) =>
              r.profile === p.id &&
              (suite === "dev-warm-long"
                ? r.suite === "dev-warm" && r.calls === 140
                : r.suite === suite),
          );
          const comparator =
            baseline === "frozenFixed" ? (frozenFixed[p.id] ?? "fixed60") : baseline;
          const compared = selected.filter(
            (r) => arm(r, candidate).attempts > 0 || arm(r, comparator).attempts > 0,
          );
          const ds = compared.map((r) => arm(r, candidate).cost / arm(r, comparator).cost - 1);
          return {
            profile: p.id,
            suite,
            candidate,
            baseline,
            comparator,
            cases: selected.length,
            compared: compared.length,
            excluded: selected.length - compared.length,
            wins: ds.filter((d) => d < -1e-9).length,
            losses: ds.filter((d) => d > 1e-9).length,
            ties: ds.filter((d) => Math.abs(d) <= 1e-9).length,
            mean: ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : null,
            worst: ds.length ? Math.max(...ds) : null,
            attempts: selected.reduce((a, r) => a + arm(r, candidate).attempts, 0),
            overflow: selected.reduce((a, r) => a + arm(r, candidate).overflow, 0),
          };
        }),
      ),
    ),
  );
  return {
    kind: "foldpoint.warm-renewal.v1",
    paidCalls: 0,
    casesPerProfile: cases.length,
    profiles,
    frozenFixed,
    policy: { q: 0.95, stressQ: 0.9, boundaries: 16, maxCalls: 64 },
    limitations: [
      "实验 API 显式 opt-in，核心/Pi 默认未改；ending-risk 是预计的即时结束损失，不是最大损失承诺，也不评估所有结束时刻的累计后悔。",
      "NOW/WAIT 使用同一重复边界族；NOW 的压力评估保持其名义最优边界，不在压力模型下重新挑更有利策略。每轮仍重新优化，非完整自递归未来策略。",
      "开发场景已用于设计。heldout 仅是首次运行的新 seed/长度/增长/保留率组合，不是独立真实任务；禁止依据留出成绩反复调参后继续称其盲测。",
      "冷缓存仅小型回归；预测使用共同比例缓存模型，不是真实供应商完整计费，无真实模型/压缩质量验证。",
      "未来经济触发预测采用风险门，但未模拟全部宿主冷却和资格门；q 和缓存存活预测仍可能错误。",
      "没有 endpoint、真实保留率或测试策略编号输入算法；无压缩双方排除胜负但保留。旧报告不改。",
    ],
    summary,
    rows,
  };
}

export function renderWarm(report: ReturnType<typeof warmRenewalReport>) {
  return [
    "# 暖缓存多周期成本比较（零付费）",
    "",
    "负数为更省。严格门与结束概率加权门分开；所有价格用相同参数。固定对照只从开发集选择后冻结。",
    "",
    "| 价格 | 分组 | 分支 | 对照 | 胜/负/平 | 平均变化 | 最差变化 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.summary
      .filter(
        (s) =>
          ["dev-warm-long", "heldout-warm", "near-end", "cold-regression"].includes(s.suite) &&
          s.candidate === "renewalWeighted" &&
          s.baseline !== "legacy",
      )
      .map(
        (s) =>
          `| ${s.profile} | ${s.suite} | ${s.candidate} | ${s.baseline}/${s.comparator} | ${s.wins}/${s.losses}/${s.ties} | ${s.mean === null ? "—" : `${(s.mean * 100).toFixed(2)}%`} | ${s.worst === null ? "—" : `${(s.worst * 100).toFixed(2)}%`} |`,
      ),
    "",
    "## 限制",
    "",
    ...report.limitations.map((s) => `- ${s}`),
    "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = warmRenewalReport();
  const path = fileURLToPath(new URL("./reports/warm-renewal.json", import.meta.url));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("../node_modules/@biomejs/biome/bin/biome", import.meta.url)),
      "format",
      "--write",
      path,
    ],
    { stdio: "pipe" },
  );
  writeFileSync(new URL("./warm-renewal.md", import.meta.url), renderWarm(report));
  console.log(
    JSON.stringify(
      report.summary.filter((s) => s.suite === "dev-warm-long" && s.baseline === "fixed60"),
      null,
      2,
    ),
  );
}
