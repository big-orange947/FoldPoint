import { describe, expect, it } from "vitest";
import { estimateCacheModel, FoldPoint } from "../src/index";
import {
  BASE_TIMESTAMP,
  decideWith,
  expectAllMetricsFinite,
  HISTORY,
  makeProfile,
  profileWithCacheTtl,
  SESSION_HISTORY,
} from "./helpers";

const INPUT_PRICE = 3 / 1_000_000;
const CACHE_READ_PRICE = 0.3 / 1_000_000;

/** One decision with a single future call, so `estimatedKeepCost` *is* the replay cost. */
function replayCost(
  contextTokens: number,
  cachedTokens: number | undefined,
  profile = profileWithCacheTtl(60_000),
  idleMs = 0,
) {
  const input: Parameters<typeof decideWith>[0] = {
    contextTokens,
    profile,
    idleMs,
    expectedFutureCalls: 1,
  };
  if (cachedTokens !== undefined) {
    input.cachedTokens = cachedTokens;
  }
  return decideWith(input, HISTORY, SESSION_HISTORY);
}

describe("17.1-17.3 exact cache numbers", () => {
  it("17.1 prices a live cached prefix at the cache-read price", () => {
    const decision = replayCost(100_000, 80_000);

    expect(decision.metrics.estimatedCacheCoverageRatio).toBeCloseTo(0.8, 12);
    expect(decision.metrics.estimatedCacheAliveProbability).toBe(1);
    expect(decision.metrics.estimatedEffectiveCachedTokens).toBeCloseTo(80_000, 6);
    expect(decision.metrics.estimatedKeepCost).toBeCloseTo(0.084, 12);
    expect(decision.metrics.estimatedKeepCost).toBeCloseTo(
      80_000 * CACHE_READ_PRICE + 20_000 * INPUT_PRICE,
      12,
    );
  });

  it("17.3 charges the full input price when the cache is gone", () => {
    const decision = replayCost(100_000, 80_000, profileWithCacheTtl(1_000), 5_000);

    expect(decision.metrics.estimatedCacheCoverageRatio).toBeCloseTo(0.8, 12);
    expect(decision.metrics.estimatedCacheAliveProbability).toBe(0);
    expect(decision.metrics.estimatedEffectiveCachedTokens).toBe(0);
    expect(decision.metrics.estimatedKeepCost).toBeCloseTo(0.3, 12);
  });

  it("17.2 multiplies coverage by aliveness exactly once", () => {
    const profile = makeProfile({ cachePolicy: { halfLifeMs: 10_000 } });
    const decision = replayCost(100_000, 80_000, profile, 10_000);

    // coverage 0.8, alive 0.5 -> effective 40_000 tokens, i.e. an effective ratio of 0.4.
    expect(decision.metrics.estimatedCacheCoverageRatio).toBeCloseTo(0.8, 12);
    expect(decision.metrics.estimatedCacheAliveProbability).toBeCloseTo(0.5, 12);
    expect(decision.metrics.estimatedEffectiveCachedTokens).toBeCloseTo(40_000, 6);
    expect(decision.metrics.estimatedEffectiveCachedTokens / 100_000).toBeCloseTo(0.4, 12);
    // The double-discounted value would have been 0.8 * 0.8 * 0.5 = 0.32.
    expect(decision.metrics.estimatedEffectiveCachedTokens / 100_000).not.toBeCloseTo(0.32, 6);
    expect(decision.metrics.estimatedKeepCost).toBeCloseTo(
      40_000 * CACHE_READ_PRICE + 60_000 * INPUT_PRICE,
      12,
    );
  });
});

describe("cache coverage sources", () => {
  it("prefers the host-reported cached tokens", () => {
    const decision = decideWith(
      {
        contextTokens: 100_000,
        cachedTokens: 60_000,
        expectedFutureCalls: 1,
        profile: profileWithCacheTtl(60_000),
      },
      { ...HISTORY, cacheCoverageRatioEma: 0.9 },
      SESSION_HISTORY,
    );

    expect(decision.metrics.estimatedCacheCoverageRatio).toBeCloseTo(0.6, 12);
  });

  it("falls back to the learned coverage ratio", () => {
    const decision = decideWith(
      { contextTokens: 100_000, expectedFutureCalls: 1, profile: profileWithCacheTtl(60_000) },
      { ...HISTORY, cacheCoverageSamples: 3, cacheCoverageRatioEma: 0.9 },
      SESSION_HISTORY,
    );

    expect(decision.metrics.estimatedCacheCoverageRatio).toBeCloseTo(0.9, 12);
    expect(decision.metrics.estimatedEffectiveCachedTokens).toBeCloseTo(90_000, 6);
    expect(decision.metrics.estimatedKeepCost).toBeCloseTo(
      90_000 * CACHE_READ_PRICE + 10_000 * INPUT_PRICE,
      12,
    );
  });

  it("reports zero coverage when there is no data at all", () => {
    const decision = decideWith(
      { contextTokens: 100_000, expectedFutureCalls: 1 },
      { cacheCoverageSamples: 0, cacheCoverageRatioEma: 0 },
      {},
    );

    expect(decision.metrics.estimatedCacheCoverageRatio).toBe(0);
    expect(decision.metrics.estimatedEffectiveCachedTokens).toBe(0);
    expect(decision.metrics.estimatedCacheAliveProbability).toBe(0);
    expect(decision.metrics.estimatedKeepCost).toBeCloseTo(100_000 * INPUT_PRICE, 12);
  });
});

describe("cache aliveness sources", () => {
  const base = {
    timestamp: BASE_TIMESTAMP,
    idleMs: 0,
    contextTokens: 100_000,
    cachedTokens: 80_000,
    cacheCoverageRatioEma: 0.8,
    cacheCoverageSamples: 5,
    hasCacheDiscount: true,
  };

  it("is zero without a cache discount", () => {
    const model = estimateCacheModel({ ...base, hasCacheDiscount: false });

    expect(model.aliveProbability).toBe(0);
    expect(model.effectiveCachedTokens).toBe(0);
    expect(model.source).toBe("no-cache-discount");
  });

  it("is zero when the policy disables caching", () => {
    const model = estimateCacheModel({ ...base, cachePolicy: { disabled: true } });

    expect(model.aliveProbability).toBe(0);
    expect(model.source).toBe("cache-disabled");
  });

  it("honours an exact expiry", () => {
    expect(
      estimateCacheModel({ ...base, cacheExpiresAt: BASE_TIMESTAMP + 1 }).aliveProbability,
    ).toBe(1);
    expect(
      estimateCacheModel({ ...base, cacheExpiresAt: BASE_TIMESTAMP - 1 }).aliveProbability,
    ).toBe(0);
  });

  it("honours a fixed TTL", () => {
    const policy = { ttlMs: 60_000 };

    expect(
      estimateCacheModel({ ...base, cachePolicy: policy, idleMs: 59_999 }).aliveProbability,
    ).toBe(1);
    expect(
      estimateCacheModel({ ...base, cachePolicy: policy, idleMs: 60_000 }).aliveProbability,
    ).toBe(0);
  });

  it("decays with a half-life", () => {
    const policy = { halfLifeMs: 10_000 };

    expect(
      estimateCacheModel({ ...base, cachePolicy: policy, idleMs: 10_000 }).aliveProbability,
    ).toBeCloseTo(0.5, 12);
    expect(
      estimateCacheModel({ ...base, cachePolicy: policy, idleMs: 20_000 }).aliveProbability,
    ).toBeCloseTo(0.25, 12);
  });

  it("assumes aliveness when there is a candidate prefix and no expiry mechanism", () => {
    const model = estimateCacheModel(base);

    expect(model.source).toBe("assumed-alive");
    expect(model.aliveProbability).toBe(1);
    // The coverage EMA is an observed hit rate and must not be discounted a second time.
    expect(model.effectiveCachedTokens).toBeCloseTo(80_000, 6);
  });

  it("reports no candidate when there is nothing to be alive", () => {
    const model = estimateCacheModel({ ...base, cachedTokens: 0, cacheCoverageSamples: 0 });

    expect(model.source).toBe("no-candidate");
    expect(model.aliveProbability).toBe(0);
  });
});

describe("17.15 stale cache expiry", () => {
  it("a request without an exact expiry clears the previous one", () => {
    const profile = makeProfile({ cachePolicy: { ttlMs: 300 } });
    const foldPoint = new FoldPoint();
    const sessionId = "session-stale";

    // Request A reports an exact expiry at t=100.
    foldPoint.observeRequest(sessionId, profile, {
      timestamp: 0,
      promptTokens: 1_000,
      cachedInputTokens: 800,
      cacheExpiresAt: 100,
    });

    // Request B happens later and reports no expiry: the old one must not survive.
    foldPoint.observeRequest(sessionId, profile, {
      timestamp: 90,
      promptTokens: 1_000,
      cachedInputTokens: 800,
    });

    const decision = foldPoint.decide({
      sessionId,
      profile,
      timestamp: 110,
      contextTokens: 1_000,
      cachedTokens: 800,
    });

    // With the stale expiry the cache would be dead at t=110; with the TTL and B's own
    // request time (idle 20ms < 300ms) it is still alive.
    expect(decision.metrics.estimatedCacheAliveProbability).toBe(1);
    expect(foldPoint.getSessionState(sessionId, profile).cacheExpiresAt).toBeUndefined();
  });

  it("keeps the exact expiry when the request reports one again", () => {
    const profile = makeProfile({ cachePolicy: { ttlMs: 300 } });
    const foldPoint = new FoldPoint();
    const sessionId = "session-expiry";

    foldPoint.observeRequest(sessionId, profile, {
      timestamp: 0,
      promptTokens: 1_000,
      cacheExpiresAt: 100,
    });
    foldPoint.observeRequest(sessionId, profile, {
      timestamp: 90,
      promptTokens: 1_000,
      cacheExpiresAt: 500,
    });

    const decision = foldPoint.decide({
      sessionId,
      profile,
      timestamp: 110,
      contextTokens: 1_000,
      cachedTokens: 800,
    });

    expect(decision.metrics.estimatedCacheAliveProbability).toBe(1);
    expect(foldPoint.getSessionState(sessionId, profile).cacheExpiresAt).toBe(500);
  });
});

describe("cache monotonicity", () => {
  it("more cached tokens never make keeping the context more expensive", () => {
    const profile = profileWithCacheTtl(60_000);
    const costs = [0, 20_000, 60_000, 100_000, 140_000, 150_000].map(
      (cachedTokens) => replayCost(150_000, cachedTokens, profile).metrics.estimatedKeepCost,
    );

    for (let index = 1; index < costs.length; index += 1) {
      expect(costs[index] ?? 0).toBeLessThanOrEqual(costs[index - 1] ?? 0);
    }
  });

  it("idle time past the TTL never raises the alive probability", () => {
    const profile = profileWithCacheTtl(60_000);
    const probabilities = [0, 1_000, 30_000, 59_999, 60_000, 600_000].map(
      (idleMs) =>
        replayCost(150_000, 140_000, profile, idleMs).metrics.estimatedCacheAliveProbability,
    );

    for (let index = 1; index < probabilities.length; index += 1) {
      expect(probabilities[index] ?? 0).toBeLessThanOrEqual(probabilities[index - 1] ?? 0);
    }
  });

  it("never produces a non-finite metric for a disabled cache", () => {
    const profile = makeProfile({ cachePolicy: { disabled: true } });
    const decision = decideWith(
      { contextTokens: 150_000, cachedTokens: 140_000, profile },
      HISTORY,
      SESSION_HISTORY,
    );

    expectAllMetricsFinite(decision);
    expect(decision.metrics.estimatedCacheAliveProbability).toBe(0);
    expect(decision.metrics.estimatedKeepCost).toBeCloseTo(
      150_000 * INPUT_PRICE * decision.metrics.expectedFutureCalls,
      12,
    );
  });
});
