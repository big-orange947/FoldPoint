import { clamp } from "./math";
import type { FoldPointInput, FoldPointProfileState } from "./types";

/** Where the cache survival estimate came from. Useful for tests, logs and debugging. */
export type CacheSurvivalSource =
  | "cache-disabled"
  | "no-cache-discount"
  | "expiry-known"
  | "ttl-known"
  | "half-life"
  | "observed-hit-ratio"
  | "current-input"
  | "no-evidence";

export interface CacheSurvivalInput {
  timestamp: number;
  idleMs: number;
  contextTokens: number;
  cachedTokens: number;
  cachePolicy?: { ttlMs?: number; halfLifeMs?: number; disabled?: boolean } | undefined;
  cacheExpiresAt?: number | undefined;
  cacheHitRatioEma: number;
  cacheSamples: number;
  /** False when the provider has no cheaper cache read price; cache survival is then 0. */
  hasCacheDiscount: boolean;
}

export interface CacheSurvivalEstimate {
  /** Effective survival probability used by the cost model, in [0, 1]. */
  survival: number;
  source: CacheSurvivalSource;
}

/**
 * Fraction of the current prompt believed to sit in the cached prefix.
 *
 * With real request history this is the learned cache-hit EMA. With no history at all we
 * fall back to the host-reported cache coverage of the current context (spec 11.4).
 */
export function resolveCacheHitRatio(
  state: Pick<FoldPointProfileState, "cacheHitRatioEma" | "cacheSamples">,
  contextTokens: number,
  cachedTokens: number,
): number {
  if (state.cacheSamples > 0) {
    return clamp(state.cacheHitRatioEma, 0, 1);
  }
  if (contextTokens > 0 && cachedTokens > 0) {
    return clamp(cachedTokens / contextTokens, 0, 1);
  }
  return 0;
}

/** Idle time since the last real request: host-provided, else derived from state. */
export function resolveIdleMs(
  input: Pick<FoldPointInput, "idleMs" | "timestamp">,
  state: Pick<FoldPointProfileState, "lastRequestAt">,
): number {
  if (input.idleMs !== undefined) {
    return Math.max(0, input.idleMs);
  }
  if (state.lastRequestAt === undefined) {
    return 0;
  }
  return Math.max(0, input.timestamp - state.lastRequestAt);
}

/** Exact cache expiry: the current input wins over the value stored from the last request. */
export function resolveCacheExpiresAt(
  input: Pick<FoldPointInput, "cacheExpiresAt">,
  state: Pick<FoldPointProfileState, "lastCacheExpiresAt">,
): number | undefined {
  return input.cacheExpiresAt ?? state.lastCacheExpiresAt;
}

/**
 * Cache survival estimate.
 *
 * Resolution order (documented in docs/algorithm.md):
 * 1. no cache discount / cache disabled            -> 0
 * 2. exact expiry known                            -> 1 while valid, 0 after expiry
 * 3. fixed TTL known                               -> 1 while `idleMs < ttlMs`, else 0
 * 4. half-life known                               -> base * 2^(-idleMs / halfLifeMs)
 * 5. nothing known about decay                     -> base, undecayed
 * where `base` is the learned cache-hit EMA, or the current context's cache coverage when
 * no request has been observed yet.
 *
 * The estimate is a probability, never a claim about provider internals.
 */
export function estimateCacheSurvival(input: CacheSurvivalInput): CacheSurvivalEstimate {
  if (!input.hasCacheDiscount) {
    return { survival: 0, source: "no-cache-discount" };
  }
  if (input.cachePolicy?.disabled === true) {
    return { survival: 0, source: "cache-disabled" };
  }

  const base = resolveCacheHitRatio(
    { cacheHitRatioEma: input.cacheHitRatioEma, cacheSamples: input.cacheSamples },
    input.contextTokens,
    input.cachedTokens,
  );
  const baseSource: CacheSurvivalSource =
    input.cacheSamples > 0 ? "observed-hit-ratio" : "current-input";

  if (base <= 0) {
    return { survival: 0, source: "no-evidence" };
  }

  let idleSurvival = 1;
  let source: CacheSurvivalSource = baseSource;

  if (input.cacheExpiresAt !== undefined) {
    idleSurvival = input.timestamp < input.cacheExpiresAt ? 1 : 0;
    source = "expiry-known";
  } else {
    const ttlMs = input.cachePolicy?.ttlMs;
    const halfLifeMs = input.cachePolicy?.halfLifeMs;

    if (ttlMs !== undefined) {
      idleSurvival = input.idleMs < ttlMs ? 1 : 0;
      source = "ttl-known";
    } else if (halfLifeMs !== undefined && halfLifeMs > 0) {
      idleSurvival = 2 ** (-input.idleMs / halfLifeMs);
      source = "half-life";
    }
  }

  return { survival: clamp(base * idleSurvival, 0, 1), source };
}
