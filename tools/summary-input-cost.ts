import { costOfUsage, type UnitPrices } from "../src/pricing";

export interface AggregateSummaryUsage {
  promptTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
}

/** Experimental, conditional on unchanged compactor/pricing/cache regime, not a tariff.
 * Feed completed aggregate summary usage, never ordinary/prewarm requests. Output is
 * learned separately. Consumers MUST use cycleBilling.summarySharedPrefixRatio=undefined:
 * this effective input rate already includes observed read/write discounts.
 */
export class SummaryInputCostLearner {
  private samples: Array<{ before: number; inputCost: number }> = [];
  private lastSequence = -1;

  constructor(private readonly binding: string) {}

  observe(input: {
    binding: string;
    sequence: number;
    success: boolean;
    beforeTokens: number;
    usage?: AggregateSummaryUsage;
    prices: UnitPrices;
  }): boolean {
    if (input.binding !== this.binding) return false;
    if (!Number.isSafeInteger(input.sequence) || input.sequence <= this.lastSequence) return false;
    this.lastSequence = input.sequence;
    const u = input.usage;
    if (
      !input.success ||
      !Number.isSafeInteger(input.beforeTokens) ||
      input.beforeTokens <= 0 ||
      !u ||
      ![u.promptTokens, u.cachedInputTokens, u.cacheWriteTokens, u.outputTokens].every(
        (v) => v !== undefined && Number.isSafeInteger(v) && v >= 0,
      ) ||
      (u.cachedInputTokens as number) + (u.cacheWriteTokens as number) >
        (u.promptTokens as number) ||
      ![
        input.prices.inputPerToken,
        input.prices.cacheReadPerToken,
        input.prices.cacheWritePerToken,
      ].every((v) => Number.isFinite(v) && v >= 0)
    )
      return false;
    const inputCost = costOfUsage(input.prices, {
      promptTokens: u.promptTokens as number,
      cachedInputTokens: u.cachedInputTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      outputTokens: 0,
    });
    if (!Number.isFinite(inputCost)) return false;
    this.samples.push({ before: input.beforeTokens, inputCost });
    if (this.samples.length > 8) this.samples.shift();
    return true;
  }

  snapshot(binding: string) {
    const compatible = binding === this.binding;
    const before = this.samples.reduce((n, s) => n + s.before, 0);
    return {
      source: "observed-aggregate-input-bill" as const,
      samples: compatible ? this.samples.length : 0,
      effectiveInputCostPerBeforeToken:
        compatible && before > 0
          ? this.samples.reduce((n, s) => n + s.inputCost, 0) / before
          : null,
      includesObservedCachePricing: true,
      estimatedOnly: true,
      canDrivePolicy: false,
    };
  }
}
