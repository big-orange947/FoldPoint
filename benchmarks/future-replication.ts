/** Frozen candidate replication. Workers simulate only; no provider, key or task text. */
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
import { cycleExecutionCase } from "./cycle-execution";
import {
  FUTURE_CHECK_BUDGET,
  futureQualificationCase,
  type futureQualificationReport,
  summarizeFutureQualification,
} from "./future-qualification";
import { buildGrowthSequence, fingerprintSequence } from "./scenarios";
import {
  type buildWarmLengthReport,
  WARM_LENGTH_MANIFEST,
  warmLengthCases,
} from "./warm-length-seed";

const root = fileURLToPath(new URL("../", import.meta.url));
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
const frozenRaw = readFileSync(new URL("./reports/warm-length-seed.json", import.meta.url), "utf8");
const frozen = JSON.parse(frozenRaw) as ReturnType<typeof buildWarmLengthReport>;
const initialRaw = readFileSync(
  new URL("./reports/future-qualification.json", import.meta.url),
  "utf8",
);
const initial = JSON.parse(initialRaw) as ReturnType<typeof futureQualificationReport>;
export const REPLICATION_MANIFEST = {
  version: "foldpoint.future-replication.v1",
  candidateCommit: "dafcc42",
  maxChecksPerPath: 2,
  seeds: [151, 919, 2027],
  lengths: [120, 240, 360],
  profiles: WARM_LENGTH_MANIFEST.profiles,
  sourceFixtures: WARM_LENGTH_MANIFEST.sourceFixtures,
  contract: "summary-uncached",
  mainCases: 252,
  reusedInitialCases: 28,
  freshMainCases: 224,
  shortCases: 63,
  sampledCheckpointCalls: [0, 20, 60, 100],
} as const;
export function replicationCases() {
  return warmLengthCases().filter((c) => c.suite === "main");
}
type InitialRow = ReturnType<typeof futureQualificationReport>["rows"][number];
type Row = InitialRow & {
  reusedInitial: boolean;
  growthPrefixes: { steps: number; fingerprint: string }[];
};
type ShortRow = ReturnType<typeof futureQualificationReport>["short"][number] & {
  seed: number;
  reusedInitial: boolean;
};
type FailedRow = {
  profile: string;
  sourceFixture: string;
  seed: number;
  steps: number;
  errorCode: "FORECAST_MODEL_REQUIREMENT_LOST";
  message: string;
};
const identity = (r: { profile: string; sourceFixture: string; seed: number; steps: number }) =>
  `${r.profile}/${r.sourceFixture}/${r.seed}/${r.steps}`;
const sampleAudit = (audit: InitialRow["audit"]) => ({
  ...audit,
  checkpoints: audit.checkpoints.filter((t) =>
    (REPLICATION_MANIFEST.sampledCheckpointCalls as readonly number[]).includes(t.step),
  ),
});
export function replicationSourceHashes() {
  const sources = [
    ...readdirSync(resolve(root, "src"))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `src/${f}`),
    ...readdirSync(resolve(root, "benchmarks"))
      .filter((f) => f.endsWith(".ts") && f !== "future-replication.ts")
      .map((f) => `benchmarks/${f}`),
    "benchmarks/datasets/warm-length-seed-v1.json",
    "package-lock.json",
  ];
  for (const path of sources) {
    const current = readFileSync(resolve(root, path), "utf8").replace(/\r\n/g, "\n");
    const old = execFileSync("git", ["show", `${REPLICATION_MANIFEST.candidateCommit}:${path}`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 10000000,
    }).replace(/\r\n/g, "\n");
    if (current !== old) throw new Error(`frozen candidate dependency changed: ${path}`);
  }
  return Object.fromEntries(
    [...sources, "benchmarks/future-replication.ts"].map((path) => [
      path,
      digest(readFileSync(resolve(root, path), "utf8").replace(/\r\n/g, "\n")),
    ]),
  );
}
function cacheMetadata() {
  const sourceHashes = replicationSourceHashes();
  const metadata = {
    manifest: REPLICATION_MANIFEST,
    sourceHashes,
    nodeVersion: process.version,
    frozenControlSha256: digest(frozenRaw),
    initialReportSha256: digest(initialRaw),
  };
  return { ...metadata, cacheKey: digest(JSON.stringify(metadata)) };
}
function prefixes(c: ReturnType<typeof replicationCases>[number]) {
  const growth = buildGrowthSequence(c.scenario);
  return REPLICATION_MANIFEST.lengths
    .filter((n) => n <= c.steps)
    .map((steps) => ({ steps, fingerprint: fingerprintSequence(growth.slice(0, steps)) }));
}
function executeCase(c: ReturnType<typeof replicationCases>[number]): Row {
  const old = frozen.rows.find((r) => r.suite === "main" && identity(r) === identity(c));
  if (!old) throw new Error("missing frozen control");
  const previous = initial.rows.find((r) => identity(r) === identity(c));
  if (previous) {
    if (
      initial.maxChecksPerPath !== REPLICATION_MANIFEST.maxChecksPerPath ||
      initial.frozenControlSha256 !== digest(frozenRaw) ||
      JSON.stringify(previous.fixed60) !== JSON.stringify(old.fixed60) ||
      JSON.stringify(previous.incumbent) !== JSON.stringify(old.paired)
    )
      throw new Error("initial reuse mismatch");
    return {
      ...previous,
      audit: sampleAudit(previous.audit),
      reusedInitial: true,
      growthPrefixes: prefixes(c),
    };
  }
  const run = futureQualificationCase(c.scenario);
  if (
    JSON.stringify(run.fixed60) !== JSON.stringify(old.fixed60) ||
    run.historyCost !== old.historyCost ||
    run.dynamic.fingerprint !== old.paired.fingerprint
  )
    throw new Error("frozen execution control changed");
  return {
    profile: c.profile,
    sourceFixture: c.sourceFixture,
    seed: c.seed,
    steps: c.steps,
    fixed60: run.fixed60,
    incumbent: old.paired,
    candidate: run.dynamic,
    audit: sampleAudit(run.audit),
    vsFixed60: run.change,
    vsIncumbent: run.dynamic.cost / old.paired.cost - 1,
    historyCost: run.historyCost,
    reusedInitial: false,
    growthPrefixes: prefixes(c),
  };
}
function executeShort(profile: string, seed: number, steps: number): ShortRow {
  const old =
    seed === 151
      ? initial.short.find((r) => r.profile === profile && r.steps === steps)
      : undefined;
  if (old) return { ...old, seed, reusedInitial: true };
  const c = replicationCases().find(
    (c) =>
      c.profile === profile &&
      c.seed === seed &&
      c.sourceFixture === REPLICATION_MANIFEST.sourceFixtures[0],
  );
  if (!c) throw new Error("missing short fixture");
  const scenario = { ...c.scenario, steps, startTokens: 500000 };
  const incumbent = cycleExecutionCase(scenario, "paired-policy");
  const candidate = futureQualificationCase(scenario);
  if (
    JSON.stringify(incumbent.fixed60) !== JSON.stringify(candidate.fixed60) ||
    incumbent.dynamic.fingerprint !== candidate.dynamic.fingerprint
  )
    throw new Error("short control changed");
  return {
    profile,
    seed,
    steps,
    reusedInitial: false,
    fixed60Cost: candidate.fixed60.cost,
    incumbentCost: incumbent.dynamic.cost,
    candidateCost: candidate.dynamic.cost,
    vsFixed60: candidate.change,
    vsIncumbent: candidate.dynamic.cost / incumbent.dynamic.cost - 1,
    incumbentAttempts: incumbent.dynamic.summaryCalls,
    candidateAttempts: candidate.dynamic.summaryCalls,
    audit: sampleAudit(candidate.audit),
  };
}
type Metadata = ReturnType<typeof cacheMetadata>;
type ExecutionOrigin = {
  profile: string;
  harnessSha256: string;
  retainedCompletedProfile: boolean;
};
type WorkerResult = {
  metadata: Metadata;
  profile: string;
  rows: Row[];
  short: ShortRow[];
  failures?: FailedRow[];
  executionHarnessSha256?: string;
  reusedCompletedProfile?: boolean;
};
function compatibleMetadata(a: Metadata, b: Metadata) {
  const projection = (m: Metadata) => ({
    manifest: m.manifest,
    nodeVersion: m.nodeVersion,
    frozenControlSha256: m.frozenControlSha256,
    initialReportSha256: m.initialReportSha256,
    algorithmSources: Object.entries(m.sourceHashes)
      .filter(([p]) => p !== "benchmarks/future-replication.ts")
      .sort(([a], [b]) => a.localeCompare(b)),
  });
  return JSON.stringify(projection(a)) === JSON.stringify(projection(b));
}
export function recordProductFailure(
  c: ReturnType<typeof replicationCases>[number],
  error: unknown,
): FailedRow {
  const message =
    "future qualification requires renewal, paired stress, execution gates and token model; excludes other ablations and cumulative budgets";
  if (!(error instanceof RangeError) || error.message !== message) throw error;
  return {
    profile: c.profile,
    sourceFixture: c.sourceFixture,
    seed: c.seed,
    steps: c.steps,
    errorCode: "FORECAST_MODEL_REQUIREMENT_LOST",
    message:
      "The learned token model became unavailable during the frozen candidate run; no fallback is implemented.",
  };
}
async function worker(profile: string) {
  if (!REPLICATION_MANIFEST.profiles.includes(profile)) throw new Error("unknown worker profile");
  const metadata = cacheMetadata();
  const dir = resolve(root, "traces/future-replication-cache", metadata.cacheKey);
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${profile}.json`);
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8")) as WorkerResult;
    if (
      saved.metadata.cacheKey === metadata.cacheKey &&
      saved.profile === profile &&
      saved.rows.length + (saved.failures?.length ?? 0) === 36 &&
      saved.short.length === 9
    ) {
      console.log(`cached profile complete: ${profile}`);
      return;
    }
    throw new Error("invalid existing worker checkpoint");
  }
  // Completed SUCCESS records from an earlier harness revision are compatible only
  // when every frozen algorithm/source/input hash matches. Retain origin provenance.
  const cacheRoot = resolve(root, "traces/future-replication-cache");
  for (const entry of readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const previousFile = resolve(cacheRoot, entry.name, `${profile}.json`);
    if (previousFile === file || !existsSync(previousFile)) continue;
    const saved = JSON.parse(readFileSync(previousFile, "utf8")) as WorkerResult;
    if (
      saved.profile === profile &&
      saved.rows.length === 36 &&
      (saved.failures?.length ?? 0) === 0 &&
      saved.short.length === 9 &&
      compatibleMetadata(saved.metadata, metadata)
    ) {
      const result: WorkerResult = {
        ...saved,
        metadata,
        failures: [],
        reusedCompletedProfile: true,
        executionHarnessSha256:
          saved.executionHarnessSha256 ??
          saved.metadata.sourceHashes["benchmarks/future-replication.ts"],
      };
      writeFileSync(`${file}.tmp`, JSON.stringify(result));
      renameSync(`${file}.tmp`, file);
      console.log(`compatible completed profile retained: ${profile}`);
      return;
    }
  }
  const rows: Row[] = [];
  const failures: FailedRow[] = [];
  for (const c of replicationCases().filter((c) => c.profile === profile)) {
    try {
      rows.push(executeCase(c));
    } catch (error) {
      const failure = recordProductFailure(c, error);
      failures.push(failure);
      console.log(`HARD_FAILURE ${identity(c)}: ${failure.errorCode}`);
    }
    const attempted = rows.length + failures.length;
    if (attempted % 6 === 0) console.log(`replication ${profile}: ${attempted}/36`);
  }
  const short = REPLICATION_MANIFEST.seeds.flatMap((seed) =>
    [1, 4, 12].map((steps) => executeShort(profile, seed, steps)),
  );
  if (JSON.stringify(cacheMetadata()) !== JSON.stringify(metadata))
    throw new Error("sources changed during simulation");
  const result: WorkerResult = {
    metadata,
    profile,
    rows,
    short,
    failures,
    executionHarnessSha256: metadata.sourceHashes["benchmarks/future-replication.ts"],
    reusedCompletedProfile: false,
  };
  writeFileSync(`${file}.tmp`, JSON.stringify(result));
  renameSync(`${file}.tmp`, file);
  console.log(`profile complete: ${profile}`);
}
export function replicationPrefixAudits(rows: Row[], failures: FailedRow[] = []) {
  const groups = [
    ...new Set([...rows, ...failures].map((r) => `${r.profile}/${r.sourceFixture}/${r.seed}`)),
  ];
  return groups.flatMap((group) => {
    const stream = rows
      .filter((r) => `${r.profile}/${r.sourceFixture}/${r.seed}` === group)
      .sort((a, b) => a.steps - b.steps);
    return REPLICATION_MANIFEST.lengths.slice(1).map((to, index) => {
      const from = REPLICATION_MANIFEST.lengths[index];
      const short = stream.find((r) => r.steps === from);
      const long = stream.find((r) => r.steps === to);
      if (!short || !long)
        return {
          group,
          from,
          to,
          status: "NOT_AVAILABLE" as const,
          growthAndActionsMatch: false,
          candidateIncrement: null,
          fixed60Increment: null,
          incrementalChange: null,
        };
      if (
        short.growthPrefixes.find((p) => p.steps === short.steps)?.fingerprint !==
        long.growthPrefixes.find((p) => p.steps === short.steps)?.fingerprint
      )
        throw new Error("growth prefix mismatch");
      for (const arm of ["candidate", "fixed60", "incumbent"] as const)
        if (
          JSON.stringify(short[arm].compactions) !==
          JSON.stringify(long[arm].compactions.filter((c) => c.step < short.steps))
        )
          throw new Error("action prefix mismatch");
      if (
        JSON.stringify(short.audit.checkpoints) !==
        JSON.stringify(long.audit.checkpoints.filter((c) => c.step < short.steps))
      )
        throw new Error("decision prefix mismatch");
      return {
        group,
        status: "PASS" as const,
        from: short.steps,
        to: long.steps,
        growthAndActionsMatch: true,
        candidateIncrement: long.candidate.cost - short.candidate.cost,
        fixed60Increment: long.fixed60.cost - short.fixed60.cost,
        incrementalChange:
          (long.candidate.cost - short.candidate.cost) / (long.fixed60.cost - short.fixed60.cost) -
          1,
      };
    });
  });
}
export function buildReplicationReport(
  rows: Row[],
  short: ShortRow[],
  metadata: Metadata,
  failures: FailedRow[] = [],
  executionOrigins: ExecutionOrigin[] = [],
) {
  if (
    JSON.stringify(metadata.manifest) !== JSON.stringify(REPLICATION_MANIFEST) ||
    FUTURE_CHECK_BUDGET !== REPLICATION_MANIFEST.maxChecksPerPath
  )
    throw new Error("changed manifest");
  const expected = replicationCases().map(identity).sort();
  if (
    JSON.stringify([...rows, ...failures].map(identity).sort()) !== JSON.stringify(expected) ||
    rows.length + failures.length !== 252
  )
    throw new Error("incomplete/duplicate main matrix");
  const expectedShort = REPLICATION_MANIFEST.profiles
    .flatMap((p) =>
      REPLICATION_MANIFEST.seeds.flatMap((seed) =>
        [1, 4, 12].map((steps) => `${p}/${seed}/${steps}`),
      ),
    )
    .sort();
  if (
    JSON.stringify(short.map((r) => `${r.profile}/${r.seed}/${r.steps}`).sort()) !==
    JSON.stringify(expectedShort)
  )
    throw new Error("incomplete short matrix");
  if (
    rows.filter((r) => r.reusedInitial).length !== 28 ||
    short.filter((r) => r.reusedInitial).length !== 21
  )
    throw new Error("incorrect reuse accounting");
  for (const r of rows) {
    const old = frozen.rows.find((o) => o.suite === "main" && identity(o) === identity(r));
    if (
      !old ||
      JSON.stringify(r.fixed60) !== JSON.stringify(old.fixed60) ||
      JSON.stringify(r.incumbent) !== JSON.stringify(old.paired) ||
      r.historyCost !== old.historyCost
    )
      throw new Error("control altered");
    for (const arm of [r.fixed60, r.incumbent, r.candidate]) {
      if (
        arm.fingerprint !== r.fixed60.fingerprint ||
        arm.overflow ||
        Math.abs(arm.cost - arm.ordinaryCost - arm.summaryCost - arm.prewarmCost) > 1e-8 ||
        arm.summaryCalls !== arm.compactions.length ||
        Math.abs(arm.summaryCost - arm.compactions.reduce((n, c) => n + c.summaryCost, 0)) > 1e-8 ||
        arm.totalRequests !== arm.ordinaryCalls + arm.summaryCalls + arm.prewarmCalls
      )
        throw new Error("invalid full bill");
    }
    if (
      Math.abs(r.vsFixed60 - (r.candidate.cost / r.fixed60.cost - 1)) > 1e-12 ||
      Math.abs(r.vsIncumbent - (r.candidate.cost / r.incumbent.cost - 1)) > 1e-12
    )
      throw new Error("invalid cost ratios");
  }
  const byLength = REPLICATION_MANIFEST.lengths.flatMap((steps) =>
    summarizeFutureQualification(rows.filter((r) => r.steps === steps)).map((s) => ({
      ...s,
      steps,
    })),
  );
  const bySeed = REPLICATION_MANIFEST.seeds.flatMap((seed) =>
    summarizeFutureQualification(rows.filter((r) => r.seed === seed)).map((s) => ({ ...s, seed })),
  );
  const stability = REPLICATION_MANIFEST.profiles.map((profile) => {
    const streams = REPLICATION_MANIFEST.sourceFixtures.flatMap((f) =>
      REPLICATION_MANIFEST.seeds.map((seed) =>
        rows.filter((r) => r.profile === profile && r.sourceFixture === f && r.seed === seed),
      ),
    );
    return {
      profile,
      streams: streams.length,
      allWin: streams.filter((g) => g.length === 3 && g.every((r) => r.vsFixed60 < -1e-9)).length,
      allLose: streams.filter((g) => g.length === 3 && g.every((r) => r.vsFixed60 > 1e-9)).length,
      incomplete: streams.filter((g) => g.length < 3).length,
      signFlip: streams.filter(
        (g) => g.some((r) => r.vsFixed60 < -1e-9) && g.some((r) => r.vsFixed60 > 1e-9),
      ).length,
    };
  });
  return {
    kind: "foldpoint.future-replication.v1",
    externalCalls: 0,
    paidCalls: 0,
    metadata,
    executionOrigins,
    rows,
    failures,
    coverage: REPLICATION_MANIFEST.profiles.map((profile) => ({
      profile,
      attempted: 36,
      completed: rows.filter((r) => r.profile === profile).length,
      hardFailures: failures.filter((r) => r.profile === profile).length,
    })),
    gate: {
      allCasesCompleted: failures.length === 0,
      hardFailures: failures.length,
      publicationReady: false,
    },
    short,
    summary: summarizeFutureQualification(rows),
    byLength,
    bySeed,
    additionalSeeds: summarizeFutureQualification(rows.filter((r) => r.seed !== 151)),
    stability,
    prefixAudits: replicationPrefixAudits(rows, failures),
    shortSummary: {
      cases: short.length,
      better: short.filter((r) => r.vsIncumbent < -1e-9).length,
      worse: short.filter((r) => r.vsIncumbent > 1e-9).length,
      unchanged: short.filter((r) => Math.abs(r.vsIncumbent) <= 1e-9).length,
      worstVsFixed60: Math.max(...short.map((r) => r.vsFixed60)),
    },
    limitations: [
      "候选与依赖按 dafcc42 规范化换行后逐文件核对并冻结；仅扩展 seed 与任务长度，不改参数。252 主组合含复用的 28 初始结果与 224 新模拟尝试，另外 63 短任务含 21 初始与 42 新模拟。",
      "执行来源逐价格记录 harness SHA；较早执行完的成功 profile 仅在全部算法、输入、运行时哈希相同时保留。报告补充失败记录不导致重跑这些已完成的账单。",
      "所有 seed/长度都曾在旧算法矩阵中出现；这里是新候选的冻结复验，不是独立盲测。七组价格、四种增长/底噪、三 seed、三个终点仍是相关合成组合。",
      "120/240/360 为同一增长流的相关终点，逐一核对三路压缩前缀及固定 checkpoint；不能把 252 个组合当成 252 个独立真实任务。",
      "摘要不共享缓存、持续暖缓存、成功压缩假设；不推广到失败、TTL、共享摘要/预热场景或真实任务质量。普通输出、摘要与重建仍完整收费，历史采集费用另列。",
      "每路复核两次，内层仍是原算法，预算之后保留旧假设；不是完整递归一致性。复核/拒绝/未复核计数来自预测，不是实际调用数。",
      "完整压缩与费用记录保留；checkpoint 仅采样固定 0/20/60/100，聚合检查计数与最长等待见证保留。CPU worker 并行只缩短离线运行时间，不改变决策输入或取舍。",
      "默认核心/Pi 未改变，未调用付费 API，也未读取密钥；计算延迟和真实任务质量仍待独立验证。",
      "产品硬失败逐案保留，不计作胜利、不赋零成本；费用均值只覆盖完成的组合。缺失端点的前缀审计记 NOT_AVAILABLE，存在硬失败时不得宣称复验全部通过。",
    ],
  };
}
export function renderReplication(r: ReturnType<typeof buildReplicationReport>) {
  const table = (group: ReturnType<typeof summarizeFutureQualification>) => [
    "| 冻结价格 | 胜/负 vs60 | 平均 vs60 | 平均 vs原算法 | 更好/更差 vs原算法 | 最坏 vs60 |",
    "| --- | --- | --- | --- | --- | --- |",
    ...group.map(
      (s) =>
        `| ${s.profile} | ${s.wins}/${s.losses} | ${(s.meanVsFixed60 * 100).toFixed(2)}% | ${(s.meanVsIncumbent * 100).toFixed(2)}% | ${s.betterThanIncumbent}/${s.worseThanIncumbent} | ${(s.worstVsFixed60 * 100).toFixed(2)}% |`,
    ),
  ];
  return [
    "# 冻结未来复核候选：跨 seed 与长度复验",
    "",
    "负数表示完整模拟账单更低，固定 60% 为主对照；均为等权相对平均，不是实际供应商账单。",
    `主矩阵尝试 252 组，完成 ${r.rows.length} 组、产品硬失败 ${r.failures.length} 组。以下费用统计仅限完成样本，失败不作为零成本或胜利。`,
    "",
    "## 执行覆盖与硬失败",
    "",
    "| 冻结价格 | 尝试 | 完成 | 硬失败 |",
    "| --- | --- | --- | --- |",
    ...r.coverage.map(
      (c) => `| ${c.profile} | ${c.attempted} | ${c.completed} | ${c.hardFailures} |`,
    ),
    ...r.failures.map((f) => `- ${identity(f)}：${f.errorCode}。${f.message}`),
    "",
    "## 主矩阵的完成样本（共尝试 252 组）",
    "",
    ...table(r.summary),
    "",
    "## 另外两个 seed（919、2027；168 个组合）",
    "",
    ...table(r.additionalSeeds),
    "",
    ...REPLICATION_MANIFEST.lengths.flatMap((steps) => [
      `## ${steps} 次普通调用（84 个组合）`,
      "",
      ...table(r.byLength.filter((s) => s.steps === steps)),
      "",
    ]),
    "## 结束位置稳定性",
    "",
    "每个价格 12 条增长流，每条含三个相关终点。",
    "",
    "| 冻结价格 | 三个终点全胜 | 三个终点全负 | 胜负翻转 | 端点不完整 |",
    "| --- | --- | --- | --- | --- |",
    ...r.stability.map(
      (s) => `| ${s.profile} | ${s.allWin} | ${s.allLose} | ${s.signFlip} | ${s.incomplete} |`,
    ),
    "",
    `短任务 ${r.shortSummary.cases} 组：相对原算法 ${r.shortSummary.better} 更好、${r.shortSummary.worse} 更差、${r.shortSummary.unchanged} 不变；相对固定 60% 最坏增支 ${(r.shortSummary.worstVsFixed60 * 100).toFixed(2)}%。`,
    "",
    `增长/压缩/决策前缀审计 ${r.prefixAudits.filter((a) => a.status === "PASS").length} 组通过，${r.prefixAudits.filter((a) => a.status === "NOT_AVAILABLE").length} 组因缺失端点未执行。原始账单保留全部完成样本的负结果与产品失败。`,
    "",
    "## 限制",
    "",
    ...r.limitations.map((l) => `- ${l}`),
    "",
  ].join("\n");
}
async function runReplication() {
  const metadata = cacheMetadata();
  const profiles = [...REPLICATION_MANIFEST.profiles];
  const active = new Set<ChildProcess>();
  const pool = async () => {
    while (profiles.length) {
      const profile = profiles.shift();
      if (!profile) throw new Error("missing queued profile");
      await new Promise<void>((accept, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", fileURLToPath(import.meta.url), "--worker", profile],
          { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
        );
        active.add(child);
        child.stdout?.pipe(process.stdout, { end: false });
        child.stderr?.pipe(process.stderr, { end: false });
        child.once("error", reject);
        child.once("exit", (code) => {
          active.delete(child);
          code === 0 ? accept() : reject(new Error(`worker failed: ${profile} (${code})`));
        });
      });
    }
  };
  try {
    await Promise.all([pool(), pool()]);
  } catch (error) {
    for (const child of active) child.kill();
    throw error;
  }
  if (JSON.stringify(cacheMetadata()) !== JSON.stringify(metadata))
    throw new Error("sources changed during replication");
  const results = REPLICATION_MANIFEST.profiles.map((profile) => {
    const file = resolve(
      root,
      "traces/future-replication-cache",
      metadata.cacheKey,
      `${profile}.json`,
    );
    const r = JSON.parse(readFileSync(file, "utf8")) as WorkerResult;
    if (JSON.stringify(r.metadata) !== JSON.stringify(metadata) || r.profile !== profile)
      throw new Error("worker metadata mismatch");
    return r;
  });
  return buildReplicationReport(
    results.flatMap((r) => r.rows),
    results.flatMap((r) => r.short),
    metadata,
    results.flatMap((r) => r.failures ?? []),
    results.map((r) => ({
      profile: r.profile,
      harnessSha256:
        r.executionHarnessSha256 ??
        r.metadata.sourceHashes["benchmarks/future-replication.ts"] ??
        "",
      retainedCompletedProfile: r.reusedCompletedProfile ?? false,
    })),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workerAt = process.argv.indexOf("--worker");
  if (workerAt >= 0) {
    await worker(process.argv[workerAt + 1] ?? "");
  } else {
    const existing = process.argv.includes("--analyze-existing")
      ? (JSON.parse(
          readFileSync(new URL("./reports/future-replication.json", import.meta.url), "utf8"),
        ) as ReturnType<typeof buildReplicationReport>)
      : undefined;
    const report = existing
      ? buildReplicationReport(
          existing.rows,
          existing.short,
          existing.metadata,
          existing.failures,
          existing.executionOrigins,
        )
      : await runReplication();
    mkdirSync(new URL("./reports/", import.meta.url), { recursive: true });
    writeFileSync(
      new URL("./reports/future-replication.json", import.meta.url),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    writeFileSync(new URL("./future-replication.md", import.meta.url), renderReplication(report));
    console.log(JSON.stringify({ summary: report.summary, short: report.shortSummary }, null, 2));
    if (report.failures.length) process.exitCode = 1;
  }
}
