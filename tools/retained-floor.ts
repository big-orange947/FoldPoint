/** Research v2: a TOTAL retained ratio and an overlapping recent-history budget.
 * Not exported by the SDK or wired into the frozen Pi controller.
 */
import type { CompactorTokenModel } from "../src/experimental-compactor";
import { type CycleBilling, cycleBill } from "../src/experimental-cycle";
import type { UnitPrices } from "../src/pricing";

export interface RetainedFloor {
  totalRatio: number;
  recentBudgetTokens: number;
}

function validate(retention: RetainedFloor) {
  if (
    !Number.isFinite(retention.totalRatio) ||
    retention.totalRatio < 0 ||
    retention.totalRatio >= 1 ||
    !Number.isSafeInteger(retention.recentBudgetTokens) ||
    retention.recentBudgetTokens < 0
  )
    throw new RangeError("invalid total-retention prior");
}

/** Budget is a conservative forecast floor, not a promise about Pi's actual retained messages. */
export function predictRetainedFloor(retention: RetainedFloor, before: number) {
  validate(retention);
  if (!Number.isFinite(before) || before < 0) throw new RangeError("invalid input size");
  return Math.min(before, Math.max(retention.totalRatio * before, retention.recentBudgetTokens));
}

/** Solve A=max(r*(A+n*g), B), then bill using the existing complete cycle bill.
 * A=max(B, r*n*g/(1-r)); unlike the affine r*T+B model this is piecewise.
 * The legacy model.after is deliberately not used, so local linearization cannot
 * leak into another cycle size. Its output model and effective input fee remain valid.
 */
export function retainedFloorCycles(
  prices: UnitPrices,
  billingModel: CompactorTokenModel,
  retention: RetainedFloor,
  growth: number,
  maxBefore: number,
  billing: CycleBilling,
  minCalls = 3,
) {
  validate(retention);
  if (
    !Number.isFinite(growth) ||
    growth <= 0 ||
    !Number.isFinite(maxBefore) ||
    maxBefore <= 0 ||
    !Number.isSafeInteger(minCalls) ||
    minCalls < 1 ||
    minCalls > 256
  )
    throw new RangeError("invalid cycle bounds");
  const rows = [];
  // Only after differs; summary/output/ordinary/prewarm costs use shared billing code.
  const costModel = { ...billingModel, after: { slope: 0, intercept: 0, residual: 0 } };
  for (let n = minCalls; n <= 256; n++) {
    const after = Math.max(
      retention.recentBudgetTokens,
      (retention.totalRatio * n * growth) / (1 - retention.totalRatio),
    );
    if (after + n * growth > maxBefore) break;
    rows.push(cycleBill(prices, costModel, after, n, growth, billing));
  }
  return rows;
}
