/** Diagnostic bridge from metadata traces; no exact retention/calibration claim. */
import type { CompactorTokenModel } from "../src/experimental-compactor";
import type { FoldPointProfile, TraceEvent } from "../src/index";
import { resolveUnitPrices } from "../src/pricing";
import { SummaryInputCostLearner } from "./summary-input-cost";

export function summaryHistoryBinding(profile: FoldPointProfile) {
  const prices = resolveUnitPrices(profile.pricing);
  return JSON.stringify([
    profile.provider,
    profile.model,
    profile.contextWindowTokens,
    profile.compactorId,
    prices.inputPerToken,
    prices.outputPerToken,
    prices.cacheReadPerToken,
    prices.cacheWritePerToken,
    profile.pricing?.currency,
  ]);
}

export function buildSteadyHistory(
  events: readonly TraceEvent[],
  profile: FoldPointProfile,
  keepRecentTokens: number,
):
  | {
      model: CompactorTokenModel;
      samples: number;
      billingSamples: number;
      binding: string;
      retentionSource: string;
      estimatedOnly: true;
    }
  | undefined {
  if (!Number.isSafeInteger(keepRecentTokens) || keepRecentTokens < 0)
    throw new RangeError("invalid compactor configuration");
  const binding = summaryHistoryBinding(profile),
    learner = new SummaryInputCostLearner(binding);
  let currentBinding: string | undefined;
  const samples: Array<{ before: number; after: number; output: number }> = [];
  const billing: Array<{ before: number; output: number }> = [];
  let sequence = 0;
  for (const e of events) {
    if (e.type === "header") currentBinding = undefined;
    if (e.type === "decision") currentBinding = summaryHistoryBinding(e.profile);
    if (
      e.type !== "compaction" ||
      currentBinding !== binding ||
      !e.success ||
      e.beforeTokens <= 0 ||
      !e.usage
    )
      continue;
    if (
      !learner.observe({
        binding,
        sequence: sequence++,
        success: true,
        beforeTokens: e.beforeTokens,
        usage: e.usage,
        prices: resolveUnitPrices(profile.pricing),
      })
    )
      continue;
    billing.push({ before: e.beforeTokens, output: e.usage.outputTokens as number });
    if (billing.length > 8) billing.shift();
    if (e.afterTokens !== null && Number.isFinite(e.afterTokens) && e.afterTokens > 0) {
      samples.push({
        before: e.beforeTokens,
        after: e.afterTokens,
        output: e.usage.outputTokens as number,
      });
      if (samples.length > 8) samples.shift();
    }
  }
  const rate = learner.snapshot(binding).effectiveInputCostPerBeforeToken;
  if (!billing.length || rate === null) return undefined;
  const totalBefore = samples.reduce((n, s) => n + s.before, 0);
  const billingBefore = billing.reduce((n, s) => n + s.before, 0);
  const range = samples.length ? samples : billing;
  return {
    binding,
    samples: samples.length,
    billingSamples: billing.length,
    estimatedOnly: true,
    retentionSource: samples.length
      ? "prior-max-delayed-host-estimate-with-retained-budget"
      : "retention-prior-only-with-retained-budget",
    model: {
      // Legacy delayed sizes can contain a response/new-input tail. Do not present them
      // as clean compacted prompts or fit a falsely precise affine curve from them.
      after: {
        slope: Math.max(
          0.1,
          totalBefore > 0
            ? samples.reduce((n, s) => n + Math.max(0, s.after - keepRecentTokens), 0) / totalBefore
            : 0.1,
        ),
        intercept: keepRecentTokens,
        residual: 0,
      },
      output: {
        slope: Math.max(0.002, billing.reduce((n, s) => n + s.output, 0) / billingBefore),
        intercept: 0,
        residual: 0,
      },
      samples: samples.length,
      minBefore: Math.min(...range.map((s) => s.before)),
      maxBefore: Math.max(...range.map((s) => s.before)),
      summaryInputCostPerToken: rate,
    },
  };
}
