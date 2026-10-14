/** Full offline replication of frozen 8c054cc; never reads a provider or API key. */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DURATION_PRIOR } from "../benchmarks/duration-mixture";
import { createRawFixedThresholdStrategy, type Strategy } from "../benchmarks/fixed-threshold";
import type { buildReplicationReport } from "../benchmarks/future-replication";
import { collectCompactorHistory } from "../benchmarks/history-reuse";
import { buildGrowthSequence, fingerprintSequence, type Scenario } from "../benchmarks/scenarios";
import { createFoldPointStrategy, runSession } from "../benchmarks/simulator";
import {
  type buildWarmLengthReport,
  WARM_LENGTH_MANIFEST,
  warmLengthCases,
} from "../benchmarks/warm-length-seed";
import type { CompactorModelAvailability, RuntimeSurvivalEstimate } from "../src/index";

const root = fileURLToPath(new URL("../", import.meta.url));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const baselineRaw = readFileSync(
  resolve(root, "benchmarks/reports/future-replication.json"),
  "utf8",
);
const baseline = JSON.parse(baselineRaw) as ReturnType<typeof buildReplicationReport>;
const warmRaw = readFileSync(resolve(root, "benchmarks/reports/warm-length-seed.json"), "utf8");
const warm = JSON.parse(warmRaw) as ReturnType<typeof buildWarmLengthReport>;
const targetedRaw = readFileSync(resolve(root, "benchmarks/reports/model-recovery.json"), "utf8");
const targeted = JSON.parse(targetedRaw) as {
  rows: {
    profile: string;
    sourceFixture: string;
    seed: number;
    steps: number;
    candidate: unknown;
    modelUsage: unknown;
  }[];
};
export const RECOVERY_MATRIX_MANIFEST = {
  version: "foldpoint.recovery-matrix.v1",
  candidateCommit: "8c054cc",
  profiles: WARM_LENGTH_MANIFEST.profiles,
  fixtures: WARM_LENGTH_MANIFEST.sourceFixtures,
  seeds: [151, 919, 2027],
  lengths: [120, 240, 360],
  shortLengths: [1, 4, 12],
  mainCases: 252,
  shortCases: 63,
  checkpointCalls: [0, 20, 60, 100],
  execution: "all-candidate-and-fixed60-arms-executed-no-result-reuse",
} as const;
type Identity = { profile: string; sourceFixture: string; seed: number; steps: number };
const id = (r: Identity) => `${r.profile}/${r.sourceFixture}/${r.seed}/${r.steps}`;
export function recoveryMatrixCases() {
  const main = warmLengthCases()
    .filter((c) => c.suite === "main")
    .map((c) => ({ ...c, suite: "main" as const }));
  const short = RECOVERY_MATRIX_MANIFEST.profiles.flatMap((profile) =>
    RECOVERY_MATRIX_MANIFEST.seeds.flatMap((seed) =>
      RECOVERY_MATRIX_MANIFEST.shortLengths.map((steps) => {
        const c = main.find(
          (r) =>
            r.profile === profile &&
            r.seed === seed &&
            r.sourceFixture === RECOVERY_MATRIX_MANIFEST.fixtures[0],
        );
        if (!c) throw new Error("missing short source");
        return {
          ...c,
          suite: "short" as const,
          steps,
          scenario: { ...c.scenario, steps, startTokens: 500000 },
        };
      }),
    ),
  );
  return [...main, ...short];
}
function metadata() {
  const paths = [
    ...readdirSync(resolve(root, "src"))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `src/${f}`),
    ...readdirSync(resolve(root, "benchmarks"))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `benchmarks/${f}`),
    "package-lock.json",
    "benchmarks/datasets/warm-length-seed-v1.json",
  ];
  const sourceHashes = Object.fromEntries(
    paths.map((path) => {
      const current = readFileSync(resolve(root, path), "utf8").replace(/\r\n/g, "\n");
      const frozen = execFileSync("git", ["show", `8c054cc:${path}`], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 10000000,
      }).replace(/\r\n/g, "\n");
      if (current !== frozen) throw new Error(`frozen source changed: ${path}`);
      return [path, sha(current)];
    }),
  );
  const value = {
    manifest: RECOVERY_MATRIX_MANIFEST,
    sourceHashes,
    baselineSha256: sha(baselineRaw),
    warmSha256: sha(warmRaw),
    targetedSha256: sha(targetedRaw),
    harnessSha256: sha(readFileSync(fileURLToPath(import.meta.url), "utf8").replace(/\r\n/g, "\n")),
    nodeVersion: process.version,
  };
  return { ...value, key: sha(JSON.stringify(value)) };
}
function ledger(scenario: Scenario, strategy: Strategy) {
  let ordinaryCost = 0,
    summaryCost = 0,
    prewarmCost = 0,
    ordinaryCalls = 0,
    prewarmCalls = 0;
  const run = runSession(scenario, {
    ...strategy,
    onRequest(e) {
      ordinaryCost += e.cost;
      ordinaryCalls++;
      strategy.onRequest?.(e);
    },
    onCompaction(e) {
      summaryCost += e.cost;
      strategy.onCompaction?.(e);
    },
    onPrewarm(e) {
      prewarmCost += e.cost;
      prewarmCalls++;
      strategy.onPrewarm?.(e);
    },
  });
  if (
    Math.abs(run.metrics.totalSimulatedCost - ordinaryCost - summaryCost - prewarmCost) > 1e-8 ||
    run.metrics.overflowRecoveryCount
  )
    throw new Error("full fee ledger mismatch");
  return {
    cost: run.metrics.totalSimulatedCost,
    ordinaryCost,
    summaryCost,
    prewarmCost,
    ordinaryCalls,
    summaryCalls: run.metrics.compactionAttemptCount,
    prewarmCalls,
    totalRequests: ordinaryCalls + run.metrics.compactionAttemptCount + prewarmCalls,
    overflow: run.metrics.overflowCount,
    forced: run.metrics.forcedAttemptCount,
    economic: run.metrics.economicAttemptCount,
    fingerprint: run.metrics.growthSequenceFingerprint,
    compactions: run.compactions.map((c) => ({
      step: c.step,
      action: c.action,
      success: c.success,
      beforeTokens: c.beforeTokens,
      afterTokens: c.afterTokens,
      summaryCost: c.attemptCost,
    })),
  };
}
export function executeRecoveryMatrixCase(c: ReturnType<typeof recoveryMatrixCases>[number]) {
  if (c.scenario.hostHorizon !== undefined) throw new Error("task endpoint must not reach policy");
  const history = collectCompactorHistory({ ...c.scenario, cycleBilling: undefined });
  const states: {
    step: number;
    source: CompactorModelAvailability["source"];
    reason: string;
    observationsSinceFit: number;
  }[] = [];
  let estimate: RuntimeSurvivalEstimate | undefined;
  const currentEstimate = (): RuntimeSurvivalEstimate | undefined => estimate;
  const checkpoints: {
    step: number;
    context: number;
    action: string;
    source: string;
    expectedSaving: number | null;
    stressedSaving: number | null;
    repeatBoundary: number | null;
  }[] = [];
  const base = createFoldPointStrategy(c.scenario, {
    learnedCompactorTokens: true,
    recoverCompactorModel: true,
    compactorHistory: history.observations,
    warmCoreFromHistory: true,
    enforceForecastExecutionGates: true,
    omitRequestCacheEvidence: true,
    verifiedAppendOnlyPrefix: true,
    defaults: { compactOutputRatio: 0.002 },
    runtimeSurvival: {
      continuationProbability: 0.95,
      maxImmediateLossRatio: 1,
      maxCalls: 256,
      rolloutMode: "renewal",
      endingRiskMode: "survival-weighted",
      endingLossBudgetRatio: 1,
      savingMarginBasis: "timing",
      durationModel: { completedCalls: 0, components: DURATION_PRIOR },
      cycleBilling: c.scenario.cycleBilling,
      stressWaitSelection: "paired-policy",
      futureQualification: { maxChecksPerPath: 2 },
    },
    onSurvivalEstimate: (e) => {
      estimate = e;
    },
    onCompactorAvailability: (s, step) =>
      states.push({
        step,
        source: s.source,
        reason: s.reason,
        observationsSinceFit: s.observationsSinceFit,
      }),
  });
  const fixed60 = ledger(c.scenario, createRawFixedThresholdStrategy(0.6));
  const candidate = ledger(c.scenario, {
    ...base,
    decide(request) {
      estimate = undefined;
      const decision = base.decide(request);
      const forecast = currentEstimate();
      const state = states.at(-1);
      if (!state || state.step !== request.step) throw new Error("missing model availability");
      if (state.source === "unavailable" && (forecast || decision.action === "COMPACT"))
        throw new Error("unavailable model approved economic forecast");
      if ((RECOVERY_MATRIX_MANIFEST.checkpointCalls as readonly number[]).includes(request.step))
        checkpoints.push({
          step: request.step,
          context: request.contextTokens,
          action: decision.action,
          source: state.source,
          expectedSaving: forecast?.expectedSaving ?? null,
          stressedSaving: forecast?.stressedSaving ?? null,
          repeatBoundary: forecast?.selectedRepeatBoundaryTokens ?? null,
        });
      return decision;
    },
  });
  const previous = baseline.rows.find((r) => id(r) === id(c));
  const oldControl = warm.rows.find((r) => r.suite === "main" && id(r) === id(c));
  let previousCost: number | null = null;
  if (c.suite === "main") {
    if (
      !oldControl ||
      JSON.stringify(fixed60) !== JSON.stringify(oldControl.fixed60) ||
      history.cost !== oldControl.historyCost
    )
      throw new Error("frozen fixed control changed");
    if (previous) {
      if (JSON.stringify(candidate) !== JSON.stringify(previous.candidate))
        throw new Error("previous successful candidate changed");
      previousCost = previous.candidate.cost;
    } else if (!baseline.failures.some((r) => id(r) === id(c)))
      throw new Error("unclassified previous case");
    const target = targeted.rows.find((r) => id(r) === id(c));
    if (target && JSON.stringify(candidate) !== JSON.stringify(target.candidate))
      throw new Error("targeted replay changed");
  } else {
    const old = baseline.short.find(
      (r) => r.profile === c.profile && r.seed === c.seed && r.steps === c.steps,
    );
    if (!old || old.candidateCost !== candidate.cost || old.fixed60Cost !== fixed60.cost)
      throw new Error("short regression changed");
    previousCost = old.candidateCost;
  }
  const growth = buildGrowthSequence(c.scenario);
  return {
    profile: c.profile,
    sourceFixture: c.sourceFixture,
    seed: c.seed,
    steps: c.steps,
    suite: c.suite,
    contextWindowTokens: c.scenario.contextWindowTokens,
    historyCost: history.cost,
    fixed60,
    candidate,
    vsFixed60: candidate.cost / fixed60.cost - 1,
    previousCost,
    previousFailureRepaired: c.suite === "main" && !previous,
    modelUsage: {
      fitted: states.filter((s) => s.source === "fitted").length,
      retained: states.filter((s) => s.source === "retained").length,
      unavailable: states.filter((s) => s.source === "unavailable").length,
      maxObservationsSinceFit: Math.max(...states.map((s) => s.observationsSinceFit)),
      nonFitted: states.filter((s) => s.source !== "fitted"),
    },
    checkpoints,
    growthPrefixes: RECOVERY_MATRIX_MANIFEST.lengths
      .filter((n) => n <= c.steps)
      .map((steps) => ({ steps, fingerprint: fingerprintSequence(growth.slice(0, steps)) })),
  };
}
type Row = ReturnType<typeof executeRecoveryMatrixCase>;
const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length;
function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] ?? null)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}
export function summarizeRecoveryMatrix(rows: Row[]) {
  return [...new Set(rows.map((r) => r.profile))].map((profile) => {
    const group = rows.filter((r) => r.profile === profile);
    const frequency = (arm: "candidate" | "fixed60") => {
      const compactions = group.flatMap((r) => r[arm].compactions);
      const intervals = group.flatMap((r) =>
        r[arm].compactions.slice(1).map((c, i) => c.step - (r[arm].compactions[i]?.step ?? 0)),
      );
      return {
        summaryCalls: compactions.length,
        ordinaryCalls: group.reduce((n, r) => n + r.steps, 0),
        medianSpacing: median(intervals),
        minSpacing: intervals.length ? Math.min(...intervals) : null,
        medianUtilization: median(
          group.flatMap((r) =>
            r[arm].compactions.map((c) => c.beforeTokens / r.contextWindowTokens),
          ),
        ),
      };
    };
    return {
      profile,
      cases: group.length,
      wins: group.filter((r) => r.vsFixed60 < -1e-9).length,
      losses: group.filter((r) => r.vsFixed60 > 1e-9).length,
      meanVsFixed60: mean(group.map((r) => r.vsFixed60)),
      worstVsFixed60: Math.max(...group.map((r) => r.vsFixed60)),
      pooledCostChange:
        group.reduce((n, r) => n + r.candidate.cost, 0) /
          group.reduce((n, r) => n + r.fixed60.cost, 0) -
        1,
      candidateFrequency: frequency("candidate"),
      fixedFrequency: frequency("fixed60"),
      meanOrdinaryDelta: mean(group.map((r) => r.candidate.ordinaryCost - r.fixed60.ordinaryCost)),
      meanSummaryDelta: mean(group.map((r) => r.candidate.summaryCost - r.fixed60.summaryCost)),
      retainedCalls: group.reduce((n, r) => n + r.modelUsage.retained, 0),
      unavailableCalls: group.reduce((n, r) => n + r.modelUsage.unavailable, 0),
    };
  });
}
export function recoveryMatrixPrefixAudits(rows: Row[]) {
  const main = rows.filter((r) => r.suite === "main");
  const groups = [...new Set(main.map((r) => `${r.profile}/${r.sourceFixture}/${r.seed}`))];
  return groups.flatMap((key) =>
    [120, 240].map((from) => {
      const short = main.find(
        (r) => `${r.profile}/${r.sourceFixture}/${r.seed}` === key && r.steps === from,
      );
      const long = main.find(
        (r) => `${r.profile}/${r.sourceFixture}/${r.seed}` === key && r.steps === from + 120,
      );
      if (!short || !long) throw new Error("missing prefix endpoint");
      if (
        short.growthPrefixes.find((p) => p.steps === from)?.fingerprint !==
        long.growthPrefixes.find((p) => p.steps === from)?.fingerprint
      )
        throw new Error("growth prefix changed");
      for (const arm of ["candidate", "fixed60"] as const)
        if (
          JSON.stringify(short[arm].compactions) !==
          JSON.stringify(long[arm].compactions.filter((c) => c.step < from))
        )
          throw new Error("action prefix changed");
      if (
        JSON.stringify(short.checkpoints) !==
        JSON.stringify(long.checkpoints.filter((c) => c.step < from))
      )
        throw new Error("checkpoint prefix changed");
      return {
        key,
        from,
        to: from + 120,
        status: "PASS",
        candidateIncrement: long.candidate.cost - short.candidate.cost,
        fixed60Increment: long.fixed60.cost - short.fixed60.cost,
      };
    }),
  );
}
export function buildRecoveryMatrixReport(rows: Row[], meta: ReturnType<typeof metadata>) {
  const expected = recoveryMatrixCases()
    .map((c) => `${c.suite}/${id(c)}`)
    .sort();
  if (
    JSON.stringify(meta.manifest) !== JSON.stringify(RECOVERY_MATRIX_MANIFEST) ||
    JSON.stringify(rows.map((r) => `${r.suite}/${id(r)}`).sort()) !== JSON.stringify(expected)
  )
    throw new Error("incomplete or changed matrix");
  if (
    meta.baselineSha256 !== sha(baselineRaw) ||
    meta.warmSha256 !== sha(warmRaw) ||
    meta.targetedSha256 !== sha(targetedRaw)
  )
    throw new Error("frozen report hash mismatch");
  for (const r of rows) {
    if (
      r.modelUsage.fitted + r.modelUsage.retained + r.modelUsage.unavailable !== r.steps ||
      r.vsFixed60 !== r.candidate.cost / r.fixed60.cost - 1
    )
      throw new Error("invalid case metrics");
    for (const value of [
      r.modelUsage.fitted,
      r.modelUsage.retained,
      r.modelUsage.unavailable,
      r.modelUsage.maxObservationsSinceFit,
    ])
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid model usage");
    if (
      r.modelUsage.nonFitted.length !== r.modelUsage.retained + r.modelUsage.unavailable ||
      r.modelUsage.nonFitted.filter((s) => s.source === "retained").length !==
        r.modelUsage.retained ||
      r.modelUsage.nonFitted.filter((s) => s.source === "unavailable").length !==
        r.modelUsage.unavailable
    )
      throw new Error("invalid model events");
    for (const arm of [r.fixed60, r.candidate])
      if (
        [arm.cost, arm.ordinaryCost, arm.summaryCost, arm.prewarmCost].some(
          (n) => !Number.isFinite(n) || n < 0,
        ) ||
        arm.ordinaryCalls !== r.steps ||
        arm.overflow ||
        arm.fingerprint !== r.fixed60.fingerprint ||
        Math.abs(arm.cost - arm.ordinaryCost - arm.summaryCost - arm.prewarmCost) > 1e-8 ||
        arm.summaryCalls !== arm.compactions.length ||
        Math.abs(arm.summaryCost - arm.compactions.reduce((n, c) => n + c.summaryCost, 0)) > 1e-8 ||
        arm.totalRequests !== arm.ordinaryCalls + arm.summaryCalls + arm.prewarmCalls
      )
        throw new Error("invalid bill");
    if (r.suite === "main") {
      const old = baseline.rows.find((p) => id(p) === id(r));
      const frozen = warm.rows.find((p) => p.suite === "main" && id(p) === id(r));
      const target = targeted.rows.find((p) => id(p) === id(r));
      if (
        !frozen ||
        JSON.stringify(r.fixed60) !== JSON.stringify(frozen.fixed60) ||
        r.historyCost !== frozen.historyCost ||
        r.previousFailureRepaired !== !old ||
        r.previousCost !== (old?.candidate.cost ?? null) ||
        (old && JSON.stringify(r.candidate) !== JSON.stringify(old.candidate)) ||
        (!old && !baseline.failures.some((p) => id(p) === id(r))) ||
        (target &&
          (JSON.stringify(r.candidate) !== JSON.stringify(target.candidate) ||
            JSON.stringify(r.modelUsage) !== JSON.stringify(target.modelUsage)))
      )
        throw new Error("frozen execution reference mismatch");
      if (old && r.modelUsage.fitted !== r.steps)
        throw new Error("unexpected model recovery in old successful case");
    } else {
      const old = baseline.short.find(
        (p) => p.profile === r.profile && p.seed === r.seed && p.steps === r.steps,
      );
      if (
        !old ||
        r.candidate.cost !== old.candidateCost ||
        r.fixed60.cost !== old.fixed60Cost ||
        r.previousCost !== old.candidateCost ||
        r.previousFailureRepaired
      )
        throw new Error("short reference mismatch");
    }
  }
  const main = rows.filter((r) => r.suite === "main"),
    short = rows.filter((r) => r.suite === "short");
  return {
    kind: RECOVERY_MATRIX_MANIFEST.version,
    metadata: meta,
    externalCalls: 0,
    paidCalls: 0,
    main,
    short,
    gate: {
      mainCompleted: main.length,
      shortCompleted: short.length,
      hardFailures: 0,
      previousSuccessfulMainUnchanged: main.filter((r) => r.previousCost === r.candidate.cost)
        .length,
      previousFailuresRepaired: main.filter((r) => r.previousFailureRepaired).length,
      promotedToPi: false,
    },
    summary: summarizeRecoveryMatrix(main),
    byLength: RECOVERY_MATRIX_MANIFEST.lengths.flatMap((steps) =>
      summarizeRecoveryMatrix(main.filter((r) => r.steps === steps)).map((s) => ({ ...s, steps })),
    ),
    shortSummary: {
      cases: short.length,
      previousCostsUnchanged: short.filter((r) => r.previousCost === r.candidate.cost).length,
      worstVsFixed60: Math.max(...short.map((r) => r.vsFixed60)),
    },
    prefixAudits: recoveryMatrixPrefixAudits(rows),
    limitations: [
      "Every candidate and fixed60 arm executed in this run (versioned execution checkpoints may resume identical runs); old bills used only as regression references, never as new simulation output.",
      "252 main endpoints are correlated synthetic warm success paths, not independent real tasks. Same previously seen seeds, no heldout or task-quality claim.",
      "Prices are frozen ratios, not current provider quotes or actual cross-model tests. Summary does not share cache; no TTL, failure, or prewarm regime claim.",
      "Ordinary outputs, summary calls and rebuilds are charged; prior history collection bills are separate. Low synthetic cost with frequent summaries does not prove information retention.",
      "Core defaults and Pi timing are unchanged; no prior, drift tolerance, price, margin or threshold tuning in this replication.",
    ],
  };
}
export function renderRecoveryMatrix(r: ReturnType<typeof buildRecoveryMatrixReport>) {
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
  return [
    "# 修复候选冻结全矩阵：费用与压缩频率",
    "",
    "冻结 8c054cc，不调参数。252 主组合 + 63 短任务，候选与 fixed60 全部执行，无旧结果拼接；缓存仅用于相同版本中断续跑。",
    "",
    "| 冻结价格 | 胜/负 vs60 | 平均费用变化 | 最坏变化 | 摘要次数 候选/60 | 中位压缩间隔 候选/60 | 中位压缩利用率 候选/60 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...r.summary.map(
      (s) =>
        `| ${s.profile} | ${s.wins}/${s.losses} | ${pct(s.meanVsFixed60)} | ${pct(s.worstVsFixed60)} | ${s.candidateFrequency.summaryCalls}/${s.fixedFrequency.summaryCalls} | ${s.candidateFrequency.medianSpacing}/${s.fixedFrequency.medianSpacing} | ${pct(s.candidateFrequency.medianUtilization ?? 0)}/${pct(s.fixedFrequency.medianUtilization ?? 0)} |`,
    ),
    "",
    `主矩阵完成 ${r.gate.mainCompleted}/252，短任务 ${r.gate.shortCompleted}/63，硬失败 ${r.gate.hardFailures}。原成功主组合 ${r.gate.previousSuccessfulMainUnchanged} 组账单不变，原中断 ${r.gate.previousFailuresRepaired} 组修复。`,
    `前缀审计 ${r.prefixAudits.length}/168；短任务 ${r.shortSummary.previousCostsUnchanged}/63 费用与旧候选相同，vs60 最坏增支 ${pct(r.shortSummary.worstVsFixed60)}。`,
    "",
    "压缩频率是风险信号，不是任务质量分数；成本降低不等于已证明频繁压缩不会丢失任务信息。未加入按价格或场景的特殊分支，未因频率高而在本轮另调冷却或阈值。",
    "",
    "## 限制",
    "",
    ...r.limitations.map((s) => `- ${s}`),
    "",
  ].join("\n");
}
async function runMatrix() {
  const meta = metadata(),
    cases = recoveryMatrixCases();
  const dir = resolve(root, "traces/recovery-matrix", meta.key);
  mkdirSync(dir, { recursive: true });
  const workerAt = process.argv.indexOf("--worker");
  if (workerAt >= 0) {
    const slot = Number(process.argv[workerAt + 1]);
    if (slot !== 0 && slot !== 1) throw new Error("invalid worker slot");
    let completed = 0;
    for (let i = slot; i < cases.length; i += 2) {
      const c = cases[i];
      if (!c) throw new Error("missing case");
      const path = resolve(dir, `${i}.json`);
      if (!existsSync(path)) {
        const row = executeRecoveryMatrixCase(c);
        writeFileSync(`${path}.tmp`, JSON.stringify({ key: meta.key, row }));
        renameSync(`${path}.tmp`, path);
      }
      completed++;
      if (completed % 8 === 0)
        console.log(`worker ${slot}: ${completed}/${Math.ceil((cases.length - slot) / 2)} cases`);
    }
    if (JSON.stringify(metadata()) !== JSON.stringify(meta))
      throw new Error("sources changed during worker");
    return undefined;
  }
  const active = new Set<ChildProcess>();
  try {
    await Promise.all(
      [0, 1].map(
        (slot) =>
          new Promise<void>((accept, reject) => {
            const child = spawn(
              process.execPath,
              ["--import", "tsx", fileURLToPath(import.meta.url), "--worker", String(slot)],
              { cwd: root, windowsHide: true, stdio: "inherit" },
            );
            active.add(child);
            child.once("error", reject);
            child.once("exit", (code) => {
              active.delete(child);
              code === 0 ? accept() : reject(new Error(`matrix worker failed: ${code}`));
            });
          }),
      ),
    );
  } catch (error) {
    for (const child of active) child.kill();
    throw error;
  }
  if (JSON.stringify(metadata()) !== JSON.stringify(meta))
    throw new Error("sources changed during matrix");
  const rows = cases.map((c, i) => {
    const saved = JSON.parse(readFileSync(resolve(dir, `${i}.json`), "utf8")) as {
      key: string;
      row: Row;
    };
    if (saved.key !== meta.key || saved.row.suite !== c.suite || id(saved.row) !== id(c))
      throw new Error("invalid cached execution");
    return saved.row;
  });
  return buildRecoveryMatrixReport(rows, meta);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const existing = process.argv.includes("--analyze-existing")
    ? (JSON.parse(
        readFileSync(resolve(root, "benchmarks/reports/recovery-matrix.json"), "utf8"),
      ) as ReturnType<typeof buildRecoveryMatrixReport>)
    : undefined;
  const report = existing
    ? buildRecoveryMatrixReport([...existing.main, ...existing.short], existing.metadata)
    : await runMatrix();
  if (report) {
    writeFileSync(
      resolve(root, "benchmarks/reports/recovery-matrix.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    writeFileSync(resolve(root, "benchmarks/recovery-matrix.md"), renderRecoveryMatrix(report));
    console.log(JSON.stringify(report.gate));
  }
}
