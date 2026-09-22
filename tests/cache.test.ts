import { describe, expect, it } from "vitest";
import { estimateCacheSurvival } from "../src/index";
import {
  BASE_TIMESTAMP,
  decideWith,
  expectAllMetricsFinite,
  HISTORY,
  makeProfile,
  profileWithCacheTtl,
} from "./helpers";

const ACTION_RANK = { KEEP: 0, COMPACT: 1, FORCE: 2 } as const;

describe("17.2 cache behaviour", () => {
  it("6. more cached tokens never make compaction more aggressive", () => {
    const profile = profileWithCacheTtl(3_600_000);
    const shortHorizon = { ...HISTORY, reuseHorizonEma: 1, horizonSamples: 1 };
    const noCache = decideWith(
      { contextTokens: 150_000, cachedTokens: 0, idleMs: 0, profile },
      shortHorizon,
    );
    const muchCache = decideWith(
      { contextTokens: 150_000, cachedTokens: 120_000, idleMs: 0, profile },
      shortHorizon,
    );

    expect(noCache.action).toBe("COMPACT");
    expect(muchCache.action).toBe("KEEP");
    expect(muchCache.metrics.estimatedKeepCost).toBeLessThan(noCache.metrics.estimatedKeepCost);
    expect(muchCache.metrics.estimatedNetSaving).toBeLessThan(noCache.metrics.estimatedNetSaving);
    expect(ACTION_RANK[muchCache.action]).toBeLessThanOrEqual(ACTION_RANK[noCache.action]);
    expect(muchCache.reasons).toContain("CACHE_STILL_VALUABLE");
  });

  it("7. an expired cache makes compaction easier than a live cache", () => {
    const profile = profileWithCacheTtl(300_000);
    const alive = decideWith(
      { contextTokens: 150_000, cachedTokens: 140_000, idleMs: 0, profile },
      HISTORY,
    );
    const expired = decideWith(
      { contextTokens: 150_000, cachedTokens: 140_000, idleMs: 600_000, profile },
      HISTORY,
    );

    expect(alive.metrics.estimatedCacheSurvival).toBeCloseTo(0.9, 10);
    expect(expired.metrics.estimatedCacheSurvival).toBe(0);
    expect(expired.metrics.estimatedKeepCost).toBeGreaterThan(alive.metrics.estimatedKeepCost);
    expect(expired.metrics.estimatedNetSaving).toBeGreaterThan(alive.metrics.estimatedNetSaving);
    expect(ACTION_RANK[expired.action]).toBeGreaterThanOrEqual(ACTION_RANK[alive.action]);
  });

  it("8. a cheaper cache read price favours keeping the context", () => {
    const cheapProfile = makeProfile({
      pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 },
    });
    const priceyProfile = makeProfile({
      pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 2.9 },
    });
    const input = { contextTokens: 150_000, cachedTokens: 120_000, idleMs: 0 };

    const cheap = decideWith({ ...input, profile: cheapProfile }, HISTORY);
    const pricey = decideWith({ ...input, profile: priceyProfile }, HISTORY);

    expect(cheap.metrics.estimatedKeepCost).toBeLessThan(pricey.metrics.estimatedKeepCost);
    expect(cheap.metrics.estimatedNetSaving).toBeLessThan(pricey.metrics.estimatedNetSaving);
    expect(ACTION_RANK[cheap.action]).toBeLessThanOrEqual(ACTION_RANK[pricey.action]);
  });

  it("9. no cache support produces no NaN and no fake savings", () => {
    const noCacheReadPrice = makeProfile({ pricing: { inputPerMillion: 3, outputPerMillion: 15 } });
    const disabled = makeProfile({
      pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 },
      cachePolicy: { disabled: true },
    });

    for (const profile of [noCacheReadPrice, disabled]) {
      const decision = decideWith(
        { contextTokens: 150_000, cachedTokens: 120_000, profile },
        HISTORY,
      );
      expectAllMetricsFinite(decision);
      expect(decision.metrics.estimatedCacheSurvival).toBe(0);
      // Keeping the context costs the full uncached price: no cache benefit is invented.
      const uncachedReplayCost = 150_000 * (3 / 1_000_000);
      expect(decision.metrics.estimatedKeepCost).toBeCloseTo(
        uncachedReplayCost * decision.metrics.expectedFutureCalls,
        12,
      );
    }
  });

  it("10. an elapsed cacheExpiresAt is treated as expired", () => {
    const profile = profileWithCacheTtl(3_600_000);
    const expired = decideWith(
      {
        contextTokens: 150_000,
        cachedTokens: 140_000,
        profile,
        cacheExpiresAt: BASE_TIMESTAMP - 1,
      },
      HISTORY,
    );
    const valid = decideWith(
      {
        contextTokens: 150_000,
        cachedTokens: 140_000,
        profile,
        cacheExpiresAt: BASE_TIMESTAMP + 1_000,
      },
      HISTORY,
    );

    expect(expired.metrics.estimatedCacheSurvival).toBe(0);
    expect(valid.metrics.estimatedCacheSurvival).toBeCloseTo(0.9, 10);
    expect(expired.metrics.estimatedNetSaving).toBeGreaterThan(valid.metrics.estimatedNetSaving);
  });

  it("uses the expiry stored from the last request when the input does not carry one", () => {
    const profile = profileWithCacheTtl(3_600_000);
    const decision = decideWith(
      { contextTokens: 150_000, cachedTokens: 140_000, profile },
      { ...HISTORY, lastCacheExpiresAt: BASE_TIMESTAMP - 1 },
    );

    expect(decision.metrics.estimatedCacheSurvival).toBe(0);
  });
});

describe("cache survival estimation", () => {
  const base = {
    timestamp: BASE_TIMESTAMP,
    idleMs: 0,
    contextTokens: 100_000,
    cachedTokens: 80_000,
    cacheHitRatioEma: 0.8,
    cacheSamples: 5,
    hasCacheDiscount: true,
  };

  it("returns zero when there is no cache discount", () => {
    expect(estimateCacheSurvival({ ...base, hasCacheDiscount: false }).survival).toBe(0);
  });

  it("returns zero when the profile disables caching", () => {
    expect(estimateCacheSurvival({ ...base, cachePolicy: { disabled: true } }).survival).toBe(0);
  });

  it("honours a known TTL", () => {
    const policy = { ttlMs: 60_000 };
    expect(
      estimateCacheSurvival({ ...base, cachePolicy: policy, idleMs: 59_999 }).survival,
    ).toBeCloseTo(0.8, 12);
    expect(estimateCacheSurvival({ ...base, cachePolicy: policy, idleMs: 60_000 }).survival).toBe(
      0,
    );
  });

  it("decays with a half-life", () => {
    const policy = { halfLifeMs: 10_000 };
    expect(
      estimateCacheSurvival({ ...base, cachePolicy: policy, idleMs: 10_000 }).survival,
    ).toBeCloseTo(0.4, 12);
    expect(
      estimateCacheSurvival({ ...base, cachePolicy: policy, idleMs: 20_000 }).survival,
    ).toBeCloseTo(0.2, 12);
  });

  it("falls back to the current context's cache coverage when nothing was observed", () => {
    const estimate = estimateCacheSurvival({ ...base, cacheHitRatioEma: 0, cacheSamples: 0 });

    expect(estimate.source).toBe("current-input");
    expect(estimate.survival).toBeCloseTo(0.8, 12);
  });

  it("reports no evidence when there is no history and no cached tokens", () => {
    const estimate = estimateCacheSurvival({
      ...base,
      cacheHitRatioEma: 0,
      cacheSamples: 0,
      cachedTokens: 0,
    });

    expect(estimate.source).toBe("no-evidence");
    expect(estimate.survival).toBe(0);
  });
});
