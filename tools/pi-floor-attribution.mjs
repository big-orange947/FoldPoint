// Read-only cross-scale diagnostic. Never writes into original traces or session files.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stableCycleCandidates } from "../src/experimental-cycle.ts";
import { costOfUsage, resolveUnitPrices } from "../src/pricing.ts";
import { predictRetainedFloor } from "./retained-floor.ts";

async function main() {
  const args = process.argv.slice(2);
  const names = [
    "--pi",
    "--v2-report",
    "--v2-audit",
    "--v2-feedback",
    "--fixed-report",
    "--fixed-session",
    "--out",
  ];
  for (let i = 0; i < args.length; i += 2)
    if (!names.includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--"))
      throw new Error("invalid args");
  assert(names.every((n) => args.includes(n)));
  assert.equal(args.length, names.length * 2);
  const value = (n) => args[args.indexOf(n) + 1];
  const out = resolve(value("--out"));
  assert(!existsSync(out));
  let networkAttempts = 0;
  const deny = () => {
    networkAttempts++;
    throw new Error("offline only");
  };
  globalThis.fetch = deny;
  http.request = deny;
  https.request = deny;
  syncBuiltinESMExports();
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  const read = (n) => readFileSync(value(n));
  const lines = (b) =>
    b
      .toString("utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((s) => JSON.parse(s));
  const reportBytes = read("--v2-report"),
    auditBytes = read("--v2-audit"),
    feedbackBytes = read("--v2-feedback"),
    fixedBytes = read("--fixed-report"),
    sessionBytes = read("--fixed-session");
  const report = JSON.parse(reportBytes),
    fixed = JSON.parse(fixedBytes);
  assert.equal(report.controller, "total-floor-v2-affine-risk");
  const candidate = report.arms.find((a) => a.arm === "dynamic");
  const baseline = fixed.arms.find((a) => a.arm === "fixed60");
  assert(candidate?.completed && baseline?.completed);
  assert.equal(report.manifestHash, fixed.manifestHash);
  assert.equal(candidate.pricingFingerprint, baseline.pricingFingerprint);
  const permits = lines(auditBytes).filter(
    (a) => a.applied && a.basis === "total-floor-v2" && a.resolution === "allow",
  );
  const feedback = lines(feedbackBytes);
  assert.equal(permits.length, candidate.compactions);
  assert.equal(feedback.length, candidate.compactions);
  const prices = resolveUnitPrices(permits[0].prediction.snapshot.input.profile.pricing);
  const piRoot = resolve(value("--pi"));
  assert.equal(
    sha(readFileSync(join(piRoot, "packages/coding-agent/dist/bundle/cli.js"))),
    report.steadyControl.piCliSha256,
  );
  const load = (p) => import(pathToFileURL(join(piRoot, p)).href);
  const [{ buildSessionProjection, CURRENT_SESSION_VERSION }, { estimateTokens }] =
    await Promise.all([
      load("packages/coding-agent/src/core/session-manager.ts"),
      load("packages/coding-agent/src/core/compaction/index.ts"),
    ]);
  const session = lines(sessionBytes);
  assert.equal(session[0].version, CURRENT_SESSION_VERSION);
  const entries = session.slice(1),
    checkpoints = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.type !== "compaction") continue;
    const old = baseline.compactionSizes[checkpoints.length];
    assert.equal(e.tokensBefore, old.before);
    const messages = buildSessionProjection(entries.slice(0, i + 1), e.id).messages;
    const after = messages.reduce((n, m) => n + estimateTokens(m), 0);
    const u = e.usage;
    assert(u && [u.input, u.cacheRead, u.cacheWrite, u.output].every(Number.isSafeInteger));
    assert([u.input, u.cacheRead, u.cacheWrite, u.output].every((n) => n >= 0));
    const cost = costOfUsage(prices, {
      promptTokens: u.input + u.cacheRead + u.cacheWrite,
      cachedInputTokens: u.cacheRead,
      cacheWriteTokens: u.cacheWrite,
      outputTokens: u.output,
    });
    checkpoints.push({
      before: e.tokensBefore,
      reconstructedAfter: after,
      delayedTraceAfter: old.after,
      totalRatioPriorAfter: predictRetainedFloor(
        { totalRatio: 0.1, recentBudgetTokens: 20000 },
        e.tokensBefore,
      ),
      summaryCost: cost,
    });
  }
  assert.equal(checkpoints.length, baseline.compactions);
  const fixedSummaryCost = checkpoints.reduce((n, c) => n + c.summaryCost, 0);
  assert(Math.abs(fixedSummaryCost - baseline.compactionCost) < 1e-10);
  const cycles = permits.map((a, i) => {
    const p = a.prediction,
      f = feedback[i];
    assert.equal(p.snapshot.input.contextTokens, f.beforeTokens);
    assert.equal(f.sequence, i + 1);
    return {
      sequence: f.sequence,
      stage: f.stage,
      completedCallsSincePrevious: i ? f.stage - feedback[i - 1].stage : null,
      selectedCalls: p.selected.ordinaryCalls,
      selectedBefore: p.selected.before,
      actualBefore: f.beforeTokens,
      selectedAfter: p.selected.after,
      immediateAfter: f.afterTokens,
      predictedSummaryCost: f.score.predictedSummaryCost,
      actualSummaryCost: f.score.actualSummaryCost,
      growthEstimate: p.snapshot.baseline.metrics.estimatedGrowthTokensPerCall,
    };
  });
  const mean = (items, pick) => items.reduce((n, r) => n + pick(r), 0) / items.length;
  // Sensitivity only: this recovered historical host estimate was NOT available to the live
  // controller. It is not a learned deployable model or a simulated replacement-policy bill.
  const first = permits[0].prediction;
  const floor = mean(checkpoints, (r) => r.reconstructedAfter);
  const fixedSizeRows = stableCycleCandidates(
    prices,
    {
      ...first.snapshot.options.compactorTokenModel,
      after: { slope: 0, intercept: floor, residual: 0 },
    },
    first.snapshot.baseline.metrics.estimatedGrowthTokensPerCall,
    first.snapshot.baseline.metrics.guardedForceBoundaryTokens,
    first.snapshot.options.cycleBilling,
    Math.max(1, first.snapshot.options.executionConstraints.minCallsBetweenCompactions + 1),
  ).filter(
    (r) =>
      r.before >= first.snapshot.options.executionConstraints.softWindowTokens &&
      r.before - r.after >= first.snapshot.options.executionConstraints.minReclaimTokens &&
      (r.before - r.after) / r.before >=
        first.snapshot.options.executionConstraints.minReclaimRatio,
  );
  const fixedSizeSelected = fixedSizeRows.reduce(
    (best, row) => (!best || row.costPerOrdinaryCall < best.costPerOrdinaryCall ? row : best),
    null,
  );
  const result = {
    runner: "foldpoint.pi-floor-attribution.v1",
    paidCalls: 0,
    networkAttempts,
    policyChanged: false,
    historicalTraceBackfilled: false,
    fixedCheckpointMethod:
      "offline Pi projection; host estimate only; source/build identity not proven by CLI hash",
    hashes: {
      v2Report: sha(reportBytes),
      v2Audit: sha(auditBytes),
      v2Feedback: sha(feedbackBytes),
      fixedReport: sha(fixedBytes),
      fixedSession: sha(sessionBytes),
    },
    fixedCheckpoints: checkpoints,
    candidateCycles: cycles,
    firstDecisionSensitivity: {
      original: first.selected,
      retrospectiveFixedSizeModel: fixedSizeSelected,
      historicalMeanHostSize: floor,
      onlyRetentionChanged: true,
      policyExecuted: false,
      realizedSavings: null,
    },
    summary: {
      fixedMeanBefore: mean(checkpoints, (r) => r.before),
      fixedMeanReconstructedAfter: mean(checkpoints, (r) => r.reconstructedAfter),
      fixedMeanPriorAfter: mean(checkpoints, (r) => r.totalRatioPriorAfter),
      fixedMeanRelativeAfterOverestimate: mean(
        checkpoints,
        (r) => (r.totalRatioPriorAfter - r.reconstructedAfter) / r.reconstructedAfter,
      ),
      candidateMeanImmediateAfter: mean(cycles, (r) => r.immediateAfter),
      candidateMeanActualInterval: mean(cycles.slice(1), (r) => r.completedCallsSincePrevious),
      candidateMeanPredictedInterval: mean(cycles.slice(1), (r) => r.selectedCalls),
      fixedSummaryCostReconciled: true,
    },
    limitations: [
      "Both scales are the same repeatedly examined development task, not a general compactor law.",
      "Source projection is not captured immediate feedback or provider tokens; historical delayed sizes are not clean labels.",
      "No counterfactual task execution, no corrected-policy savings estimate and no new fitted policy.",
      "Interval differences are descriptive; stochastic cache/content and cross-batch effects remain.",
    ],
  };
  assert.equal(networkAttempts, 0);
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(
    `${JSON.stringify({ fixedCheckpoints: checkpoints, summary: result.summary, paidCalls: 0 }, null, 2)}\n`,
  );
}
await main().catch(() => {
  process.stderr.write("Offline floor attribution failed validation; source files unchanged\n");
  process.exitCode = 1;
});
