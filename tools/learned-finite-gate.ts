/** Offline experiment: compare current compaction with waiting to fixed60 under an explicit survival assumption. */
import { costOfCall } from "../src/pricing";
import { chooseSupportedCycle, type LearnedCycleInput } from "./learned-cycle-choice";

export function chooseWithFiniteGate(input: LearnedCycleInput, continuationProbability: number) {
  if (
    !Number.isFinite(continuationProbability) ||
    continuationProbability < 0 ||
    continuationProbability > 1
  )
    throw new RangeError("invalid continuation probability");
  const choice = chooseSupportedCycle(input);
  if (!choice.usedLearnedModel || choice.action !== "COMPACT")
    return { ...choice, comparison: null };
  const fit = input.retention.model,
    low = input.retention.minBefore,
    high = input.retention.maxBefore;
  const growth = input.growthTokens;
  if (!fit || low === null || high === null || !growth) throw new Error("missing model");
  const horizon = 128,
    tailProbability = continuationProbability ** horizon;
  const forecast = (threshold: number) => {
    let context = input.contextTokens,
      prefix = Math.max(0, context - growth),
      sum = 0,
      weight = 1;
    for (let i = 0; i < horizon; i++) {
      if (context >= threshold || context >= input.forceBoundary) {
        if (context < low || context > high) return null;
        const after = Math.min(context, fit.floor + fit.slope * context);
        if (after + fit.envelope >= context) return null;
        sum +=
          weight *
          (context * input.billingModel.summaryInputCostPerToken +
            (input.billingModel.output.slope * context + input.billingModel.output.intercept) *
              input.prices.outputPerToken);
        context = after;
        prefix = 0;
      }
      sum +=
        weight *
        costOfCall(input.prices, context, {
          prefixTokens: prefix,
          aliveProbability: 1,
          cachingInPlay: input.prices.hasCacheDiscount,
        });
      prefix = context;
      context += growth;
      weight *= continuationProbability;
      if (weight === 0) break;
    }
    return sum;
  };
  const candidate = tailProbability <= 0.1 ? forecast(choice.boundary) : null;
  const baseline = tailProbability <= 0.1 ? forecast(input.fallbackBoundary) : null;
  const comparison = {
    candidate,
    baseline,
    continuationProbability,
    tailProbability,
    forecastOnly: true,
  };
  if (candidate === null || baseline === null || candidate >= baseline)
    return {
      action:
        input.contextTokens >= input.fallbackBoundary ? ("COMPACT" as const) : ("KEEP" as const),
      boundary: input.fallbackBoundary,
      reason: "finite-risk-fallback",
      usedLearnedModel: false,
      candidates: choice.candidates,
      comparison,
    };
  return { ...choice, comparison };
}
