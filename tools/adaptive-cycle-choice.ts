/** Research-only selector. Current model and recent growth only; no future endpoint. */
import { costOfCall } from "../src/pricing";
import type { RatioCycleInput } from "./ratio-cycle-choice";
import { predictSize, type SizeModel } from "./retained-size-choice";

export function adaptiveCycleCost(input: RatioCycleInput, model: SizeModel, boundary: number) {
  const { growth, offset, prices } = input;
  if (
    growth === undefined ||
    !Number.isFinite(growth) ||
    growth <= 0 ||
    boundary < 500000 ||
    boundary > 700000
  )
    throw new Error("invalid cycle");
  let after = predictSize(model, boundary),
    total = 0,
    calls = 0;
  for (let i = 0; i < 64; i++) {
    const n = Math.max(1, Math.ceil((boundary - after) / growth)),
      before = after + n * growth;
    if (before > 700000) return Infinity;
    const sum = (count: number) => {
      const start = Math.min(count, Math.max(0, Math.ceil((offset - after) / growth))),
        k = count - start;
      return k * (after - offset + start * growth) + (growth * k * (k - 1)) / 2;
    };
    const first = Math.max(0, after - offset),
      reads = sum(n - 1);
    let bill = before * input.summaryInputRate + input.summaryOutput * prices.outputPerToken;
    bill += costOfCall(prices, first, {
      prefixTokens: 0,
      aliveProbability: 0,
      cachingInPlay: prices.hasCacheDiscount,
    });
    bill += prices.hasCacheDiscount
      ? reads * prices.cacheReadPerToken + (sum(n) - first - reads) * prices.inputPerToken
      : (sum(n) - first) * prices.inputPerToken;
    if (i >= 8) {
      total += bill;
      calls += n;
    }
    after = predictSize(model, before);
  }
  return total / calls;
}

export function chooseAdaptiveCycle(input: RatioCycleInput, model: SizeModel) {
  for (const v of [input.context, input.offset, input.summaryInputRate, input.summaryOutput])
    if (!Number.isFinite(v) || v < 0) throw new Error("invalid cycle input");
  predictSize(model, 500000);
  if (input.context >= 700000)
    return { action: "FORCE" as const, boundary: 700000, reason: "safety" };
  const growth = input.growth;
  if (growth === undefined || !Number.isFinite(growth) || growth <= 0)
    return {
      action: input.context >= 600000 ? ("COMPACT" as const) : ("KEEP" as const),
      boundary: 600000,
      reason: "unknown-growth",
    };
  if (input.context + growth >= 700000)
    return { action: "COMPACT" as const, boundary: 700000, reason: "growth-safety-margin" };
  if (input.context < 500000)
    return { action: "KEEP" as const, boundary: 600000, reason: "below-window" };
  let boundary = 600000,
    cost = Infinity;
  for (let b = 500000; b <= 700000; b += 10000) {
    const estimate = adaptiveCycleCost(input, model, b);
    if (estimate < cost) {
      boundary = b;
      cost = estimate;
    }
  }
  return {
    action: input.context >= boundary ? ("COMPACT" as const) : ("KEEP" as const),
    boundary,
    reason: "adaptive-cycle",
  };
}
