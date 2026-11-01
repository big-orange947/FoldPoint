/** Research-only: compare actual threshold cycles, not a stable-cycle proxy with a different baseline. */
import { cycleBill } from "../src/experimental-cycle";
import { chooseSupportedCycle, type LearnedCycleInput } from "./learned-cycle-choice";

export function chooseWithBaselineGate(input: LearnedCycleInput) {
  const choice = chooseSupportedCycle(input);
  if (!choice.usedLearnedModel) return { ...choice, comparison: null };
  const fit = input.retention.model,
    lower = input.retention.minBefore,
    upper = input.retention.maxBefore;
  if (!fit || lower === null || upper === null || !input.growthTokens)
    throw new Error("missing supported model");
  const model = {
    ...input.billingModel,
    after: { slope: fit.slope, intercept: fit.floor, residual: fit.envelope },
  };
  const growth = input.growthTokens;
  const measure = (boundary: number) => {
    let after = Math.min(boundary, fit.floor + fit.slope * boundary),
      total = 0,
      calls = 0;
    for (let i = 0; i < 1100; i++) {
      const n = Math.max(4, Math.ceil((boundary - after) / growth));
      if (n > 256) return null;
      const row = cycleBill(input.prices, model, after, n, growth, {});
      if (row.before < lower || row.before > upper || row.before > input.forceBoundary) return null;
      const next = Math.min(row.before, fit.floor + fit.slope * row.before);
      if (next + fit.envelope >= row.before) return null;
      if (i >= 100) {
        total += row.total;
        calls += n;
      }
      after = next;
    }
    return total / calls;
  };
  const candidate = measure(choice.boundary),
    baseline = measure(input.fallbackBoundary);
  const comparison = { candidate, baseline, isForecast: true, isConfidenceInterval: false };
  if (candidate === null || baseline === null || candidate >= baseline)
    return {
      action:
        input.contextTokens >= input.fallbackBoundary ? ("COMPACT" as const) : ("KEEP" as const),
      boundary: input.fallbackBoundary,
      reason:
        candidate === null || baseline === null
          ? "unsupported-threshold-cycle"
          : "no-predicted-saving",
      usedLearnedModel: false,
      candidates: choice.candidates,
      comparison,
    };
  return { ...choice, comparison };
}
