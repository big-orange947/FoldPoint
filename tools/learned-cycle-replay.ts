/** Full-bill synthetic execution of the supported selector; not a Pi experiment. */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompactorTokenModel } from "../src/experimental-compactor";
import { costOfCall, resolveUnitPrices } from "../src/pricing";
import { chooseSupportedCycle } from "./learned-cycle-choice";
import { PiImmediateRetentionLearner } from "./pi-retention-learner";

export interface LearnedReplayWorld {
  steps: number;
  growth: number;
  readRatio: number;
  law: "fixed" | "ratio" | "affine";
  history: "cold" | "past-wide";
}
const binding = {
  profileBinding: "a".repeat(64),
  compactorBinding: "b".repeat(64),
  estimatorId: "synthetic-host/v1",
};
function actualAfter(law: LearnedReplayWorld["law"], before: number) {
  return Math.min(
    before,
    Math.round(law === "fixed" ? 30000 : law === "ratio" ? before * 0.07 : 12000 + before * 0.06),
  );
}

export function executeLearnedReplay(world: LearnedReplayWorld, policy: "supported" | "fixed60") {
  if (
    !Number.isSafeInteger(world.steps) ||
    world.steps <= 0 ||
    world.steps > 10000 ||
    !Number.isFinite(world.growth) ||
    world.growth <= 0 ||
    world.growth > 100000 ||
    !Number.isFinite(world.readRatio) ||
    world.readRatio <= 0 ||
    world.readRatio > 1 ||
    !["fixed", "ratio", "affine"].includes(world.law) ||
    !["cold", "past-wide"].includes(world.history)
  )
    throw new RangeError("invalid replay world");
  const learner = new PiImmediateRetentionLearner(binding, {
    beforeErrorTokens: 0,
    afterErrorTokens: 0,
    driftToleranceRatio: 0.05,
  });
  let sequence = 0;
  const observe = (before: number, after: number) =>
    learner.observe({
      v: 1,
      source: "pi-compaction-result-estimatedTokensAfter",
      binding: binding.profileBinding,
      compactorBinding: binding.compactorBinding,
      sequence: ++sequence,
      beforeTokens: before,
      afterTokens: after,
    });
  // Explicit past metadata, shared by both arms. Not collected from the future task.
  if (world.history === "past-wide")
    for (const before of [100000, 350000, 700000]) observe(before, actualAfter(world.law, before));
  const prices = resolveUnitPrices({
    inputPerMillion: 0.3,
    outputPerMillion: 1.2,
    cacheReadPerMillion: 0.3 * world.readRatio,
  });
  const billingModel: CompactorTokenModel = {
    after: { slope: 0.1, intercept: 20000, residual: 0 }, // Poison/legacy prior: selector must ignore it.
    output: { slope: 0.002, intercept: 100, residual: 0 },
    samples: 0,
    minBefore: 0,
    maxBefore: 700000,
    summaryInputCostPerToken: prices.inputPerToken,
  };
  let context = 100000,
    prefix = 100000,
    growth: number | undefined;
  let ordinaryCost = 0,
    summaryCost = 0,
    offeredGrowth = 0,
    maxPrompt = 0;
  const reasons: Record<string, number> = {};
  const actions: Array<{ step: number; before: number; after: number; reason: string }> = [];
  const decisions: Array<{
    step: number;
    boundary: number;
    usedLearnedModel: boolean;
    reason: string;
  }> = [];
  for (let step = 0; step < world.steps; step++) {
    const choice =
      policy === "supported"
        ? chooseSupportedCycle({
            contextTokens: context,
            growthTokens: growth,
            prices,
            billingModel,
            retention: learner.snapshot(),
            expectedBasis: learner.snapshot().basis,
            softBoundary: 500000,
            fallbackBoundary: 600000,
            forceBoundary: 700000,
          })
        : {
            action: context >= 700000 ? "FORCE" : context >= 600000 ? "COMPACT" : "KEEP",
            boundary: 600000,
            reason: "fixed60",
            usedLearnedModel: false,
          };
    reasons[choice.reason] = (reasons[choice.reason] ?? 0) + 1;
    decisions.push({
      step,
      boundary: choice.boundary,
      usedLearnedModel: choice.usedLearnedModel,
      reason: choice.reason,
    });
    if (choice.action !== "KEEP") {
      const before = context;
      const output = Math.ceil(before * 0.002 + 100);
      summaryCost += before * prices.inputPerToken + output * prices.outputPerToken;
      context = actualAfter(world.law, before);
      prefix = 0;
      actions.push({ step, before, after: context, reason: choice.reason });
      observe(before, context); // AFTER the action; no future outcome enters the choice.
    }
    maxPrompt = Math.max(maxPrompt, context);
    ordinaryCost += costOfCall(
      prices,
      context,
      { prefixTokens: prefix, aliveProbability: 1, cachingInPlay: prices.hasCacheDiscount },
      300,
    );
    prefix = context;
    const addition = Math.round(world.growth * ([0.8, 1, 1.2, 0.9, 1.1][step % 5] ?? 1));
    offeredGrowth += addition;
    context += addition;
    growth = growth === undefined ? addition : 0.8 * growth + 0.2 * addition;
  }
  return {
    policy,
    ordinaryCalls: world.steps,
    ordinaryCost,
    summaryCost,
    total: ordinaryCost + summaryCost,
    offeredGrowth,
    maxPrompt,
    compactions: actions.length,
    actions,
    decisions,
    reasons,
    finalState: learner.snapshot(),
  };
}

export function runLearnedReplay() {
  const cells: Array<{
    world: LearnedReplayWorld;
    supported: ReturnType<typeof executeLearnedReplay>;
    baseline: ReturnType<typeof executeLearnedReplay>;
  }> = [];
  for (const steps of [40, 160, 480])
    for (const growth of [6000, 22000])
      for (const readRatio of [0.02, 0.2])
        for (const law of ["fixed", "ratio", "affine"] as const)
          for (const history of ["cold", "past-wide"] as const) {
            const world = { steps, growth, readRatio, law, history };
            cells.push({
              world,
              supported: executeLearnedReplay(world, "supported"),
              baseline: executeLearnedReplay(world, "fixed60"),
            });
          }
  const summary = ["cold", "past-wide"].map((history) => {
    const rows = cells.filter((c) => c.world.history === history);
    const total = rows.reduce((n, c) => n + c.supported.total, 0),
      baseline = rows.reduce((n, c) => n + c.baseline.total, 0);
    return {
      history,
      cells: rows.length,
      wins: rows.filter((c) => c.supported.total < c.baseline.total - 1e-10).length,
      ties: rows.filter((c) => Math.abs(c.supported.total - c.baseline.total) <= 1e-10).length,
      losses: rows.filter((c) => c.supported.total > c.baseline.total + 1e-10).length,
      total,
      baseline,
      relativeDifference: total / baseline - 1,
      learnedDecisions: rows.reduce(
        (n, c) => n + c.supported.decisions.filter((d) => d.usedLearnedModel).length,
        0,
      ),
    };
  });
  return {
    runner: "foldpoint.learned-cycle-replay.v1",
    paidCalls: 0,
    realTask: false,
    livePolicyChanged: false,
    summary,
    cells,
    limitations: [
      "Synthetic warm-cache successful single-request summaries only; no TTL, quality or failure model.",
      "Past-wide is explicitly supplied compatible synthetic history, not free newly collected training or a cold-start result.",
      "Cold-start refusal can remain at fixed60 indefinitely when observed spans stay narrow; no automatic exploration is hidden here.",
      "Supported nominal model and residual shrink guard are heuristics, not a confidence bound or full Pi risk rollout.",
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out" || !args[1] || args[1].startsWith("--"))
    throw new Error("usage: --out <fresh JSON path>");
  if (existsSync(args[1])) throw new Error("Refusing to overwrite replay");
  const report = runLearnedReplay();
  writeFileSync(args[1], `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
}
