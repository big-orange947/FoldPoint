/** Reliability candidate: reproduce both failures and replay frozen best/worst controls.
 * No provider, key, task content or future endpoint is given to the controller.
 */
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
import type { Scenario } from "../benchmarks/scenarios";
import { createFoldPointStrategy, runSession } from "../benchmarks/simulator";
import { warmLengthCases } from "../benchmarks/warm-length-seed";
import type { CompactorModelAvailability } from "../src/index";

const root = fileURLToPath(new URL("../", import.meta.url));
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const raw = readFileSync(resolve(root, "benchmarks/reports/future-replication.json"), "utf8");
const old = JSON.parse(raw) as ReturnType<typeof buildReplicationReport>;
const id = (c: { profile: string; sourceFixture: string; seed: number; steps: number }) =>
  `${c.profile}/${c.sourceFixture}/${c.seed}/${c.steps}`;
const failedIds = old.failures.map(id);
const controlIds = old.metadata.manifest.profiles.flatMap((profile) => {
  const rows = old.rows
    .filter((r) => r.profile === profile)
    .sort((a, b) => a.vsFixed60 - b.vsFixed60 || id(a).localeCompare(id(b)));
  const first = rows[0],
    last = rows.at(-1);
  if (!first || !last) throw new Error("missing frozen controls");
  return [id(first), id(last)];
});
const selectedIds = [...new Set([...failedIds, ...controlIds])];
const cases = selectedIds.map((key) => {
  const c = warmLengthCases().find((c) => c.suite === "main" && id(c) === key);
  if (!c) throw new Error("missing selected scenario");
  return c;
});
function metadata() {
  const allowed = ["src/experimental-compactor.ts", "src/index.ts", "benchmarks/simulator.ts"];
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
      const previous = execFileSync("git", ["show", `5e51d14:${path}`], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 10000000,
      }).replace(/\r\n/g, "\n");
      if (!allowed.includes(path) && previous !== current)
        throw new Error(`unexpected algorithm change: ${path}`);
      return [path, digest(current)];
    }),
  );
  const value = {
    version: "foldpoint.model-recovery.v1",
    baselineCommit: "5e51d14",
    baselineSha256: digest(raw),
    allowedSourceChanges: allowed,
    sourceHashes,
    harnessSha256: digest(
      readFileSync(fileURLToPath(import.meta.url), "utf8").replace(/\r\n/g, "\n"),
    ),
    nodeVersion: process.version,
    selectedIds,
  };
  return { ...value, key: digest(JSON.stringify(value)) };
}

function ledger(scenario: Scenario, strategy: Strategy, allowKnownFailure = false) {
  let ordinaryCost = 0,
    summaryCost = 0,
    prewarmCost = 0,
    ordinaryCalls = 0,
    prewarmCalls = 0,
    lastDecisionStep = -1;
  const compactions: {
    step: number;
    action: string;
    success: boolean;
    beforeTokens: number;
    afterTokens: number;
    summaryCost: number;
  }[] = [];
  const wrapped: Strategy = {
    ...strategy,
    decide(request) {
      lastDecisionStep = request.step;
      return strategy.decide(request);
    },
    onRequest(e) {
      ordinaryCost += e.cost;
      ordinaryCalls++;
      strategy.onRequest?.(e);
    },
    onCompaction(e) {
      summaryCost += e.cost;
      compactions.push({
        step: e.step,
        action: e.action,
        success: e.success,
        beforeTokens: e.beforeTokens,
        afterTokens: e.afterTokens,
        summaryCost: e.cost,
      });
      strategy.onCompaction?.(e);
    },
    onPrewarm(e) {
      prewarmCost += e.cost;
      prewarmCalls++;
      strategy.onPrewarm?.(e);
    },
  };
  try {
    const run = runSession(scenario, wrapped);
    const cost = ordinaryCost + summaryCost + prewarmCost;
    if (Math.abs(cost - run.metrics.totalSimulatedCost) > 1e-8 || run.metrics.overflowRecoveryCount)
      throw new Error("fee ledger mismatch");
    return {
      completed: true as const,
      cost: run.metrics.totalSimulatedCost,
      ordinaryCost,
      summaryCost,
      prewarmCost,
      ordinaryCalls,
      summaryCalls: compactions.length,
      prewarmCalls,
      totalRequests: ordinaryCalls + compactions.length + prewarmCalls,
      overflow: run.metrics.overflowCount,
      forced: run.metrics.forcedAttemptCount,
      economic: run.metrics.economicAttemptCount,
      fingerprint: run.metrics.growthSequenceFingerprint,
      compactions,
    };
  } catch (error) {
    if (
      !allowKnownFailure ||
      !(error instanceof RangeError) ||
      error.message !==
        "future qualification requires renewal, paired stress, execution gates and token model; excludes other ablations and cumulative budgets"
    )
      throw error;
    return {
      completed: false as const,
      failureStep: lastDecisionStep,
      observedPrefixCost: ordinaryCost + summaryCost + prewarmCost,
      ordinaryCalls,
      compactions,
    };
  }
}

function execute(index: number) {
  const c = cases[index];
  if (!c) throw new Error("unknown case index");
  const history = collectCompactorHistory({ ...c.scenario, cycleBilling: undefined });
  const availability: {
    step: number;
    source: CompactorModelAvailability["source"];
    reason: string;
    observationsSinceFit: number;
  }[] = [];
  const base = (recover: boolean) =>
    createFoldPointStrategy(c.scenario, {
      learnedCompactorTokens: true,
      recoverCompactorModel: recover,
      compactorHistory: history.observations,
      warmCoreFromHistory: true,
      enforceForecastExecutionGates: true,
      omitRequestCacheEvidence: true,
      verifiedAppendOnlyPrefix: true,
      defaults: { compactOutputRatio: 0.002 },
      ...(recover
        ? {
            onCompactorAvailability: (s: CompactorModelAvailability, step: number) =>
              availability.push({
                step,
                source: s.source,
                reason: s.reason,
                observationsSinceFit: s.observationsSinceFit,
              }),
          }
        : {}),
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
    });
  const fixed60 = ledger(c.scenario, createRawFixedThresholdStrategy(0.6));
  const candidate = ledger(c.scenario, base(true));
  if (
    !candidate.completed ||
    !fixed60.completed ||
    candidate.overflow ||
    candidate.fingerprint !== fixed60.fingerprint
  )
    throw new Error("recovery execution invalid");
  const { completed: _fixedComplete, ...fixedBill } = fixed60;
  const { completed: _candidateComplete, ...candidateBill } = candidate;
  const previous = old.rows.find((r) => id(r) === id(c));
  if (
    previous &&
    (JSON.stringify(fixedBill) !== JSON.stringify(previous.fixed60) ||
      JSON.stringify(candidateBill) !== JSON.stringify(previous.candidate) ||
      history.cost !== previous.historyCost)
  )
    throw new Error("successful frozen control changed");
  const legacyPrefix = failedIds.includes(id(c))
    ? ledger(c.scenario, base(false), true)
    : undefined;
  if (legacyPrefix?.completed) throw new Error("strict failure did not reproduce");
  if (
    legacyPrefix &&
    JSON.stringify(legacyPrefix.compactions) !==
      JSON.stringify(candidate.compactions.filter((p) => p.step < legacyPrefix.failureStep))
  )
    throw new Error("pre-recovery action prefix changed");
  if (previous && availability.some((s) => s.source !== "fitted"))
    throw new Error("unexpected recovery in successful control");
  return {
    profile: c.profile,
    sourceFixture: c.sourceFixture,
    seed: c.seed,
    steps: c.steps,
    purpose: previous ? "frozen-best-worst-control" : "repair-known-hard-failure",
    historyCost: history.cost,
    fixed60: fixedBill,
    candidate: candidateBill,
    vsFixed60: candidate.cost / fixed60.cost - 1,
    preservedSuccessfulBill: previous ? true : null,
    legacyPrefix,
    modelUsage: {
      fitted: availability.filter((s) => s.source === "fitted").length,
      retained: availability.filter((s) => s.source === "retained").length,
      unavailable: availability.filter((s) => s.source === "unavailable").length,
      maxObservationsSinceFit: Math.max(...availability.map((s) => s.observationsSinceFit)),
      nonFitted: availability.filter((s) => s.source !== "fitted"),
    },
  };
}
async function main() {
  const meta = metadata();
  const dir = resolve(root, "traces/model-recovery-cache", meta.key);
  mkdirSync(dir, { recursive: true });
  const workerAt = process.argv.indexOf("--worker");
  if (workerAt >= 0) {
    const slot = Number(process.argv[workerAt + 1]);
    if (slot !== 0 && slot !== 1) throw new Error("invalid worker slot");
    for (let index = slot; index < cases.length; index += 2) {
      const path = resolve(dir, `${index}.json`);
      if (!existsSync(path)) {
        const result = execute(index);
        if (JSON.stringify(metadata()) !== JSON.stringify(meta))
          throw new Error("sources changed during run");
        writeFileSync(`${path}.tmp`, JSON.stringify({ metadata: meta, result }));
        renameSync(`${path}.tmp`, path);
      }
      console.log(`model recovery case ${index + 1}/${cases.length}: ${selectedIds[index]}`);
    }
    return;
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
              code === 0 ? accept() : reject(new Error(`worker failed: ${code}`));
            });
          }),
      ),
    );
  } catch (error) {
    for (const child of active) child.kill();
    throw error;
  }
  if (JSON.stringify(metadata()) !== JSON.stringify(meta))
    throw new Error("sources changed during run");
  const rows = cases.map((_, i) => {
    const saved = JSON.parse(readFileSync(resolve(dir, `${i}.json`), "utf8")) as {
      metadata: ReturnType<typeof metadata>;
      result: ReturnType<typeof execute>;
    };
    if (
      JSON.stringify(saved.metadata) !== JSON.stringify(meta) ||
      id(saved.result) !== selectedIds[i]
    )
      throw new Error("cache mismatch");
    return saved.result;
  });
  const result = {
    kind: "foldpoint.model-recovery.v1",
    metadata: meta,
    externalCalls: 0,
    paidCalls: 0,
    rows,
    gate: {
      completed: rows.length === selectedIds.length,
      repaired: rows.filter((r) => r.purpose === "repair-known-hard-failure").length,
      controlsUnchanged: rows.filter((r) => r.preservedSuccessfulBill).length,
      promotedToPi: false,
    },
    limitations: [
      "Only two known failures and predeclared best/worst successful controls per price were re-executed. Not a new full 252-case matrix or independent heldout set.",
      "5% feedback tolerance is an explicit drift heuristic, not a calibrated confidence bound or extrapolation guarantee. Compatibility remains host-owned.",
      "All ordinary/summary/rebuild fees are charged. Frequency and synthetic savings do not establish real task quality. Defaults and Pi timing unchanged.",
    ],
  };
  writeFileSync(
    resolve(root, "benchmarks/reports/model-recovery.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(JSON.stringify(result.gate));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
