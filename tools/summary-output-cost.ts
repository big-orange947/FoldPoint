/** Output-only ablation. The frozen after-size learner, controller and full bill are unchanged. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DURATION_PRIOR } from "../benchmarks/duration-mixture";
import { createRawFixedThresholdStrategy, type Strategy } from "../benchmarks/fixed-threshold";
import type { Scenario } from "../benchmarks/scenarios";
import { createFoldPointStrategy } from "../benchmarks/simulator";
import { type CompactorTokenModel, resolveUnitPrices } from "../src/index";
import {
  affineCostCases,
  assertAffineCostSources,
  type buildAffineCostReport,
  costLedger,
  hostFeedback,
} from "./affine-cost";
import { sourceHash } from "./affine-holdout";
import { SummaryOutputLearner } from "./summary-output";
import { UncertainAffineFeedback } from "./uncertain-affine-feedback";

export function createOutputCostStrategy(scenario: Scenario, affineOutput: boolean) {
  const afterLearner = new UncertainAffineFeedback("cost-host/v1");
  const outputLearner = new SummaryOutputLearner("output-host/v1");
  let attempts = 0;
  let model: CompactorTokenModel;
  let predictedOutput = 0;
  let source = "ratio-prior";
  const usage: {
    sequence: number;
    before: number;
    predictedOutput: number;
    actualOutput: number;
    success: boolean;
    source: string;
  }[] = [];
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
      return model;
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
    id: affineOutput ? "affine-output" : "legacy-output",
    decide(r) {
      const point = afterLearner.predict(r.contextTokens)?.pointTokens ?? r.contextTokens * 0.1;
      const state = afterLearner.snapshot();
      const fit = state.model;
      const output = outputLearner.snapshot();
      const slope = affineOutput ? output.slope : output.legacyRatio;
      const intercept = affineOutput ? output.intercept : 0;
      source = affineOutput ? output.source : output.samples ? "ratio-ema" : "ratio-prior";
      predictedOutput = slope * r.contextTokens + intercept;
      model = {
        after: {
          slope: fit?.slope ?? point / r.contextTokens,
          intercept: fit?.floor ?? 0,
          residual: 0,
        },
        output: { slope, intercept, residual: 0 },
        samples: state.acceptedApproximate,
        minBefore: fit?.minBefore ?? r.contextTokens,
        maxBefore: fit?.maxBefore ?? r.contextTokens,
        summaryInputCostPerToken: resolveUnitPrices(scenario.pricing).inputPerToken,
      };
      return base.decide(r);
    },
    onCompaction(e) {
      const feedback = hostFeedback(e, ++attempts);
      usage.push({
        sequence: attempts,
        before: e.beforeTokens,
        predictedOutput,
        actualOutput: e.outputTokens,
        success: e.success,
        source,
      });
      afterLearner.observe(feedback);
      outputLearner.observe({
        sequence: attempts,
        beforeTokens: e.beforeTokens,
        beforeErrorTokens: feedback.beforeErrorTokens,
        outputTokens: e.outputTokens,
        success: e.success,
      });
      base.onCompaction?.({ ...e, afterTokens: feedback.afterTokens });
    },
  };
  return {
    strategy,
    diagnostic: () => ({ usage, outputModel: outputLearner.snapshot(), laboratoryOnly: true }),
  };
}

type Frozen = ReturnType<typeof buildAffineCostReport>;
export function evaluateOutputCost(
  c: ReturnType<typeof affineCostCases>[number],
  frozen: Frozen["rows"][number],
) {
  const legacy = createOutputCostStrategy(c.scenario, false);
  const candidate = createOutputCostStrategy(c.scenario, true);
  const arms = {
    fixed60: costLedger(c.scenario, createRawFixedThresholdStrategy(0.6)),
    legacyOutputRatio: costLedger(c.scenario, legacy.strategy),
    affineOutput: costLedger(c.scenario, candidate.strategy),
  };
  if (
    JSON.stringify(arms.legacyOutputRatio) !== JSON.stringify(frozen.arms.uncertainAffine) ||
    JSON.stringify(arms.fixed60) !== JSON.stringify(frozen.arms.fixed60)
  )
    throw new Error("Output-only baseline failed to reproduce frozen full bill");
  if (new Set(Object.values(arms).map((a) => a.fingerprint)).size !== 1)
    throw new Error("Growth stream mismatch");
  // Common, already executed legacy attempt stream: predict first, reveal only reported output next.
  const observer = new SummaryOutputLearner("common-output/v1");
  let legacyError = 0,
    affineError = 0,
    scored = 0;
  const legacyDiagnostic = legacy.diagnostic();
  for (const e of legacyDiagnostic.usage) {
    const prediction = observer.predict(e.before);
    if (e.success) {
      legacyError += Math.abs(e.predictedOutput - e.actualOutput);
      affineError += Math.abs(prediction.outputTokens - e.actualOutput);
      scored++;
    }
    observer.observe({
      sequence: e.sequence,
      beforeTokens: e.before,
      beforeErrorTokens: Math.ceil(e.before * 0.12),
      outputTokens: e.actualOutput,
      success: e.success,
    });
  }
  return {
    profile: c.profile,
    fixture: c.fixture,
    suite: c.suite,
    steps: c.scenario.steps,
    baselineMatches: true,
    arms,
    commonAttemptPrediction: {
      samples: scored,
      legacyMae: scored ? legacyError / scored : null,
      affineMae: scored ? affineError / scored : null,
    },
    diagnostics: { legacy: legacyDiagnostic, candidate: candidate.diagnostic() },
  };
}

export function buildOutputCostReport(rows: ReturnType<typeof evaluateOutputCost>[]) {
  return {
    runner: "foldpoint.summary-output-cost.v1",
    paidCalls: 0,
    planCommit: "8960876",
    baselineCommit: "349c182",
    sourceHashes: Object.fromEntries(
      [
        "tools/summary-output.ts",
        "tools/summary-output-cost.ts",
        "benchmarks/summary-output-plan.json",
      ].map((p) => [p, sourceHash(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"))]),
    ),
    rows,
    groups: [...new Set(rows.map((r) => `${r.profile}/${r.suite}`))].map((key) => {
      const selected = rows.filter((r) => `${r.profile}/${r.suite}` === key);
      const delta = (r: (typeof rows)[number]) =>
        r.arms.affineOutput.cost / r.arms.legacyOutputRatio.cost - 1;
      return {
        key,
        cases: selected.length,
        meanVsLegacy: selected.reduce((s, r) => s + delta(r), 0) / selected.length,
        meanVsFixed60:
          selected.reduce((s, r) => s + r.arms.affineOutput.cost / r.arms.fixed60.cost - 1, 0) /
          selected.length,
        wins: selected.filter((r) => delta(r) < -1e-9).length,
        losses: selected.filter((r) => delta(r) > 1e-9).length,
      };
    }),
  };
}

export function renderOutputCostReport(r: ReturnType<typeof buildOutputCostReport>) {
  return [
    "# 独立摘要输出模型：完整账单消融",
    "",
    "计划8960876先冻结，再执行原24个场景。只更换摘要输出预测：after-size、控制器、价格、缓存契约和费用计算不变。付费调用0。旧动态分支和固定60%均重新执行，逐项复现旧账单。",
    "",
    "| 冻结价格/分组 | 数量 | 相对旧输出模型 | 相对固定60% | 对旧输出模型胜/负/平 |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...r.groups.map(
      (g) =>
        `| ${g.key} | ${g.cases} | ${(g.meanVsLegacy * 100).toFixed(2)}% | ${(g.meanVsFixed60 * 100).toFixed(2)}% | ${g.wins}/${g.losses}/${g.cases - g.wins - g.losses} |`,
    ),
    "",
    "负数便宜，正数更贵；逐场景费用比例等权平均，分组不混为总体收益。",
    "",
    "| 价格 | 分组 | fixture | 调用数 | 固定60% | 旧输出模型 | 新输出模型 | 新摘要/失败/预热调用 | 共同旧尝试流输出MAE：旧→新 |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...r.rows.map(
      (v) =>
        `| ${v.profile} | ${v.suite} | ${v.fixture} | ${v.steps} | ${v.arms.fixed60.cost.toFixed(6)} | ${v.arms.legacyOutputRatio.cost.toFixed(6)} | ${v.arms.affineOutput.cost.toFixed(6)} | ${v.arms.affineOutput.summaryCalls}/${v.arms.affineOutput.failed}/${v.arms.affineOutput.prewarmCalls} | ${v.commonAttemptPrediction.legacyMae?.toFixed(1) ?? "—"}→${v.commonAttemptPrediction.affineMae?.toFixed(1) ?? "—"} (${v.commonAttemptPrediction.samples}) |`,
    ),
    "",
    "## 方法与限制",
    "",
    "- 新输出模型学习非负固定量＋非负比例，复用冻结拟合器（32条、alpha=.25、至少3个成功样本且输入跨度20%）。不足时保留原0.002先验与比例EMA，未硬编码2000或模型名称。",
    "- 输入是宿主估算长度，输出是摘要调用返回的usage；两者不混成压缩后上下文长度。失败尝试计费但不当作成功输出样本，未知用量仍需由真实接入层拒绝。",
    "- 共同旧尝试流的预测评分先预测再揭晓结果，冷启动也计分；在线费用分支独立演化，不能把不同分支各自MAE直接当同分母比较。",
    "- 现有费用场景均带最低输出量，容易有利于固定项模型；这些是已见的合成回归，不能当作真实摘要器或新留出验证。另有纯比例、混合、零输出、漂移和窄跨度单元检查；没有按结果选算法。",
    "- 只比较名义预测，拟合残差仍为0，不把宿主误差假设变成精确置信度；默认核心和Pi未切换。",
    "- 首次请求、摘要输入输出、失败、压缩后新前缀写入和独立预热均保留计费。预热已经写入时，普通请求只读新前缀，不重复写入。未扩展长期冷缓存场景。",
    "- 摘要调用与新前缀建立不是同一次请求的同一计费项；摘要生成的内容并不自动证明后续请求的完整前缀已命中缓存。这里沿用显式模拟契约，不是供应商缓存行为的实测。",
    "- 冻结价格不是当前报价；无真实任务质量、供应商账单或普遍节费结论。",
    "",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("usage: tsx tools/summary-output-cost.ts");
  assertAffineCostSources();
  const raw = readFileSync(
    new URL("../benchmarks/reports/affine-cost.json", import.meta.url),
    "utf8",
  );
  if (sourceHash(raw) !== "5c41a55c7a031b49a99401b2fa2fc609b390752363bde3749d7760545c1f953c")
    throw new Error("Frozen bill report changed");
  const frozen = JSON.parse(raw) as Frozen;
  for (const [p, hash] of Object.entries(frozen.sourceHashes))
    if (sourceHash(readFileSync(new URL(`../${p}`, import.meta.url), "utf8")) !== hash)
      throw new Error(`Frozen source changed: ${p}`);
  const rows = affineCostCases().map((c, i) => {
    const old = frozen.rows.find(
      (r) =>
        r.profile === c.profile &&
        r.fixture === c.fixture &&
        r.suite === c.suite &&
        r.steps === c.scenario.steps,
    );
    if (!old) throw new Error("Missing frozen row");
    const row = evaluateOutputCost(c, old);
    console.error(`${i + 1}/24 ${c.profile}/${c.suite}`);
    return row;
  });
  const report = buildOutputCostReport(rows);
  writeFileSync(
    new URL("../benchmarks/reports/summary-output-cost.json", import.meta.url),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync(
    new URL("../benchmarks/summary-output-cost.md", import.meta.url),
    renderOutputCostReport(report),
  );
  console.log(JSON.stringify(report.groups, null, 2));
}
