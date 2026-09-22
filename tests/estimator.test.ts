import { describe, expect, it } from "vitest";
import { decideFoldPoint, tokenOnlyPricing } from "../src/index";
import {
  BASE_TIMESTAMP,
  decideWith,
  expectAllMetricsFinite,
  HISTORY,
  makeInput,
  makeProfile,
  makeState,
  profileWithCacheTtl,
} from "./helpers";

describe("17.1 basic decisions", () => {
  it("1. low utilization with no meaningful gain -> KEEP", () => {
    const decision = decideWith({ contextTokens: 20_000, cachedTokens: 0 });

    expect(decision.action).toBe("KEEP");
    expect(decision.reasons).toContain("NO_POSITIVE_SAVING");
    expect(decision.metrics.utilization).toBeCloseTo(0.1, 10);
  });

  it("2. hard window ratio reached -> FORCE", () => {
    const decision = decideWith({ contextTokens: 185_000, cachedTokens: 180_000 });

    expect(decision.action).toBe("FORCE");
    expect(decision.reasons).toContain("HARD_WINDOW_RATIO");
    expect(decision.reasons).not.toContain("RESERVE_TOKENS_REACHED");
  });

  it("3. remaining window below the reserve -> FORCE", () => {
    const decision = decideWith(
      { contextTokens: 195_000, cachedTokens: 0 },
      {},
      { defaults: { hardWindowRatio: 0.99 } },
    );

    expect(decision.action).toBe("FORCE");
    expect(decision.reasons).toContain("RESERVE_TOKENS_REACHED");
    expect(decision.reasons).not.toContain("HARD_WINDOW_RATIO");
  });

  it("4. positive saving that repays inside the horizon -> COMPACT", () => {
    const decision = decideWith(
      {
        contextTokens: 150_000,
        cachedTokens: 140_000,
        idleMs: 600_000,
        profile: profileWithCacheTtl(300_000),
      },
      HISTORY,
    );

    expect(decision.action).toBe("COMPACT");
    expect(decision.reasons).toContain("ECONOMIC_TRIGGER");
    expect(decision.reasons).toContain("BREAK_EVEN_WITHIN_HORIZON");
    expect(decision.reasons).toContain("CACHE_LIKELY_EXPIRED");
    expect(decision.metrics.breakEvenCalls).not.toBeNull();
    expect(decision.metrics.breakEvenCalls ?? 0).toBeLessThanOrEqual(
      decision.metrics.expectedFutureCalls,
    );
    expect(decision.metrics.adjustedNetSaving).toBeGreaterThan(0);
  });

  it("5. a compaction that can never repay itself -> KEEP", () => {
    const decision = decideWith(
      { contextTokens: 150_000, cachedTokens: 150_000 },
      { ...HISTORY, retentionSamples: 3, retentionRatioEma: 1, cacheHitRatioEma: 1 },
      { defaults: { minReclaimTokens: 0, minReclaimRatio: 0 } },
    );

    expect(decision.metrics.estimatedReclaimTokens).toBe(0);
    expect(decision.metrics.estimatedSavingPerFutureCall).toBeLessThanOrEqual(0);
    expect(decision.metrics.breakEvenCalls).toBeNull();
    expect(decision.action).toBe("KEEP");
    expect(decision.reasons).toContain("NO_BREAK_EVEN");
  });
});

describe("decision output shape", () => {
  it("returns full metrics and a machine-readable reason list in every branch", () => {
    const actions = [
      decideWith({ contextTokens: 20_000 }, {}),
      decideWith(
        {
          contextTokens: 150_000,
          cachedTokens: 140_000,
          idleMs: 600_000,
          profile: profileWithCacheTtl(300_000),
        },
        HISTORY,
      ),
      decideWith({ contextTokens: 195_000 }, {}),
    ];

    expect(actions.map((decision) => decision.action)).toEqual(["KEEP", "COMPACT", "FORCE"]);

    for (const decision of actions) {
      expect(Array.isArray(decision.reasons)).toBe(true);
      expect(decision.reasons.length).toBeGreaterThan(0);
      expect(decision.confidence).toBeGreaterThanOrEqual(0);
      expect(decision.confidence).toBeLessThanOrEqual(1);
      expectAllMetricsFinite(decision);
      for (const reason of decision.reasons) {
        expect(typeof reason).toBe("string");
      }
    }
  });

  it("only returns nextCheckAtTokens for KEEP, and always above the current context", () => {
    const keep = decideWith({ contextTokens: 20_000 });
    const compact = decideWith(
      {
        contextTokens: 150_000,
        cachedTokens: 140_000,
        idleMs: 600_000,
        profile: profileWithCacheTtl(300_000),
      },
      HISTORY,
    );
    const force = decideWith({ contextTokens: 195_000 });

    expect(keep.nextCheckAtTokens).toBeGreaterThan(20_000);
    expect(compact.nextCheckAtTokens).toBeUndefined();
    expect(force.nextCheckAtTokens).toBeUndefined();
  });
});

describe("cost model", () => {
  it("prices the current replay from uncached and cached tokens", () => {
    const decision = decideWith(
      { contextTokens: 100_000, cachedTokens: 60_000 },
      { ...HISTORY, reuseHorizonEma: 2, horizonSamples: 1 },
    );

    const inputPerToken = 3 / 1_000_000;
    const cacheReadPerToken = 0.3 / 1_000_000;
    const survival = decision.metrics.estimatedCacheSurvival;
    const expectedReplay =
      40_000 * inputPerToken +
      60_000 * (survival * cacheReadPerToken + (1 - survival) * inputPerToken);

    expect(decision.metrics.estimatedKeepCost).toBeCloseTo(expectedReplay * 2, 12);
  });

  it("charges the first post-compaction replay at the cache-write price", () => {
    const decision = decideWith(
      { contextTokens: 100_000, cachedTokens: 0 },
      { retentionRatioEma: 0.5, retentionSamples: 1 },
    );

    const postCompactTokens = 100_000 * 0.5;
    const writePrice = 3.75 / 1_000_000;
    const inputPrice = 3 / 1_000_000;
    const horizon = 3;
    const coldStartCallCost = 100_000 * inputPrice + 100_000 * 0.12 * (15 / 1_000_000);

    expect(decision.metrics.estimatedPostCompactTokens).toBeCloseTo(postCompactTokens, 6);
    expect(decision.metrics.estimatedCompactCost).toBeCloseTo(
      coldStartCallCost +
        postCompactTokens * writePrice +
        (horizon - 1) * postCompactTokens * inputPrice,
      12,
    );
  });

  it("uses the cold-start compaction cost estimate when nothing was learned", () => {
    const decision = decideWith(
      { contextTokens: 100_000, cachedTokens: 0 },
      { retentionSamples: 0 },
    );

    const expectedOutputTokens = 100_000 * 0.12;
    const expectedCallCost = 100_000 * (3 / 1_000_000) + expectedOutputTokens * (15 / 1_000_000);

    expect(decision.metrics.compactionSamples).toBe(0);
    expect(decision.metrics.estimatedCompactCost).toBeGreaterThanOrEqual(expectedCallCost - 1e-12);
  });

  it("falls back to normalized token cost when no price is configured", () => {
    const profile = makeProfile({ pricing: undefined });
    const decision = decideFoldPoint(
      makeInput({ profile, contextTokens: 100_000, cachedTokens: 50_000 }),
      makeState(HISTORY),
    );

    expectAllMetricsFinite(decision);
    expect(decision.metrics.estimatedKeepCost).toBeGreaterThan(0);
    expect(tokenOnlyPricing().inputPerMillion).toBe(1_000_000);
  });

  it("doubles the uncertainty penalty below the soft window", () => {
    const belowSoft = decideWith({ contextTokens: 150_000, cachedTokens: 0 }, HISTORY, {
      defaults: { softWindowRatio: 0.8 },
    });
    const aboveSoft = decideWith({ contextTokens: 150_000, cachedTokens: 0 }, HISTORY, {
      defaults: { softWindowRatio: 0.5 },
    });

    expect(belowSoft.metrics.utilization).toBeLessThan(0.8);
    expect(aboveSoft.metrics.utilization).toBeGreaterThan(0.5);
    expect(belowSoft.metrics.estimatedNetSaving).toBeCloseTo(
      aboveSoft.metrics.estimatedNetSaving,
      12,
    );
    expect(belowSoft.metrics.adjustedNetSaving).toBeLessThan(aboveSoft.metrics.adjustedNetSaving);
  });

  it("reports a confidence that grows with observed samples", () => {
    const fresh = decideWith({ contextTokens: 100_000 }, {});
    const learned = decideWith({ contextTokens: 100_000 }, HISTORY);

    expect(fresh.confidence).toBeCloseTo(0.35, 10);
    expect(learned.confidence).toBeGreaterThan(fresh.confidence);
    expect(learned.confidence).toBeLessThanOrEqual(1);
  });

  it("honours the host-provided horizon over the learned one", () => {
    const decision = decideWith(
      { contextTokens: 100_000, expectedFutureCalls: 7 },
      { ...HISTORY, reuseHorizonEma: 2, horizonSamples: 5 },
    );

    expect(decision.metrics.expectedFutureCalls).toBe(7);
  });

  it("derives idle time from state when the host does not provide it", () => {
    const decision = decideWith(
      {
        contextTokens: 100_000,
        cachedTokens: 90_000,
        timestamp: BASE_TIMESTAMP + 5_000,
        profile: profileWithCacheTtl(60_000),
      },
      { ...HISTORY, lastRequestAt: BASE_TIMESTAMP },
    );

    expect(decision.metrics.estimatedCacheSurvival).toBeCloseTo(0.9, 10);
  });
});
