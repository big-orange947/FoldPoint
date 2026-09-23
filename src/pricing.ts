import { clamp } from "./math";
import type { PricingSnapshot, RequestObservation } from "./types";

/** Per-token prices derived from a {@link PricingSnapshot}. */
export interface UnitPrices {
  inputPerToken: number;
  outputPerToken: number;
  cacheReadPerToken: number;
  cacheWritePerToken: number;
  /** True only when the host told us that reading from cache is cheaper than plain input. */
  hasCacheDiscount: boolean;
  /** True when no real price was supplied and costs are denominated in tokens. */
  normalized: boolean;
}

const TOKENS_PER_MILLION = 1_000_000;

/**
 * Normalized token-cost mode: one token costs one unit of "currency".
 * Use it when no real price is known, so that decisions are still well defined.
 */
export function tokenOnlyPricing(): PricingSnapshot {
  return {
    currency: "TOKEN",
    inputPerMillion: TOKENS_PER_MILLION,
    outputPerMillion: TOKENS_PER_MILLION,
    source: "foldpoint:token-only",
  };
}

/** Validates a price snapshot. Throws `RangeError` on negative or non-finite prices. */
export function assertValidPricing(pricing: PricingSnapshot, label = "pricing"): void {
  const fields: Array<[string, number | undefined]> = [
    ["inputPerMillion", pricing.inputPerMillion],
    ["outputPerMillion", pricing.outputPerMillion],
    ["cacheReadPerMillion", pricing.cacheReadPerMillion],
    ["cacheWritePerMillion", pricing.cacheWritePerMillion],
  ];

  for (const [name, value] of fields) {
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new RangeError(`${label}.${name} must be a finite number, received ${String(value)}`);
    }
    if (value < 0) {
      throw new RangeError(`${label}.${name} must be >= 0, received ${value}`);
    }
  }
}

/**
 * Converts a snapshot into per-token prices.
 *
 * - No snapshot at all -> normalized token cost (1 unit per token).
 * - No `cacheReadPerMillion` -> cache reads cost the same as normal input, so no cache
 *   discount is assumed and cache survival cannot create fake savings.
 * - No `cacheWritePerMillion` -> rebuilding a cache prefix costs the normal input price.
 */
/**
 * True when a price snapshot carries no real currency: either no snapshot at all, or the
 * normalized token-cost mode from {@link tokenOnlyPricing}.
 *
 * Cost-*scale* learning is disabled in that mode, because there is no currency to compare
 * the modeled cost against, and a token count must never be reinterpreted as money.
 */
export function isTokenOnlyPricing(pricing?: PricingSnapshot): boolean {
  return pricing === undefined || pricing.currency === "TOKEN";
}

export function resolveUnitPrices(pricing?: PricingSnapshot): UnitPrices {
  if (!pricing) {
    return {
      inputPerToken: 1,
      outputPerToken: 1,
      cacheReadPerToken: 1,
      cacheWritePerToken: 1,
      hasCacheDiscount: false,
      normalized: true,
    };
  }

  assertValidPricing(pricing);

  const inputPerToken = pricing.inputPerMillion / TOKENS_PER_MILLION;
  const outputPerToken = pricing.outputPerMillion / TOKENS_PER_MILLION;
  const cacheReadPerToken =
    pricing.cacheReadPerMillion === undefined
      ? inputPerToken
      : pricing.cacheReadPerMillion / TOKENS_PER_MILLION;
  const cacheWritePerToken =
    pricing.cacheWritePerMillion === undefined
      ? inputPerToken
      : pricing.cacheWritePerMillion / TOKENS_PER_MILLION;

  return {
    inputPerToken,
    outputPerToken,
    cacheReadPerToken,
    cacheWritePerToken,
    hasCacheDiscount: cacheReadPerToken < inputPerToken,
    normalized: false,
  };
}

/**
 * Cost of one call's reported usage, in the snapshot's currency.
 *
 * `cacheWriteTokens` is treated as a subset of `promptTokens` (tokens written to cache on
 * this call are billed at the write price instead of the input price), so it is never
 * double counted.
 */
export function costOfUsage(
  prices: UnitPrices,
  usage: Pick<
    RequestObservation,
    "promptTokens" | "cachedInputTokens" | "cacheWriteTokens" | "outputTokens"
  >,
): number {
  const promptTokens = clamp(usage.promptTokens ?? 0, 0, Number.MAX_SAFE_INTEGER);
  const cachedTokens = clamp(usage.cachedInputTokens ?? 0, 0, promptTokens);
  const writeTokens = clamp(usage.cacheWriteTokens ?? 0, 0, promptTokens - cachedTokens);
  const uncachedTokens = promptTokens - cachedTokens - writeTokens;
  const outputTokens = clamp(usage.outputTokens ?? 0, 0, Number.MAX_SAFE_INTEGER);

  return (
    uncachedTokens * prices.inputPerToken +
    cachedTokens * prices.cacheReadPerToken +
    writeTokens * prices.cacheWritePerToken +
    outputTokens * prices.outputPerToken
  );
}
