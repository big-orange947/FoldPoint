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

/** The cache situation of a single call, as the caller understands it. */
export interface CallCacheState {
  /**
   * Tokens this prompt shares with the previously cached prefix: the part a live cache can
   * serve, and the part that has to be rewritten when the cache is not alive.
   */
  prefixTokens: number;
  /** Probability that the prefix is still usable. 0 means this call has to rewrite it. */
  aliveProbability: number;
  /**
   * False when caching is not in play for this call (no cache discount, caching disabled, or
   * nothing indicates a cached prefix): the prompt is then billed as plain input.
   */
  cachingInPlay: boolean;
}

/**
 * Cost of one call under the unified cache billing rule.
 *
 * - caching not in play -> the whole prompt at the input price;
 * - the prefix is served from a live cache -> the prefix at the cache-read price, the
 *   appended tail at the input price;
 * - the prefix is not alive (lapsed, or not built yet) -> **the whole prompt is written**, at
 *   the cache-write price;
 * - caching is in play but there is no prefix at all -> the call writes its prompt: there is
 *   nothing to read from.
 *
 * The rewrite case is deliberately about *this* call only: `aliveProbability` is a per-call
 * input, so a caller that wants to model later calls must pass its own forecast instead of
 * reusing this call's verdict. Charging the whole prompt at the write price is the same rule
 * the engine applies to the first replay after a compaction.
 */
export function costOfCall(
  prices: UnitPrices,
  promptTokens: number,
  cache: CallCacheState,
  outputTokens = 0,
): number {
  const prompt = clamp(promptTokens, 0, Number.MAX_SAFE_INTEGER);
  const output = clamp(outputTokens, 0, Number.MAX_SAFE_INTEGER);

  if (!cache.cachingInPlay) {
    return prompt * prices.inputPerToken + output * prices.outputPerToken;
  }

  const rewriteCost = prompt * prices.cacheWritePerToken + output * prices.outputPerToken;
  const prefixTokens = clamp(cache.prefixTokens, 0, prompt);
  if (prefixTokens <= 0) {
    return rewriteCost;
  }

  const alive = clamp(cache.aliveProbability, 0, 1);
  const aliveCost =
    prefixTokens * prices.cacheReadPerToken +
    (prompt - prefixTokens) * prices.inputPerToken +
    output * prices.outputPerToken;

  return alive * aliveCost + (1 - alive) * rewriteCost;
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
