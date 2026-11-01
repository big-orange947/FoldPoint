/** Experimental policy for simulation only; its priors are assumptions, not learned facts. */
import { costOfCall, type UnitPrices } from "../src/pricing";

export interface ColdStartInput {
  context: number;
  growth?: number;
  prices: UnitPrices;
  summaryInputRate: number;
  summaryOutput: number;
}

export function chooseColdStartCandidate(input: ColdStartInput) {
  const { context, growth, prices, summaryInputRate, summaryOutput } = input;
  if (![context, summaryInputRate, summaryOutput].every((v) => Number.isFinite(v) && v >= 0))
    throw new Error("invalid candidate input");
  if (context >= 700000) return { action: "FORCE" as const, reason: "safety" };
  if (context >= 600000) return { action: "COMPACT" as const, reason: "fixed60-fallback" };
  if (context < 500000 || growth === undefined || !Number.isFinite(growth) || growth <= 0)
    return { action: "KEEP" as const, reason: "insufficient-or-below-window" };

  // Fixed priors, not evidence about the user's task. Both stressed retention assumptions must win.
  const survival = (i: number) => 0.5 * 0.9 ** i + 0.5 * 0.98 ** i;
  const forecast = (compactNow: boolean, retained: number) => {
    let current = context,
      prefix = Math.max(0, current - growth),
      total = 0;
    for (let i = 0; i < 128; i++) {
      const weight = survival(i);
      if ((i === 0 && compactNow) || current >= 600000) {
        total += weight * (current * summaryInputRate + summaryOutput * prices.outputPerToken);
        current = Math.round(current * retained);
        prefix = 0;
      }
      total +=
        weight *
        costOfCall(prices, current, {
          prefixTokens: prefix,
          aliveProbability: 1,
          cachingInPlay: prices.hasCacheDiscount,
        });
      prefix = current;
      current += growth;
    }
    return total;
  };
  const savings = [0.1, 0.2].map(
    (retained) => forecast(false, retained) - forecast(true, retained),
  );
  const required = (context * summaryInputRate + summaryOutput * prices.outputPerToken) * 0.02;
  const minSaving = Math.min(...savings);
  return minSaving > required
    ? { action: "COMPACT" as const, reason: "stressed-prior-saving", minSaving }
    : { action: "KEEP" as const, reason: "stressed-prior-no-saving", minSaving };
}
