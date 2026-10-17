/** Nominal full-bill laboratory wiring. Never promotes approximate feedback to SDK calibration. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compactorCases } from "../benchmarks/compactor-model";
import { CYCLE_CONTRACTS } from "../benchmarks/cycle-reference";
import { DURATION_PRIOR } from "../benchmarks/duration-mixture";
import { createRawFixedThresholdStrategy, type Strategy } from "../benchmarks/fixed-threshold";
import { PRICE_PROFILES } from "../benchmarks/provider-ratios";
import type { Scenario } from "../benchmarks/scenarios";
import { createFoldPointStrategy, runSession } from "../benchmarks/simulator";
import { type CompactorTokenModel, resolveUnitPrices } from "../src/index";
import { assertHoldoutCandidate, sourceHash } from "./affine-holdout";
import { type ApproximateFeedback, ApproximateRetentionTracker } from "./approximate-feedback";
import { assertFeedbackSource } from "./feedback-prequential";
import { UncertainAffineFeedback } from "./uncertain-affine-feedback";

export const COST_PLAN = JSON.parse(
  readFileSync(new URL("../benchmarks/affine-cost-plan.json", import.meta.url), "utf8"),
) as {
  profiles: string[];
  fixtures: string[];
  mainLengths: number[];
  seed: number;
  shortLength: number;
  sensitivityLength: number;
  contracts: string[];
  failureSensitivity: number;
  feedback: { errorFraction: number; noiseFraction: number };
};
export function affineCostCases() {
  const cases: { profile: string; fixture: string; suite: string; scenario: Scenario }[] = [];
  for (const profile of COST_PLAN.profiles)
    for (const fixture of COST_PLAN.fixtures) {
      const base = compactorCases().find((c) => c.id === fixture);
      const p = PRICE_PROFILES.find((p) => p.id === profile);
      if (!base || !p) throw new Error("missing frozen component");
      const add = (suite: string, steps: number, contract: string, failed = false) => {
        const billing = CYCLE_CONTRACTS.find((c) => c.id === contract);
        if (!billing) throw new Error("missing billing contract");
        cases.push({
          profile,
          fixture,
          suite,
          scenario: {
            ...base,
            id: `affine-cost-${cases.length}`,
            seed: COST_PLAN.seed,
            steps,
            pricing: p.pricing,
            cycleBilling: { ...billing.billing },
            hostHorizon: undefined,
            compactor: {
              ...base.compactor,
              successRate: failed ? COST_PLAN.failureSensitivity : 1,
            },
          },
        });
      };
      for (const steps of COST_PLAN.mainLengths) add("main", steps, "summary-uncached");
      add("short", COST_PLAN.shortLength, "summary-uncached");
      if (fixture === COST_PLAN.fixtures[0]) {
        add("prewarm", COST_PLAN.sensitivityLength, "hypothetical-shared-80-prewarm-1");
        add("failure", COST_PLAN.sensitivityLength, "summary-uncached", true);
      }
    }
  return cases;
}

export function hostFeedback(
  e: Parameters<NonNullable<Strategy["onCompaction"]>>[0],
  sequence: number,
): ApproximateFeedback {
  // Same deterministic error rule per attempted summary in every independent branch; no outcome RNG.
  const u = ((Math.imul(sequence, 1103515245) + COST_PLAN.seed) >>> 0) / 2 ** 32;
  const after = e.success
    ? Math.round(e.afterTokens * (1 + COST_PLAN.feedback.noiseFraction * (2 * u - 1)))
    : e.beforeTokens;
  return {
    basisKey: "cost-host/v1",
    sequence,
    source: "host-immediate",
    success: e.success,
    beforeTokens: e.beforeTokens,
    afterTokens: after,
    beforeErrorTokens: Math.ceil(e.beforeTokens * COST_PLAN.feedback.errorFraction),
    afterErrorTokens: Math.ceil(after * COST_PLAN.feedback.errorFraction),
  };
}

export function createApproximateCostStrategy(
  scenario: Scenario,
  arm: "approximateEma" | "uncertainAffine",
) {
  const learner =
    arm === "approximateEma"
      ? new ApproximateRetentionTracker("cost-host/v1")
      : new UncertainAffineFeedback("cost-host/v1");
  let outputRatio = 0.002;
  let attempts = 0;
  let currentModel: CompactorTokenModel;
  let issuedAfter = 0;
  let fitted = 0;
  let fallback = 0;
  const predictionErrors: number[] = [];
  const observations: ApproximateFeedback[] = [];
  const modelAt = (before: number): CompactorTokenModel => {
    const point = learner.predict(before)?.pointTokens ?? before * 0.1;
    const state = learner.snapshot();
    const fit = learner instanceof UncertainAffineFeedback ? learner.snapshot().model : null;
    if (fit) fitted++;
    else fallback++;
    issuedAfter = point;
    return {
      after: { slope: fit?.slope ?? point / before, intercept: fit?.floor ?? 0, residual: 0 },
      output: { slope: outputRatio, intercept: 0, residual: 0 },
      samples: state.acceptedApproximate,
      minBefore: fit?.minBefore ?? before,
      maxBefore: fit?.maxBefore ?? before,
      summaryInputCostPerToken: resolveUnitPrices(scenario.pricing).inputPerToken,
    };
  };
  // Existing forecast injection point; simulator/core source and billing stay untouched.
  const runtime = {
    continuationProbability: 0.95,
    maxImmediateLossRatio: 1,
    maxCalls: 256,
    rolloutMode: "renewal" as const,
    endingRiskMode: "survival-weighted" as const,
    endingLossBudgetRatio: 1,
    savingMarginBasis: "timing" as const,
    durationModel: { completedCalls: 0, components: DURATION_PRIOR },
    cycleBilling: scenario.cycleBilling,
    stressWaitSelection: "paired-policy" as const,
    futureQualification: { maxChecksPerPath: 2 },
    get compactorTokenModel() {
      return currentModel;
    },
  };
  const base = createFoldPointStrategy(scenario, {
    omitRequestCacheEvidence: true,
    verifiedAppendOnlyPrefix: true,
    enforceForecastExecutionGates: true,
    defaults: { compactOutputRatio: 0.002 },
    runtimeSurvival: runtime,
  });
  const strategy: Strategy = {
    ...base,
    id: arm,
    label: arm,
    decide(request) {
      currentModel = modelAt(request.contextTokens);
      return base.decide(request);
    },
    onCompaction(e) {
      const feedback = hostFeedback(e, ++attempts);
      observations.push(feedback);
      learner.observe(feedback);
      if (e.success) {
        // Evaluator-only error; never supplied to the predictor.
        predictionErrors.push(Math.abs(issuedAfter - e.afterTokens));
        const ratio = e.outputTokens / e.beforeTokens;
        outputRatio += 0.25 * (ratio - outputRatio);
      }
      // The common core also gets only host-estimated after size, not precise simulator truth.
      base.onCompaction?.({ ...e, afterTokens: feedback.afterTokens });
    },
  };
  return {
    strategy,
    diagnostic: () => ({
      fittedDecisions: fitted,
      fallbackDecisions: fallback,
      observations,
      summaryPredictionMae: predictionErrors.length
        ? predictionErrors.reduce((a, b) => a + b, 0) / predictionErrors.length
        : null,
      exactSamples: learner.snapshot().exactSamples,
      laboratoryOnly: true,
    }),
  };
}

export function costLedger(scenario: Scenario, strategy: Strategy) {
  let overWindowSummaryCalls = 0,
    overWindowOrdinaryCalls = 0,
    overWindowPrewarmCalls = 0;
  let ordinary = 0,
    summary = 0,
    prewarm = 0,
    ordinaryCalls = 0,
    summaryCalls = 0,
    prewarmCalls = 0,
    failed = 0;
  const run = runSession(scenario, {
    ...strategy,
    onRequest(e) {
      if (e.promptTokens > scenario.contextWindowTokens) overWindowOrdinaryCalls++;
      ordinary += e.cost;
      ordinaryCalls++;
      strategy.onRequest?.(e);
    },
    onCompaction(e) {
      if (e.beforeTokens > scenario.contextWindowTokens) overWindowSummaryCalls++;
      summary += e.cost;
      summaryCalls++;
      if (!e.success) failed++;
      strategy.onCompaction?.(e);
    },
    onPrewarm(e) {
      if (e.promptTokens > scenario.contextWindowTokens) overWindowPrewarmCalls++;
      prewarm += e.cost;
      prewarmCalls++;
      strategy.onPrewarm?.(e);
    },
  });
  if (
    Math.abs(ordinary + summary + prewarm - run.metrics.totalSimulatedCost) > 1e-8 ||
    run.metrics.overflowRecoveryCount
  )
    throw new Error("Full bill does not reconcile or overflow recovery is unaccounted");
  return {
    cost: run.metrics.totalSimulatedCost,
    overWindowSummaryCalls,
    overWindowOrdinaryCalls,
    overWindowPrewarmCalls,
    inputWithinWindow:
      overWindowSummaryCalls + overWindowOrdinaryCalls + overWindowPrewarmCalls === 0,
    ordinary,
    summary,
    prewarm,
    ordinaryCalls,
    summaryCalls,
    prewarmCalls,
    totalCalls: ordinaryCalls + summaryCalls + prewarmCalls,
    failed,
    overflow: run.metrics.overflowCount,
    fingerprint: run.metrics.growthSequenceFingerprint,
    compactions: run.compactions.map((c) => ({
      step: c.step,
      before: c.beforeTokens,
      after: c.afterTokens,
      success: c.success,
      cost: c.attemptCost,
    })),
  };
}

export function executeAffineCost(c: ReturnType<typeof affineCostCases>[number]) {
  if (c.scenario.hostHorizon !== undefined) throw new Error("No endpoint oracle allowed");
  const approximate = createApproximateCostStrategy(c.scenario, "approximateEma");
  const affine = createApproximateCostStrategy(c.scenario, "uncertainAffine");
  const arms = {
    fixed60: costLedger(c.scenario, createRawFixedThresholdStrategy(0.6)),
    nativeThresholdProxy: costLedger(
      c.scenario,
      createRawFixedThresholdStrategy(1 - 16384 / c.scenario.contextWindowTokens),
    ),
    approximateEma: costLedger(c.scenario, approximate.strategy),
    uncertainAffine: costLedger(c.scenario, affine.strategy),
  };
  if (new Set(Object.values(arms).map((a) => a.fingerprint)).size !== 1)
    throw new Error("Growth streams diverged");
  return {
    profile: c.profile,
    fixture: c.fixture,
    suite: c.suite,
    steps: c.scenario.steps,
    arms,
    diagnostics: { approximateEma: approximate.diagnostic(), uncertainAffine: affine.diagnostic() },
  };
}

export function buildAffineCostReport(rows: ReturnType<typeof executeAffineCost>[]) {
  return {
    runner: "foldpoint.affine-cost.v1",
    paidCalls: 0,
    planCommit: "6a9e485",
    candidateCommit: "3fc64c4",
    sourceHashes: Object.fromEntries(
      [
        "tools/affine-cost.ts",
        "benchmarks/affine-cost-plan.json",
        "tools/uncertain-affine-feedback.ts",
        "tools/approximate-feedback.ts",
        "benchmarks/simulator.ts",
        "src/experimental-runtime.ts",
        "src/experimental-cycle.ts",
        "src/pricing.ts",
        "src/defaults.ts",
      ].map((p) => [p, sourceHash(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"))]),
    ),
    rows,
    groups: [...new Set(rows.map((r) => `${r.profile}/${r.suite}`))].map((key) => {
      const selected = rows.filter((r) => `${r.profile}/${r.suite}` === key);
      const nativeComparable = selected.filter(
        (r) =>
          r.arms.nativeThresholdProxy.inputWithinWindow && r.arms.uncertainAffine.inputWithinWindow,
      );
      return {
        key,
        cases: selected.length,
        meanVsEma:
          selected.reduce(
            (s, r) => s + r.arms.uncertainAffine.cost / r.arms.approximateEma.cost - 1,
            0,
          ) / selected.length,
        meanVsFixed60:
          selected.reduce((s, r) => s + r.arms.uncertainAffine.cost / r.arms.fixed60.cost - 1, 0) /
          selected.length,
        meanVsNativeProxy: nativeComparable.length
          ? nativeComparable.reduce(
              (s, r) => s + r.arms.uncertainAffine.cost / r.arms.nativeThresholdProxy.cost - 1,
              0,
            ) / nativeComparable.length
          : null,
        nativeComparable: nativeComparable.length,
      };
    }),
  };
}

export function renderAffineCost(r: ReturnType<typeof buildAffineCostReport>) {
  const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(2)}%`);
  return [
    "# 近似体积预测的完整费用接线实验",
    "",
    "先冻结计划 6a9e485；候选固定在 3fc64c4。纯离线、付费调用0；不读取API key。价格沿用仓库冻结表，不是当前报价或真实账单。",
    "",
    "| 冻结价格/分组 | 场景数 | 新候选相对旧近似EMA | 相对固定60% | 相对原生阈值代理 |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...r.groups.map(
      (g) =>
        `| ${g.key} | ${g.cases} | ${pct(g.meanVsEma)} | ${pct(g.meanVsFixed60)} | ${pct(g.meanVsNativeProxy)} (${g.nativeComparable}/${g.cases}) |`,
    ),
    "",
    "负值表示新候选费用更低；每场景先计算比例，再等权平均。不同分组不混为总体节费率。",
    "原生阈值代理若出现超过窗口的输入，费用只保留为诊断，不进入费用优势比较；括号为可比数/分组总数。窗口内也不代表真实Pi质量或输出预算合格。",
    "",
    "## 逐场景完整费用",
    "",
    "| 价格 | 分组 | fixture | 长度 | 固定60% | 原生阈值代理 | 旧近似EMA | 新候选 | 新候选摘要/失败/预热调用 | 拟合/回退决策 |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...r.rows.map(
      (v) =>
        `| ${v.profile} | ${v.suite} | ${v.fixture} | ${v.steps} | ${v.arms.fixed60.cost.toFixed(6)} | ${v.arms.nativeThresholdProxy.cost.toFixed(6)}${v.arms.nativeThresholdProxy.inputWithinWindow ? "" : "†"} | ${v.arms.approximateEma.cost.toFixed(6)} | ${v.arms.uncertainAffine.cost.toFixed(6)} | ${v.arms.uncertainAffine.summaryCalls}/${v.arms.uncertainAffine.failed}/${v.arms.uncertainAffine.prewarmCalls} | ${v.diagnostics.uncertainAffine.fittedDecisions}/${v.diagnostics.uncertainAffine.fallbackDecisions} |`,
    ),
    "",
    "## 接线与限制",
    "",
    "- † 表示该代理分支存在输入超窗，仅保留费用诊断。原始JSON分别列普通/摘要/预热超窗调用数；不会用模拟器的overflow=0掩盖超窗摘要输入。",
    "- 复用的费用模拟器实际保留长度为max(固定下限, 比例×输入)，不是上一轮预测留出集的底座+比例生成式；控制器不知道真实下限。",
    "- 两组动态策略复用同一控制器、剩余调用数先验、执行限制和压力规则。无兼容历史；首次请求建立缓存，其余请求在TTL内。只替换after-size预测器，摘要输出预测均为同一EMA。",
    "- 每条分支独立运行、接收自己实际压缩后按同一误差规则生成的估算；预测先于反馈。估算不会写入精确学习器，exactSamples仍为0。增长序列指纹逐组一致。",
    "- 这是显式的名义接线实验：两边拟合残差都为0，不把宽误差范围转换为置信区间；控制器原有压力不变。并非完整不确定性决策，也不是生产可用性授权。",
    "- 普通输入/输出、摘要调用（包括失败）、缓存重建、独立预热请求全部计入分支账单，逐分支对账；无训练采集费用，因为没有预训练。",
    "- 原生阈值代理只使用window−16384作为触发点，不执行真实Pi、输出上限或质量检查；不能宣传为击败真实Pi。固定60%为raw基线，没有套动态70%上限。",
    "- 主表仅两种已见fixture、一个种子、120/240调用；另列4调用负对照和失败/共享摘要+预热敏感性。场景相关、样本小，不是独立泛化证明。",
    "- 模拟摘要成功不代表信息保真。默认核心、Pi插件和冻结候选均未修改；没有真实任务质量或当前供应商费用结论。",
    "",
  ].join("\n");
}

export function assertAffineCostSources() {
  if (
    sourceHash(
      readFileSync(new URL("../benchmarks/affine-cost-plan.json", import.meta.url), "utf8"),
    ) !== "3d88e95d91ebc25ca71b740d265a2941f8d15fdda0621e06537fa46743bc75cd"
  )
    throw new Error("Frozen full-bill plan changed");
  assertHoldoutCandidate(
    readFileSync(new URL("./uncertain-affine-feedback.ts", import.meta.url), "utf8"),
  );
  assertFeedbackSource(readFileSync(new URL("./approximate-feedback.ts", import.meta.url), "utf8"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertAffineCostSources();
  const cases = affineCostCases();
  if (process.argv[2] === "--case" && process.argv.length === 4) {
    const c = cases[Number(process.argv[3])];
    if (!c) throw new Error("unknown case");
    console.log(JSON.stringify(executeAffineCost(c)));
  } else {
    if (process.argv.length !== 2)
      throw new Error("usage: tsx tools/affine-cost.ts [--case index]");
    const rows = cases.map((c, i) => {
      const row = executeAffineCost(c);
      console.error(`${i + 1}/${cases.length} ${c.profile}/${c.suite}`);
      return row;
    });
    const r = buildAffineCostReport(rows);
    writeFileSync(
      new URL("../benchmarks/reports/affine-cost.json", import.meta.url),
      `${JSON.stringify(r, null, 2)}\n`,
    );
    writeFileSync(new URL("../benchmarks/affine-cost.md", import.meta.url), renderAffineCost(r));
    console.log(JSON.stringify(r.groups, null, 2));
  }
}
