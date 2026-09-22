import { describe, expect, it } from "vitest";
import { FoldPoint, type FoldPointProfile } from "../src/index";
import { BASE_TIMESTAMP, makeProfile } from "./helpers";

function observeCalls(foldPoint: FoldPoint, profile: FoldPointProfile, count: number): void {
  for (let index = 0; index < count; index += 1) {
    foldPoint.observeRequest(profile, {
      timestamp: BASE_TIMESTAMP + index * 1_000,
      promptTokens: 90_000,
      cachedInputTokens: 70_000,
      outputTokens: 500,
    });
  }
}

describe("17.3 online learning", () => {
  it("11. uses the default retention ratio with no compaction history", () => {
    const foldPoint = new FoldPoint();
    const profile = makeProfile();
    const decision = foldPoint.decide({
      profile,
      timestamp: BASE_TIMESTAMP,
      contextTokens: 150_000,
      safeBoundary: true,
      compactionAllowed: true,
    });

    expect(decision.metrics.compactionSamples).toBe(0);
    expect(decision.metrics.estimatedPostCompactTokens).toBeCloseTo(150_000 * 0.4, 6);
    expect(decision.metrics.estimatedReclaimTokens).toBeCloseTo(150_000 * 0.6, 6);
  });

  it("12. a strong real compaction increases the expected reclaim", () => {
    const foldPoint = new FoldPoint();
    const profile = makeProfile();
    foldPoint.recordCompaction(profile, {
      timestamp: BASE_TIMESTAMP,
      beforeTokens: 100_000,
      afterTokens: 20_000,
      success: true,
    });

    const state = foldPoint.getProfileState(profile);
    expect(state.retentionRatioEma).toBeCloseTo(0.35, 12);
    expect(state.retentionSamples).toBe(1);

    const decision = foldPoint.decide({
      profile,
      timestamp: BASE_TIMESTAMP + 1,
      contextTokens: 150_000,
      safeBoundary: true,
      compactionAllowed: true,
    });

    expect(decision.metrics.estimatedPostCompactTokens).toBeLessThan(150_000 * 0.4);
    expect(decision.metrics.estimatedReclaimTokens).toBeGreaterThan(150_000 * 0.6);
  });

  it("13. a weak real compaction decreases the expected reclaim", () => {
    const foldPoint = new FoldPoint();
    const profile = makeProfile();
    foldPoint.recordCompaction(profile, {
      timestamp: BASE_TIMESTAMP,
      beforeTokens: 100_000,
      afterTokens: 95_000,
      success: true,
    });

    expect(foldPoint.getProfileState(profile).retentionRatioEma).toBeCloseTo(0.5375, 12);

    const decision = foldPoint.decide({
      profile,
      timestamp: BASE_TIMESTAMP + 1,
      contextTokens: 150_000,
      safeBoundary: true,
      compactionAllowed: true,
    });

    expect(decision.metrics.estimatedPostCompactTokens).toBeGreaterThan(150_000 * 0.4);
    expect(decision.metrics.estimatedReclaimTokens).toBeLessThan(150_000 * 0.6);
  });

  it("14. multiple events update through EMA, not only the last one", () => {
    const foldPoint = new FoldPoint();
    const profile = makeProfile();

    foldPoint.recordCompaction(profile, {
      timestamp: BASE_TIMESTAMP,
      beforeTokens: 100_000,
      afterTokens: 20_000,
      success: true,
    });
    foldPoint.recordCompaction(profile, {
      timestamp: BASE_TIMESTAMP + 1,
      beforeTokens: 100_000,
      afterTokens: 90_000,
      success: true,
    });

    const state = foldPoint.getProfileState(profile);
    expect(state.retentionRatioEma).toBeCloseTo(0.4875, 12);
    expect(state.retentionRatioEma).not.toBeCloseTo(0.9, 6);
    expect(state.retentionRatioEma).not.toBeCloseTo(0.35, 6);
    expect(state.retentionSamples).toBe(2);
  });

  it("15. a failed compaction never updates the retention ratio", () => {
    const foldPoint = new FoldPoint();
    const profile = makeProfile();
    observeCalls(foldPoint, profile, 2);

    foldPoint.recordCompaction(profile, {
      timestamp: BASE_TIMESTAMP + 10,
      beforeTokens: 100_000,
      afterTokens: 20_000,
      success: false,
    });

    const afterFailure = foldPoint.getProfileState(profile);
    expect(afterFailure.retentionRatioEma).toBeCloseTo(0.4, 12);
    expect(afterFailure.retentionSamples).toBe(0);
    expect(afterFailure.compactionCount).toBe(1);
    expect(afterFailure.successfulCompactionCount).toBe(0);
    expect(afterFailure.callsSinceLastCompaction).toBe(2);
    expect(afterFailure.lastCompactionAt).toBeUndefined();

    foldPoint.recordCompaction(profile, {
      timestamp: BASE_TIMESTAMP + 11,
      beforeTokens: 100_000,
      afterTokens: 20_000,
      success: true,
    });

    const afterSuccess = foldPoint.getProfileState(profile);
    expect(afterSuccess.retentionSamples).toBe(1);
    expect(afterSuccess.successfulCompactionCount).toBe(1);
    expect(afterSuccess.callsSinceLastCompaction).toBe(0);
  });

  it("16. a compaction that reclaims nothing makes later decisions more conservative", () => {
    const foldPoint = new FoldPoint();
    const profile = makeProfile();

    for (let index = 0; index < 6; index += 1) {
      foldPoint.recordCompaction(profile, {
        timestamp: BASE_TIMESTAMP + index,
        beforeTokens: 100_000,
        afterTokens: 120_000,
        success: true,
      });
    }

    const state = foldPoint.getProfileState(profile);
    expect(state.retentionRatioEma).toBeCloseTo(0.893212890625, 12);

    observeCalls(foldPoint, profile, 3);
    const learned = foldPoint.decide({
      profile,
      timestamp: BASE_TIMESTAMP + 100,
      contextTokens: 150_000,
      safeBoundary: true,
      compactionAllowed: true,
    });

    const fresh = new FoldPoint();
    const freshDecision = fresh.decide({
      profile,
      timestamp: BASE_TIMESTAMP + 100,
      contextTokens: 150_000,
      safeBoundary: true,
      compactionAllowed: true,
    });

    expect(learned.metrics.estimatedReclaimTokens).toBeLessThan(
      freshDecision.metrics.estimatedReclaimTokens,
    );
    expect(learned.action).toBe("KEEP");
    expect(learned.reasons).toContain("INSUFFICIENT_RECLAIM_RATIO");
  });

  it("learns the compaction cost from reported usage and prices", () => {
    const foldPoint = new FoldPoint();
    const profile = makeProfile();

    foldPoint.recordCompaction(profile, {
      timestamp: BASE_TIMESTAMP,
      beforeTokens: 100_000,
      afterTokens: 20_000,
      promptTokens: 100_000,
      outputTokens: 5_000,
      success: true,
    });

    const state = foldPoint.getProfileState(profile);
    expect(state.compactionCostEma).toBeCloseTo(100_000 * 3e-6 + 5_000 * 15e-6, 12);
    expect(state.compactionCostSamples).toBe(1);
  });

  it("learns the compaction cost from an actual reported cost and then follows the EMA", () => {
    const foldPoint = new FoldPoint();
    const profile = makeProfile();

    foldPoint.recordCompaction(profile, {
      timestamp: BASE_TIMESTAMP,
      beforeTokens: 100_000,
      afterTokens: 20_000,
      actualCost: 0.5,
      success: true,
    });
    foldPoint.recordCompaction(profile, {
      timestamp: BASE_TIMESTAMP + 1,
      beforeTokens: 100_000,
      afterTokens: 20_000,
      actualCost: 0.9,
      success: true,
    });

    const state = foldPoint.getProfileState(profile);
    expect(state.compactionCostEma).toBeCloseTo(0.6, 12);
    expect(state.compactionCostSamples).toBe(2);
  });

  it("learns the reuse horizon at session end, and only after a compaction", () => {
    const foldPoint = new FoldPoint();
    const profile = makeProfile();

    foldPoint.endSession(profile, { timestamp: BASE_TIMESTAMP });
    expect(foldPoint.getProfileState(profile).horizonSamples).toBe(0);

    foldPoint.recordCompaction(profile, {
      timestamp: BASE_TIMESTAMP,
      beforeTokens: 100_000,
      afterTokens: 20_000,
      success: true,
    });
    observeCalls(foldPoint, profile, 4);
    foldPoint.endSession(profile, { timestamp: BASE_TIMESTAMP + 5_000 });

    const state = foldPoint.getProfileState(profile);
    expect(state.horizonSamples).toBe(1);
    expect(state.reuseHorizonEma).toBeCloseTo(0.25 * 4 + 0.75 * 3, 12);
  });

  it("learns the cache hit ratio from request observations", () => {
    const foldPoint = new FoldPoint();
    const profile = makeProfile();

    foldPoint.observeRequest(profile, {
      timestamp: BASE_TIMESTAMP,
      promptTokens: 100_000,
      cachedInputTokens: 60_000,
    });
    foldPoint.observeRequest(profile, {
      timestamp: BASE_TIMESTAMP + 1_000,
      promptTokens: 100_000,
      cachedInputTokens: 100_000,
    });

    const state = foldPoint.getProfileState(profile);
    expect(state.cacheSamples).toBe(2);
    // Starts from zero: 0.25 * 0.6 + 0.75 * 0 = 0.15, then 0.25 * 1 + 0.75 * 0.15 = 0.3625.
    expect(state.cacheHitRatioEma).toBeCloseTo(0.3625, 12);
  });

  it("ignores a request observation with no prompt tokens", () => {
    const foldPoint = new FoldPoint();
    const profile = makeProfile();

    foldPoint.observeRequest(profile, {
      timestamp: BASE_TIMESTAMP,
      promptTokens: 0,
      cachedInputTokens: 0,
    });

    const state = foldPoint.getProfileState(profile);
    expect(state.requestCount).toBe(1);
    expect(state.cacheSamples).toBe(0);
  });

  it("rejects observations that violate the invariants", () => {
    const foldPoint = new FoldPoint();
    const profile = makeProfile();

    expect(() =>
      foldPoint.observeRequest(profile, {
        timestamp: BASE_TIMESTAMP,
        promptTokens: 1_000,
        cachedInputTokens: 2_000,
      }),
    ).toThrow(RangeError);

    expect(() =>
      foldPoint.observeRequest(profile, { timestamp: BASE_TIMESTAMP, promptTokens: -1 }),
    ).toThrow(RangeError);

    expect(() =>
      foldPoint.recordCompaction(profile, {
        timestamp: BASE_TIMESTAMP,
        beforeTokens: 0,
        afterTokens: 0,
        success: true,
      }),
    ).toThrow(RangeError);

    expect(() =>
      foldPoint.recordCompaction(profile, {
        timestamp: Number.NaN,
        beforeTokens: 1_000,
        afterTokens: 100,
        success: true,
      }),
    ).toThrow(RangeError);
  });
});
