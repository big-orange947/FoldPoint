/** Steady warm-cache diagnostic, not a finite-task decision or quality guarantee. */
import { type CompactorTokenModel, predictCompactorTokens } from "./experimental-compactor";
import { costOfCall, type UnitPrices } from "./pricing";

export interface CycleBilling {
  /** Explicit hypothetical/host contract; undefined means no summary cache. */
  summarySharedPrefixRatio?: number;
  /** An extra request, not a free prefix write. Undefined disables it. */
  prewarmOutputTokens?: number;
}

function validateModel(model: CompactorTokenModel): void {
  for (const coefficient of [model.after, model.output])
    for (const value of [coefficient.slope, coefficient.intercept, coefficient.residual])
      if (!Number.isFinite(value) || value < 0) throw new RangeError("invalid cycle coefficient");
  if (!Number.isFinite(model.summaryInputCostPerToken) || model.summaryInputCostPerToken < 0)
    throw new RangeError("invalid summary input price");
}

export function validateCycleBilling(billing: CycleBilling): void {
  if (
    billing.summarySharedPrefixRatio !== undefined &&
    (!Number.isFinite(billing.summarySharedPrefixRatio) ||
      billing.summarySharedPrefixRatio < 0 ||
      billing.summarySharedPrefixRatio > 1)
  )
    throw new RangeError("invalid summary prefix ratio");
  if (
    billing.prewarmOutputTokens !== undefined &&
    (!Number.isSafeInteger(billing.prewarmOutputTokens) || billing.prewarmOutputTokens < 0)
  )
    throw new RangeError("invalid prewarm output tokens");
}

export function summaryBill(
  prices: UnitPrices,
  model: CompactorTokenModel,
  before: number,
  prefix: number,
  alive: number,
  billing: CycleBilling,
  stressed = false,
) {
  validateCycleBilling(billing);
  validateModel(model);
  if (!Number.isFinite(prefix) || prefix < 0 || !Number.isFinite(alive) || alive < 0 || alive > 1)
    throw new RangeError("invalid summary cache state");
  const output = predictCompactorTokens(model, before, stressed).outputTokens;
  return summaryUsageBill(
    prices,
    before,
    output,
    prefix,
    alive,
    billing,
    model.summaryInputCostPerToken,
  );
}

/** Actual usage and predicted usage share billing, but never share token ground truth. */
export function summaryUsageBill(
  prices: UnitPrices,
  before: number,
  output: number,
  prefix: number,
  alive: number,
  billing: CycleBilling,
  inputPerToken = prices.inputPerToken,
) {
  validateCycleBilling(billing);
  for (const value of [before, output, prefix, inputPerToken])
    if (!Number.isFinite(value) || value < 0) throw new RangeError("invalid summary usage");
  if (!Number.isFinite(alive) || alive < 0 || alive > 1)
    throw new RangeError("invalid cache survival");
  return billing.summarySharedPrefixRatio === undefined
    ? before * inputPerToken + output * prices.outputPerToken
    : costOfCall(
        prices,
        before,
        {
          prefixTokens: Math.max(0, prefix) * billing.summarySharedPrefixRatio,
          aliveProbability: alive,
          cachingInPlay: prices.hasCacheDiscount,
        },
        output,
      );
}

/** Separate prewarm is billed once; ordinary first replay then reads its new prefix. */
export function postCompactBill(
  prices: UnitPrices,
  after: number,
  cachingInPlay: boolean,
  billing: CycleBilling,
) {
  validateCycleBilling(billing);
  if (!Number.isFinite(after) || after < 0) throw new RangeError("invalid post-compaction size");
  const write = costOfCall(prices, after, { prefixTokens: 0, aliveProbability: 0, cachingInPlay });
  if (billing.prewarmOutputTokens === undefined) return { prewarm: 0, ordinary: write };
  return {
    prewarm: write + billing.prewarmOutputTokens * prices.outputPerToken,
    ordinary: costOfCall(prices, after, {
      prefixTokens: after,
      aliveProbability: 1,
      cachingInPlay,
    }),
  };
}

/** Exact bill for n ordinary calls BETWEEN summaries, with deterministic positive growth. */
export function cycleBill(
  prices: UnitPrices,
  model: CompactorTokenModel,
  after: number,
  ordinaryCalls: number,
  growth: number,
  billing: CycleBilling,
  ordinaryOutput = 0,
) {
  if (
    !Number.isSafeInteger(ordinaryCalls) ||
    ordinaryCalls < 1 ||
    ordinaryCalls > 256 ||
    !Number.isFinite(after) ||
    after < 0 ||
    !Number.isFinite(growth) ||
    growth <= 0 ||
    !Number.isFinite(ordinaryOutput) ||
    ordinaryOutput < 0
  )
    throw new RangeError("invalid cycle");
  const before = after + ordinaryCalls * growth;
  const summary = summaryBill(prices, model, before, before - growth, 1, billing);
  const first = postCompactBill(prices, after, prices.hasCacheDiscount, billing);
  const reads =
    (ordinaryCalls - 1) * after + (growth * (ordinaryCalls - 1) * (ordinaryCalls - 2)) / 2;
  const later = prices.hasCacheDiscount
    ? reads * prices.cacheReadPerToken + (ordinaryCalls - 1) * growth * prices.inputPerToken
    : ((ordinaryCalls - 1) * after + (growth * ordinaryCalls * (ordinaryCalls - 1)) / 2) *
      prices.inputPerToken;
  const output = ordinaryCalls * ordinaryOutput * prices.outputPerToken;
  const total = summary + first.prewarm + first.ordinary + later + output;
  return {
    before,
    after,
    ordinaryCalls,
    summaryCalls: 1,
    prewarmCalls: billing.prewarmOutputTokens === undefined ? 0 : 1,
    summaryCost: summary,
    prewarmCost: first.prewarm,
    ordinaryCost: first.ordinary + later + output,
    total,
    costPerOrdinaryCall: total / ordinaryCalls,
  };
}

/** Fixed-call stable cycles for an affine retained-size model. No task endpoint or q. */
export function stableCycleCandidates(
  prices: UnitPrices,
  model: CompactorTokenModel,
  growth: number,
  maxBefore: number,
  billing: CycleBilling,
  minCalls = 3,
) {
  validateModel(model);
  validateCycleBilling(billing);
  if (
    !Number.isSafeInteger(minCalls) ||
    minCalls < 1 ||
    minCalls > 256 ||
    !Number.isFinite(maxBefore) ||
    maxBefore <= 0 ||
    !Number.isFinite(growth) ||
    growth <= 0
  )
    throw new RangeError("invalid cycle bounds");
  if (model.after.slope < 0 || model.after.slope >= 1 || model.after.intercept < 0)
    throw new RangeError("non-shrinking affine model");
  const rows = [];
  for (let n = minCalls; n <= 256; n++) {
    const before = (model.after.intercept + n * growth) / (1 - model.after.slope);
    if (before > maxBefore) break;
    rows.push(cycleBill(prices, model, before - n * growth, n, growth, billing));
  }
  return rows;
}

/** Threshold cycles can alternate in length; iterate them instead of rounding to a fake stable n. */
export function thresholdCycleAverage(
  prices: UnitPrices,
  model: CompactorTokenModel,
  growth: number,
  boundary: number,
  billing: CycleBilling,
  minCalls = 3,
) {
  if (
    !Number.isFinite(boundary) ||
    boundary <= 0 ||
    !Number.isFinite(growth) ||
    growth <= 0 ||
    !Number.isSafeInteger(minCalls) ||
    minCalls < 1 ||
    minCalls > 256
  )
    throw new RangeError("invalid threshold cycle");
  let after = predictCompactorTokens(model, boundary).afterTokens;
  let total = 0;
  let calls = 0;
  for (let i = 0; i < 1100; i++) {
    const n = Math.max(minCalls, Math.ceil((boundary - after) / growth));
    const row = cycleBill(prices, model, after, n, growth, billing);
    if (i >= 100) {
      total += row.total;
      calls += n;
    }
    const next = predictCompactorTokens(model, row.before).afterTokens;
    if (next >= row.before) throw new RangeError("threshold cannot reclaim tokens");
    after = next;
  }
  return { costPerOrdinaryCall: total / calls, measuredCycles: 1000, ordinaryCalls: calls };
}
