/** Experimental counterfactual: observed growth, explicitly assumed summary and cache models. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  costOfCall,
  costOfUsage,
  parseTraceJsonl,
  resolveUnitPrices,
  type TraceEvent,
  type UnitPrices,
} from "../src/index";
import { chooseSupportedCycle } from "./learned-cycle-choice";
import { matchSummaryFeedback } from "./match-summary-feedback";
import { PiImmediateRetentionLearner } from "./pi-retention-learner";

const binding = {
  profileBinding: "a".repeat(64),
  compactorBinding: "b".repeat(64),
  estimatorId: "simulation/v1",
};
const assumptions = { beforeErrorTokens: 0, afterErrorTokens: 0, driftToleranceRatio: 0.05 };

export function extractObservedGrowth(events: readonly TraceEvent[]) {
  const pending = new Map<string, number>();
  const seen = new Set<string>();
  let session: string | undefined,
    prior: number | undefined,
    initialContext: number | undefined,
    initialPrompt: number | undefined,
    skipped = 0;
  const growth: number[] = [];
  for (const event of events) {
    if (event.type === "decision") {
      session ??= event.sessionId;
      if (event.sessionId !== session || pending.has(event.callId) || seen.has(event.callId))
        throw new Error("ambiguous decision");
      pending.set(event.callId, event.input.contextTokens);
    } else if (event.type === "compaction" && event.success) {
      if (event.sessionId !== session) throw new Error("multiple sessions");
      prior = undefined;
    } else if (event.type === "request") {
      if (event.sessionId !== session || seen.has(event.callId))
        throw new Error("ambiguous request");
      seen.add(event.callId);
      const context = pending.get(event.callId);
      pending.delete(event.callId);
      if (
        context === undefined ||
        event.outcome !== "ok" ||
        event.usage.promptTokens === undefined
      ) {
        prior = undefined;
        skipped++;
        continue;
      }
      if (initialContext === undefined) {
        initialContext = context;
        initialPrompt = event.usage.promptTokens;
      }
      if (prior !== undefined) {
        const delta = context - prior;
        if (!Number.isSafeInteger(delta) || delta < 0) throw new Error("unsupported growth");
        growth.push(delta);
      }
      prior = context;
    } else if (event.type === "session_end") prior = undefined;
  }
  if (initialContext === undefined || initialPrompt === undefined || !growth.length || pending.size)
    throw new Error("incomplete growth source");
  return {
    initialContext,
    initialPrompt,
    growth,
    skipped,
    joins: "segments-concatenated" as const,
  };
}

export interface SimulationWorld {
  initialContext: number;
  initialPrompt: number;
  growth: readonly number[];
  prices: UnitPrices;
  retentionRatio: number;
  summaryInputRate: number;
  summaryOutput: number;
  ordinaryOutput: number;
}

export function simulateTraceWorld(
  world: SimulationWorld,
  policy: "fixed60" | "fixed50" | "supported",
) {
  if (
    !Number.isSafeInteger(world.initialContext) ||
    world.initialContext <= 0 ||
    !Number.isSafeInteger(world.initialPrompt) ||
    world.initialPrompt < 0 ||
    world.initialPrompt > world.initialContext ||
    !world.growth.length ||
    world.growth.some((g) => !Number.isSafeInteger(g) || g < 0) ||
    !Number.isFinite(world.retentionRatio) ||
    world.retentionRatio <= 0 ||
    world.retentionRatio >= 1 ||
    ![world.summaryInputRate, world.summaryOutput, world.ordinaryOutput].every(
      (n) => Number.isFinite(n) && n >= 0,
    )
  )
    throw new Error("invalid world");
  const learner = new PiImmediateRetentionLearner(binding, assumptions);
  const offset = world.initialContext - world.initialPrompt;
  let context = world.initialContext,
    prefix = 0,
    observedGrowth: number | undefined;
  let ordinaryCost = 0,
    summaryCost = 0,
    offeredGrowth = 0,
    summaries = 0,
    learnedChoices = 0,
    maxContext = 0,
    maxBeforeAction = 0,
    forceBoundaryOvershoots = 0;
  const actions: Array<{ step: number; before: number; after: number; reason: string }> = [];
  for (let step = 0; step <= world.growth.length; step++) {
    maxBeforeAction = Math.max(maxBeforeAction, context);
    if (context > 700000) forceBoundaryOvershoots++;
    const state = learner.snapshot();
    const choice =
      policy !== "supported"
        ? {
            action:
              context >= 700000
                ? "FORCE"
                : context >= (policy === "fixed50" ? 500000 : 600000)
                  ? "COMPACT"
                  : "KEEP",
            reason: policy,
            usedLearnedModel: false,
          }
        : chooseSupportedCycle({
            contextTokens: context,
            growthTokens: observedGrowth,
            prices: world.prices,
            billingModel: {
              after: { slope: 0.1, intercept: 0, residual: 0 },
              output: { slope: 0, intercept: world.summaryOutput, residual: 0 },
              samples: 0,
              minBefore: 0,
              maxBefore: 700000,
              summaryInputCostPerToken: world.summaryInputRate,
            },
            retention: state,
            expectedBasis: state.basis,
            softBoundary: 500000,
            fallbackBoundary: 600000,
            forceBoundary: 700000,
          });
    if (choice.usedLearnedModel) learnedChoices++;
    if (choice.action !== "KEEP") {
      const before = context;
      summaryCost +=
        before * world.summaryInputRate + world.summaryOutput * world.prices.outputPerToken;
      context = Math.round(before * world.retentionRatio);
      prefix = 0;
      summaries++;
      actions.push({ step, before, after: context, reason: choice.reason });
      const accepted = learner.observe({
        v: 1,
        source: "pi-compaction-result-estimatedTokensAfter",
        binding: binding.profileBinding,
        compactorBinding: binding.compactorBinding,
        sequence: summaries,
        beforeTokens: before,
        afterTokens: context,
      });
      if (accepted !== "accepted" && accepted !== "accepted-after-drift-reset")
        throw new Error("simulated observation rejected");
    }
    maxContext = Math.max(maxContext, context);
    const prompt = Math.max(0, context - offset);
    ordinaryCost += costOfCall(
      world.prices,
      prompt,
      { prefixTokens: prefix, aliveProbability: 1, cachingInPlay: world.prices.hasCacheDiscount },
      world.ordinaryOutput,
    );
    prefix = prompt;
    const addition = world.growth[step];
    if (addition !== undefined) {
      context += addition;
      offeredGrowth += addition;
      observedGrowth =
        observedGrowth === undefined ? addition : 0.8 * observedGrowth + 0.2 * addition;
    }
  }
  return {
    policy,
    ordinaryCalls: world.growth.length + 1,
    offeredGrowth,
    summaries,
    learnedChoices,
    ordinaryCost,
    summaryCost,
    totalCost: ordinaryCost + summaryCost,
    maxContext,
    maxBeforeAction,
    forceBoundaryOvershoots,
    actions,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 6)
    throw new Error(
      "Usage: trace-driven-simulation <growth-trace> <summary-trace> <feedback> <reference>",
    );
  const [growthBytes, summaryBytes, feedbackBytes, referenceBytes] = process.argv
    .slice(2)
    .map((p) => readFileSync(p));
  if (!growthBytes || !summaryBytes || !feedbackBytes || !referenceBytes)
    throw new Error("missing input");
  const decode = (b: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(b);
  const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const ref = JSON.parse(decode(referenceBytes));
  if (
    ref.rawSha256?.trace !== hash(summaryBytes) ||
    ref.rawSha256?.feedback !== hash(feedbackBytes)
  )
    throw new Error("feedback fingerprint mismatch");
  const a = parseTraceJsonl(decode(growthBytes)),
    b = parseTraceJsonl(decode(summaryBytes));
  const feedback = decode(feedbackBytes);
  if (a.errors.length || b.errors.length || !feedback.endsWith("\n"))
    throw new Error("invalid trace");
  const workload = extractObservedGrowth(a.events);
  const profile = a.events.find((e) => e.type === "decision")?.profile;
  if (profile?.pricing?.currency !== "USD") throw new Error("missing pricing");
  const prices = resolveUnitPrices(profile.pricing);
  const rows = matchSummaryFeedback(
    b.events,
    feedback
      .slice(0, -1)
      .split("\n")
      .map((line) => JSON.parse(line)),
  );
  const inputRate =
    rows.reduce(
      (n, r) =>
        n +
        costOfUsage(prices, { ...r.usage, outputTokens: 0 } as Parameters<typeof costOfUsage>[1]),
      0,
    ) / rows.reduce((n, r) => n + r.beforeTokens, 0);
  const output = rows.reduce((n, r) => n + Number(r.usage.outputTokens), 0) / rows.length;
  const world = {
    ...workload,
    prices,
    retentionRatio: 0.11,
    summaryInputRate: inputRate,
    summaryOutput: output,
    ordinaryOutput: 300,
  };
  const fixed = simulateTraceWorld(world, "fixed60"),
    supported = simulateTraceWorld(world, "supported");
  process.stdout.write(
    `${JSON.stringify(
      {
        paidCalls: 0,
        growthTraceSha256: hash(growthBytes),
        summaryTraceSha256: hash(summaryBytes),
        growthCount: workload.growth.length,
        skippedRequests: workload.skipped,
        joins: workload.joins,
        assumptions: {
          cache: "always-live-previous-prompt-reset-after-summary",
          hostProviderOffset: "constant-first-call",
          retentionRatio: world.retentionRatio,
          summaryInputRate: inputRate,
          summaryOutput: output,
          ordinaryOutput: 300,
          feedbackRole:
            "world-and-policy-billing-assumptions-use-complete-development-feedback; retention-learner-starts-empty",
          sampleRange: [
            Math.min(...rows.map((r) => r.beforeTokens)),
            Math.max(...rows.map((r) => r.beforeTokens)),
          ],
        },
        fixed,
        supported,
        limitations: [
          "counterfactual-not-real-replay",
          "segments-concatenated",
          "full-development-feedback-used-in-world",
          "summary-model-extrapolates",
          "quality-unmeasured",
        ],
      },
      null,
      2,
    )}\n`,
  );
}
