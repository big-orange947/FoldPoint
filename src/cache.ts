import { clamp, safeDivide } from "./math";
import type { FoldPointInput, FoldPointProfileLearningState, FoldPointSessionState } from "./types";

/**
 * Where the cache *alive probability* came from. Useful for tests, logs and debugging.
 * Coverage and aliveness are separate quantities by construction.
 */
export type CacheAliveSource =
  | "no-cache-discount"
  | "cache-disabled"
  | "expiry-known"
  | "ttl-known"
  | "half-life"
  | "assumed-alive"
  | "no-candidate";

export interface CacheModelInput {
  timestamp: number;
  idleMs: number;
  contextTokens: number;
  /** Tokens the host reports as served from the cache for the current prompt, if any. */
  cachedTokens?: number | undefined;
  cachePolicy?: { ttlMs?: number; halfLifeMs?: number; disabled?: boolean } | undefined;
  /** Exact expiry of the current prefix: input override first, else the session's value. */
  cacheExpiresAt?: number | undefined;
  cacheCoverageRatioEma: number;
  cacheCoverageSamples: number;
  /** False when the provider has no cheaper cache read price; aliveness is then 0. */
  hasCacheDiscount: boolean;
}

/** The two independent cache quantities, plus the tokens that actually matter for cost. */
export interface CacheModel {
  /** candidateCachedTokens / contextTokens, in [0, 1]. Coverage, not survival. */
  coverageRatio: number;
  /** Tokens that could be served from cache if the prefix is alive. */
  candidateCachedTokens: number;
  /** Probability that the candidate prefix is still usable, in [0, 1]. */
  aliveProbability: number;
  /** candidateCachedTokens * aliveProbability. */
  effectiveCachedTokens: number;
  /**
   * Probability that a *later* call still finds its prefix alive.
   *
   * This call's aliveness is a fact about this call: if the TTL has lapsed, this call must
   * rewrite the prefix. That is not evidence that every later call lapses too, so the
   * forecast does not inherit the binary verdict. It keeps the smooth form of a half-life
   * policy, and otherwise assumes the prefix written by this call is still there.
   */
  laterAliveProbability: number;
  /**
   * True when caching is actually in play for this call: a cache discount exists, caching is
   * not disabled, and either a candidate prefix was observed or the policy describes one.
   */
  cachingInPlay: boolean;
  source: CacheAliveSource;
}

/** Learned cache coverage ratio, or 0 when nothing was observed yet. */
export function resolveCacheCoverageRatio(
  learning: Pick<FoldPointProfileLearningState, "cacheCoverageRatioEma" | "cacheCoverageSamples">,
): number {
  if (learning.cacheCoverageSamples <= 0) {
    return 0;
  }
  return clamp(learning.cacheCoverageRatioEma, 0, 1);
}

/** Idle time since the last request *of this session*: host-provided, else derived. */
export function resolveIdleMs(
  input: Pick<FoldPointInput, "idleMs" | "timestamp">,
  session: Pick<FoldPointSessionState, "lastRequestAt">,
): number {
  if (input.idleMs !== undefined) {
    return Math.max(0, input.idleMs);
  }
  if (session.lastRequestAt === undefined) {
    return 0;
  }
  return Math.max(0, input.timestamp - session.lastRequestAt);
}

/** Exact cache expiry of the current prefix: the input wins over the session's stored value. */
export function resolveCacheExpiresAt(
  input: Pick<FoldPointInput, "cacheExpiresAt">,
  session: Pick<FoldPointSessionState, "cacheExpiresAt">,
): number | undefined {
  return input.cacheExpiresAt ?? session.cacheExpiresAt;
}

/** True when the policy itself says something about cache expiry. */
function hasExpiryPolicy(input: Pick<CacheModelInput, "cachePolicy" | "cacheExpiresAt">): boolean {
  return (
    input.cacheExpiresAt !== undefined ||
    input.cachePolicy?.ttlMs !== undefined ||
    (input.cachePolicy?.halfLifeMs !== undefined && input.cachePolicy.halfLifeMs > 0)
  );
}

/**
 * True when caching is in play for this call: there is a cache discount, caching is not
 * disabled, and either a prefix was observed or the policy describes one. A prompt is only
 * billed at the cache-write price when caching is in play.
 */
export function isCachingInPlay(
  input: Pick<CacheModelInput, "cachePolicy" | "cacheExpiresAt" | "hasCacheDiscount">,
  hasCandidate: boolean,
): boolean {
  if (!input.hasCacheDiscount || input.cachePolicy?.disabled === true) {
    return false;
  }
  return hasCandidate || hasExpiryPolicy(input);
}

/**
 * Probability that a *later* call finds its prefix alive: the forecast half of the cache
 * model, kept separate from this call's verdict.
 *
 * - caching not in play, or nothing indicates a prefix -> 0;
 * - a half-life is a distribution, so its smooth form is kept (it degrades instead of
 *   asserting a verdict, and it is the model's only way to express a cache that lapses
 *   sometimes);
 * - a hard TTL or an exact expiry is a statement about *this* call: the current call
 *   rewrites the prefix, so a later call starts from a live one. The model does not
 *   extrapolate one lapsed gap into the whole future call cycle.
 */
export function resolveLaterAliveProbability(
  input: Pick<CacheModelInput, "cachePolicy" | "cacheExpiresAt" | "hasCacheDiscount" | "idleMs">,
  hasCandidate: boolean,
): number {
  if (!isCachingInPlay(input, hasCandidate)) {
    return 0;
  }

  const halfLifeMs = input.cachePolicy?.halfLifeMs;
  const onlyHalfLifeDescribesExpiry =
    input.cacheExpiresAt === undefined &&
    input.cachePolicy?.ttlMs === undefined &&
    halfLifeMs !== undefined &&
    halfLifeMs > 0;
  if (onlyHalfLifeDescribesExpiry) {
    return clamp(2 ** (-Math.max(0, input.idleMs) / halfLifeMs), 0, 1);
  }

  return 1;
}

/**
 * The cache model: coverage and aliveness are computed separately and meet exactly once, in
 * `effectiveCachedTokens`. The coverage ratio is never multiplied into the cost formula a
 * second time.
 *
 * Coverage (how much of the context the cache *could* serve):
 * 1. `input.cachedTokens` when the host reports it;
 * 2. else `contextTokens * cacheCoverageRatioEma` when coverage was observed before;
 * 3. else 0.
 *
 * Alive probability (whether that prefix is still usable):
 * 1. no cache discount, or the policy disables caching -> 0;
 * 2. exact expiry known -> 1 while valid, 0 after it passes;
 * 3. fixed TTL known -> 1 while `idleMs < ttlMs`, else 0;
 * 4. half-life known -> `2^(-idleMs / halfLifeMs)`;
 * 5. nothing known about expiry -> 1 when a candidate prefix exists, else 0. The learned
 *    coverage EMA is already an observed hit rate, so it must not be discounted again.
 */
export function estimateCacheModel(input: CacheModelInput): CacheModel {
  const contextTokens = input.contextTokens;

  let candidateCachedTokens: number;
  if (input.cachedTokens !== undefined) {
    candidateCachedTokens = clamp(input.cachedTokens, 0, contextTokens);
  } else if (input.cacheCoverageSamples > 0) {
    candidateCachedTokens = clamp(
      contextTokens * clamp(input.cacheCoverageRatioEma, 0, 1),
      0,
      contextTokens,
    );
  } else {
    candidateCachedTokens = 0;
  }

  const coverageRatio = safeDivide(candidateCachedTokens, contextTokens, 0);

  let aliveProbability: number;
  let source: CacheAliveSource;

  if (!input.hasCacheDiscount) {
    aliveProbability = 0;
    source = "no-cache-discount";
  } else if (input.cachePolicy?.disabled === true) {
    aliveProbability = 0;
    source = "cache-disabled";
  } else if (input.cacheExpiresAt !== undefined) {
    aliveProbability = input.timestamp < input.cacheExpiresAt ? 1 : 0;
    source = "expiry-known";
  } else if (input.cachePolicy?.ttlMs !== undefined) {
    aliveProbability = input.idleMs < input.cachePolicy.ttlMs ? 1 : 0;
    source = "ttl-known";
  } else if (input.cachePolicy?.halfLifeMs !== undefined && input.cachePolicy.halfLifeMs > 0) {
    aliveProbability = 2 ** (-input.idleMs / input.cachePolicy.halfLifeMs);
    source = "half-life";
  } else if (candidateCachedTokens > 0) {
    aliveProbability = 1;
    source = "assumed-alive";
  } else {
    aliveProbability = 0;
    source = "no-candidate";
  }

  const clampedAlive = clamp(aliveProbability, 0, 1);
  const cachingInPlay = isCachingInPlay(input, candidateCachedTokens > 0);

  return {
    coverageRatio,
    candidateCachedTokens,
    aliveProbability: clampedAlive,
    effectiveCachedTokens: candidateCachedTokens * clampedAlive,
    laterAliveProbability: resolveLaterAliveProbability(input, candidateCachedTokens > 0),
    cachingInPlay,
    source,
  };
}
