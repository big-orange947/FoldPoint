/** Research-only long-run selector. No task endpoint or future-growth input. */
import { costOfCall, type UnitPrices } from "../src/pricing";

export interface RatioCycleInput {
  context: number;
  growth?: number;
  retention: number;
  samples: number;
  prices: UnitPrices;
  summaryInputRate: number;
  summaryOutput: number;
  offset: number;
}

/** Deterministic threshold cycles; discard startup cycles instead of assuming fractional calls. */
export function ratioCycleCost(input: RatioCycleInput, boundary: number) {
  const { growth, retention, prices, offset } = input;
  for (const v of [input.summaryInputRate, input.summaryOutput, offset])
    if (!Number.isFinite(v) || v < 0) throw new Error("invalid cycle billing");
  if (
    growth === undefined ||
    !Number.isFinite(growth) ||
    growth <= 0 ||
    !Number.isFinite(retention) ||
    retention <= 0 ||
    retention >= 1 ||
    !Number.isFinite(boundary) ||
    boundary < 500000 ||
    boundary > 700000
  )
    throw new Error("invalid cycle input");
  let after = Math.round(boundary * retention),
    total = 0,
    calls = 0;
  for (let cycle = 0; cycle < 64; cycle++) {
    const n = Math.max(1, Math.ceil((boundary - after) / growth));
    const before = after + n * growth;
    if (before > 700000) return Infinity;
    const first = Math.max(0, after - offset);
    let bill = before * input.summaryInputRate + input.summaryOutput * prices.outputPerToken;
    bill += costOfCall(prices, first, {
      prefixTokens: 0,
      aliveProbability: 0,
      cachingInPlay: prices.hasCacheDiscount,
    });
    // Sum the ordinary warm reads and new tails in constant time when the offset is covered.
    if (after >= offset) {
      const reads = (n - 1) * first + (growth * (n - 1) * (n - 2)) / 2;
      bill += prices.hasCacheDiscount
        ? reads * prices.cacheReadPerToken + (n - 1) * growth * prices.inputPerToken
        : ((n - 1) * first + (growth * n * (n - 1)) / 2) * prices.inputPerToken;
    } else {
      const sum = (count: number) => {
        const start = Math.min(count, Math.max(0, Math.ceil((offset - after) / growth)));
        const positive = count - start;
        return (
          positive * (after - offset + start * growth) + (growth * positive * (positive - 1)) / 2
        );
      };
      const reads = sum(n - 1),
        prompts = sum(n);
      bill += prices.hasCacheDiscount
        ? reads * prices.cacheReadPerToken + (prompts - reads) * prices.inputPerToken
        : prompts * prices.inputPerToken;
    }
    if (cycle >= 8) {
      total += bill;
      calls += n;
    }
    after = Math.round(before * retention);
  }
  return total / calls;
}

export function chooseRatioCycle(input: RatioCycleInput) {
  for (const v of [input.context, input.summaryInputRate, input.summaryOutput, input.offset])
    if (!Number.isFinite(v) || v < 0) throw new Error("invalid selector input");
  if (
    !Number.isSafeInteger(input.samples) ||
    input.samples < 0 ||
    !Number.isFinite(input.retention) ||
    input.retention <= 0 ||
    input.retention >= 1
  )
    throw new Error("invalid retention evidence");
  if (input.context >= 700000)
    return {
      action: "FORCE" as const,
      reason: "safety",
      boundary: 700000,
      cost: null,
      source: "safety",
    };
  if (input.growth === undefined || !Number.isFinite(input.growth) || input.growth <= 0)
    return {
      action: input.context >= 600000 ? ("COMPACT" as const) : ("KEEP" as const),
      reason: "unknown-growth",
      boundary: 600000,
      cost: null,
      source: "fallback",
    };
  // Reserve one observed growth increment; unseen bursts can still overshoot.
  if (input.context + input.growth >= 700000)
    return {
      action: "COMPACT" as const,
      reason: "growth-safety-margin",
      boundary: 700000,
      cost: null,
      source: "safety",
    };
  if (input.context < 500000)
    return {
      action: "KEEP" as const,
      reason: "below-window",
      boundary: 600000,
      cost: null,
      source: "below-window",
    };
  let boundary = 600000,
    cost = Infinity;
  for (let b = 500000; b <= 700000; b += 10000) {
    const estimate = ratioCycleCost(input, b);
    if (estimate < cost) {
      boundary = b;
      cost = estimate;
    }
  }
  return {
    action: input.context >= boundary ? ("COMPACT" as const) : ("KEEP" as const),
    reason: Number.isFinite(cost) ? "ratio-cycle" : "no-safe-cycle-fallback",
    boundary,
    cost: Number.isFinite(cost) ? cost : null,
    source: input.samples === 0 ? "retention-prior" : "observed-retention",
  };
}
