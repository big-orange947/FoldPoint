/** Offline experiment: compare current compaction with waiting to fixed60 under an explicit survival assumption. */

import { estimateRuntimeDuration, type RuntimeDurationModel } from "../src/experimental-runtime";
import { costOfCall } from "../src/pricing";
import { chooseSupportedCycle, type LearnedCycleInput } from "./learned-cycle-choice";

export function chooseWithFiniteGate(
  input: LearnedCycleInput,
  duration: number | RuntimeDurationModel,
) {
  if (typeof duration === "number" && (!Number.isFinite(duration) || duration < 0 || duration > 1))
    throw new RangeError("invalid continuation probability");
  const horizon = 128;
  const survival =
    typeof duration === "number"
      ? Array.from({ length: horizon + 1 }, (_, i) => duration ** i)
      : estimateRuntimeDuration(duration, horizon, 0).survival;
  const choice = chooseSupportedCycle(input);
  if (!choice.usedLearnedModel || choice.action !== "COMPACT")
    return { ...choice, comparison: null };
  const fit = input.retention.model,
    low = input.retention.minBefore,
    high = input.retention.maxBefore;
  const growth = input.growthTokens;
  if (!fit || low === null || high === null || !growth) throw new Error("missing model");
  const tailProbability = survival[horizon] ?? 1;
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
      weight = survival[i + 1] ?? 0;
      if (weight === 0) break;
    }
    return sum;
  };
  const candidate = tailProbability <= 0.1 ? forecast(choice.boundary) : null;
  const baseline = tailProbability <= 0.1 ? forecast(input.fallbackBoundary) : null;
  const comparison = {
    candidate,
    baseline,
    continuationProbability: typeof duration === "number" ? duration : null,
    completedCalls: typeof duration === "number" ? null : duration.completedCalls,
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
