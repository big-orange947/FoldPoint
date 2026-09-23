import { describe, expect, it } from "vitest";
import { FoldPoint, type FoldPointProfile, profileKey, tokenOnlyPricing } from "../src/index";
import { BASE_TIMESTAMP, HISTORY, makeProfile } from "./helpers";

const SESSION = "session-learning";

function seededFoldPoint(
  profile: FoldPointProfile,
  learning: Record<string, unknown> = {},
): FoldPoint {
  return new FoldPoint({
    state: {
      version: 2,
      profiles: {
        [profileKey(profile)]: {
          version: 2,
          successfulCompactionCount: 0,
          retentionRatioEma: 0.4,
          retentionSamples: 0,
          compactPromptRatioEma: 1,
          compactPromptSamples: 0,
          compactOutputRatioEma: 0.12,
          compactOutputSamples: 0,
          compactCachedInputRatioEma: 0,
          compactCachedInputSamples: 0,
          compactCacheWriteRatioEma: 0,
          compactCacheWriteSamples: 0,
          compactCostScaleEma: 1,
          compactCostScaleSamples: 0,
          cacheCoverageRatioEma: 0,
          cacheCoverageSamples: 0,
          reuseHorizonEma: 3,
          horizonSamples: 0,
          ...learning,
        },
      },
      sessions: {},
    },
  });
}

function observeCalls(
  foldPoint: FoldPoint,
  profile: FoldPointProfile,
  count: number,
  sessionId = SESSION,
): void {
  for (let index = 0; index < count; index += 1) {
    foldPoint.observeRequest(sessionId, profile, {
      timestamp: BASE_TIMESTAMP + index * 1_000,
      promptTokens: 90_000,
      cachedInputTokens: 70_000,
      outputTokens: 500,
    });
  }
}

describe("17.3 online learning", () => {
  it("learns the retention ratio only from successful compactions", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();

    foldPoint.recordCompaction(SESSION, profile, {
      timestamp: BASE_TIMESTAMP,
      beforeTokens: 100_000,
      afterTokens: 20_000,
      promptTokens: 100_000,
      outputTokens: 5_000,
      success: true,
    });

    const learning = foldPoint.getProfileState(profile);
    expect(learning.retentionRatioEma).toBeCloseTo(0.35, 12);
    expect(learning.retentionSamples).toBe(1);
    expect(learning.compactPromptRatioEma).toBeCloseTo(1, 12);
    expect(learning.compactOutputRatioEma).toBeCloseTo(0.1025, 12);
    expect(learning.compactPromptSamples).toBe(1);
    expect(learning.compactOutputSamples).toBe(1);
    expect(learning.successfulCompactionCount).toBe(1);
  });

  it("updates through EMA across several events", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();

    foldPoint.recordCompaction(SESSION, profile, {
      timestamp: BASE_TIMESTAMP,
      beforeTokens: 100_000,
      afterTokens: 20_000,
      success: true,
    });
    foldPoint.recordCompaction(SESSION, profile, {
      timestamp: BASE_TIMESTAMP + 1,
      beforeTokens: 100_000,
      afterTokens: 90_000,
      success: true,
    });

    const learning = foldPoint.getProfileState(profile);
    expect(learning.retentionRatioEma).toBeCloseTo(0.4875, 12);
    expect(learning.retentionSamples).toBe(2);
  });

  it("clamps a compaction that reclaims nothing and becomes more conservative", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();

    foldPoint.recordCompaction(SESSION, profile, {
      timestamp: BASE_TIMESTAMP,
      beforeTokens: 100_000,
      afterTokens: 120_000,
      success: true,
    });

    expect(foldPoint.getProfileState(profile).retentionRatioEma).toBeCloseTo(0.55, 12);

    observeCalls(foldPoint, profile, 3);
    const decision = foldPoint.decide({
      sessionId: SESSION,
      profile,
      timestamp: BASE_TIMESTAMP + 10_000,
      contextTokens: 150_000,
      cachedTokens: 0,
    });

    expect(decision.metrics.estimatedReclaimRatio).toBeCloseTo(0.45, 12);
  });

  it("learns the cache coverage ratio from request observations", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();

    foldPoint.observeRequest(SESSION, profile, {
      timestamp: BASE_TIMESTAMP,
      promptTokens: 100_000,
      cachedInputTokens: 60_000,
    });
    foldPoint.observeRequest(SESSION, profile, {
      timestamp: BASE_TIMESTAMP + 1_000,
      promptTokens: 100_000,
      cachedInputTokens: 100_000,
    });

    const learning = foldPoint.getProfileState(profile);
    expect(learning.cacheCoverageSamples).toBe(2);
    expect(learning.cacheCoverageRatioEma).toBeCloseTo(0.3625, 12);
  });

  it("ignores a request observation with no prompt tokens", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();

    foldPoint.observeRequest(SESSION, profile, {
      timestamp: BASE_TIMESTAMP,
      promptTokens: 0,
      cachedInputTokens: 0,
    });

    expect(foldPoint.getProfileState(profile).cacheCoverageSamples).toBe(0);
    expect(foldPoint.getSessionState(SESSION, profile).requestCount).toBe(1);
  });

  it("learns the reuse horizon at session end, and only after a successful compaction", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();

    foldPoint.endSession(SESSION, profile, { timestamp: BASE_TIMESTAMP });
    expect(foldPoint.getProfileState(profile).horizonSamples).toBe(0);

    foldPoint.recordCompaction(SESSION, profile, {
      timestamp: BASE_TIMESTAMP,
      beforeTokens: 100_000,
      afterTokens: 20_000,
      success: true,
    });
    observeCalls(foldPoint, profile, 4);
    foldPoint.endSession(SESSION, profile, { timestamp: BASE_TIMESTAMP + 5_000 });

    const learning = foldPoint.getProfileState(profile);
    expect(learning.horizonSamples).toBe(1);
    expect(learning.reuseHorizonEma).toBeCloseTo(0.25 * 4 + 0.75 * 3, 12);
  });
});

describe("17.5 compaction usage ratios scale with the context", () => {
  it("applies a ratio learned at 10k to a 100k context", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();

    foldPoint.recordCompaction(SESSION, profile, {
      timestamp: BASE_TIMESTAMP,
      beforeTokens: 10_000,
      afterTokens: 3_000,
      promptTokens: 10_000,
      outputTokens: 1_000,
      success: true,
    });

    const learning = foldPoint.getProfileState(profile);
    // The first observation is blended with the cold-start prior: 0.25 * 0.1 + 0.75 * 0.12.
    const blendedOutputRatio = 0.25 * 0.1 + 0.75 * 0.12;
    expect(learning.compactPromptRatioEma).toBeCloseTo(1, 12);
    expect(learning.compactOutputRatioEma).toBeCloseTo(blendedOutputRatio, 12);

    observeCalls(foldPoint, profile, 3);
    const small = foldPoint.decide({
      sessionId: SESSION,
      profile,
      timestamp: BASE_TIMESTAMP + 10_000,
      contextTokens: 10_000,
      cachedTokens: 0,
    });
    const large = foldPoint.decide({
      sessionId: SESSION,
      profile,
      timestamp: BASE_TIMESTAMP + 10_000,
      contextTokens: 100_000,
      cachedTokens: 0,
    });

    expect(small.metrics.estimatedCompactCallCost).toBeCloseTo(
      10_000 * (3 / 1_000_000) + 10_000 * blendedOutputRatio * (15 / 1_000_000),
      12,
    );
    expect(large.metrics.estimatedCompactCallCost).toBeCloseTo(
      small.metrics.estimatedCompactCallCost * 10,
      12,
    );
  });
});

describe("17.6 pricing changes", () => {
  it("keeps the learned ratios and reprices with the new snapshot", () => {
    const cheap = makeProfile({ pricing: { inputPerMillion: 1, outputPerMillion: 5 } });
    const pricey = makeProfile({ pricing: { inputPerMillion: 10, outputPerMillion: 50 } });

    const foldPoint = new FoldPoint();
    foldPoint.recordCompaction(SESSION, cheap, {
      timestamp: BASE_TIMESTAMP,
      beforeTokens: 10_000,
      afterTokens: 3_000,
      promptTokens: 10_000,
      outputTokens: 1_000,
      success: true,
    });

    observeCalls(foldPoint, cheap, 3);
    const before = foldPoint.decide({
      sessionId: SESSION,
      profile: cheap,
      timestamp: BASE_TIMESTAMP + 10_000,
      contextTokens: 100_000,
      cachedTokens: 0,
    });
    const after = foldPoint.decide({
      sessionId: SESSION,
      profile: pricey,
      timestamp: BASE_TIMESTAMP + 10_000,
      contextTokens: 100_000,
      cachedTokens: 0,
    });

    const blendedOutputRatio = 0.25 * 0.1 + 0.75 * 0.12;
    expect(before.metrics.estimatedCompactCallCost).toBeCloseTo(
      100_000 * (1 / 1_000_000) + 100_000 * blendedOutputRatio * (5 / 1_000_000),
      12,
    );
    expect(after.metrics.estimatedCompactCallCost).toBeCloseTo(
      before.metrics.estimatedCompactCallCost * 10,
      12,
    );
    expect(foldPoint.getProfileState(cheap).retentionSamples).toBe(1);
    expect(foldPoint.getProfileState(cheap).compactOutputRatioEma).toBeCloseTo(
      blendedOutputRatio,
      12,
    );
  });
});

describe("17.7 the actual-cost scale never mixes tokens and currency", () => {
  it("learns the scale only with a real currency, usage and an actual cost", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();

    foldPoint.recordCompaction(SESSION, profile, {
      timestamp: BASE_TIMESTAMP,
      beforeTokens: 100_000,
      afterTokens: 30_000,
      promptTokens: 100_000,
      actualCost: 0.6,
      success: true,
    });

    const learning = foldPoint.getProfileState(profile);
    // modeled cost = 100k * 3/M = 0.3, actual 0.6 -> scale 2, blended with the 1.0 prior.
    expect(learning.compactCostScaleEma).toBeCloseTo(0.25 * 2 + 0.75 * 1, 12);
    expect(learning.compactCostScaleSamples).toBe(1);
  });

  it("never learns a scale in normalized token-cost mode", () => {
    const profile = makeProfile({ pricing: tokenOnlyPricing() });
    const foldPoint = new FoldPoint();

    foldPoint.recordCompaction(SESSION, profile, {
      timestamp: BASE_TIMESTAMP,
      beforeTokens: 100_000,
      afterTokens: 30_000,
      promptTokens: 100_000,
      actualCost: 11_000,
      success: true,
    });

    const learning = foldPoint.getProfileState(profile);
    expect(learning.compactCostScaleSamples).toBe(0);
    expect(learning.compactCostScaleEma).toBe(1);
  });

  it("does not learn a scale without usage to compare against", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();

    foldPoint.recordCompaction(SESSION, profile, {
      timestamp: BASE_TIMESTAMP,
      beforeTokens: 100_000,
      afterTokens: 30_000,
      actualCost: 0.6,
      success: true,
    });

    expect(foldPoint.getProfileState(profile).compactCostScaleSamples).toBe(0);
  });

  it("stores no absolute currency amount anywhere in the learning state", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();
    foldPoint.recordCompaction(SESSION, profile, {
      timestamp: BASE_TIMESTAMP,
      beforeTokens: 100_000,
      afterTokens: 30_000,
      promptTokens: 100_000,
      outputTokens: 5_000,
      actualCost: 0.9,
      success: true,
    });

    const keys = Object.keys(foldPoint.getProfileState(profile));
    expect(keys).not.toContain("compactionCostEma");
    expect(keys).not.toContain("compactionCostSamples");
    for (const key of keys) {
      expect(key.toLowerCase()).not.toContain("costema");
    }
  });
});

describe("17.11 failed attempts restart the cooldown", () => {
  it("a failed economic attempt blocks the next economic decision", () => {
    const profile = makeProfile({ cachePolicy: { ttlMs: 1_000 } });

    // Control: the same session state without the failed attempt compacts.
    const control = seededFoldPoint(profile, HISTORY);
    observeCalls(control, profile, 10);
    const wouldCompact = control.decide({
      sessionId: SESSION,
      profile,
      timestamp: BASE_TIMESTAMP + 20_000,
      contextTokens: 150_000,
      cachedTokens: 140_000,
      idleMs: 600_000,
    });
    expect(wouldCompact.action).toBe("COMPACT");

    // With a failed attempt, the same decision must be blocked by the cooldown.
    const foldPoint = seededFoldPoint(profile, HISTORY);
    observeCalls(foldPoint, profile, 10);
    foldPoint.recordCompaction(SESSION, profile, {
      timestamp: BASE_TIMESTAMP + 11_000,
      beforeTokens: 150_000,
      afterTokens: 40_000,
      success: false,
    });

    const session = foldPoint.getSessionState(SESSION, profile);
    expect(session.callsSinceLastAttempt).toBe(0);
    expect(session.compactionAttemptCount).toBe(1);
    expect(session.failedCompactionCount).toBe(1);
    expect(session.successfulCompactionCount).toBe(0);

    const blocked = foldPoint.decide({
      sessionId: SESSION,
      profile,
      timestamp: BASE_TIMESTAMP + 20_000,
      contextTokens: 150_000,
      cachedTokens: 140_000,
      idleMs: 600_000,
    });

    expect(blocked.action).toBe("KEEP");
    expect(blocked.reasons).toContain("COOLDOWN_ACTIVE");
    expect(blocked.metrics.callsSinceLastAttempt).toBe(0);
  });

  it("17.12 window danger still forces during the cooldown", () => {
    const profile = makeProfile();
    const foldPoint = seededFoldPoint(profile, HISTORY);
    observeCalls(foldPoint, profile, 10);
    foldPoint.recordCompaction(SESSION, profile, {
      timestamp: BASE_TIMESTAMP + 11_000,
      beforeTokens: 150_000,
      afterTokens: 40_000,
      success: false,
    });

    const forced = foldPoint.decide({
      sessionId: SESSION,
      profile,
      timestamp: BASE_TIMESTAMP + 20_000,
      contextTokens: 190_000,
      cachedTokens: 0,
    });

    expect(forced.action).toBe("FORCE");
    expect(forced.reasons).toContain("HARD_WINDOW_RATIO");
  });

  it("a failed attempt teaches nothing about the compactor", () => {
    const profile = makeProfile();
    const foldPoint = seededFoldPoint(profile);

    foldPoint.recordCompaction(SESSION, profile, {
      timestamp: BASE_TIMESTAMP,
      beforeTokens: 100_000,
      afterTokens: 20_000,
      promptTokens: 100_000,
      outputTokens: 5_000,
      actualCost: 0.5,
      success: false,
    });

    const learning = foldPoint.getProfileState(profile);
    expect(learning.retentionSamples).toBe(0);
    expect(learning.retentionRatioEma).toBeCloseTo(0.4, 12);
    expect(learning.compactPromptSamples).toBe(0);
    expect(learning.compactOutputSamples).toBe(0);
    expect(learning.compactCostScaleSamples).toBe(0);
    expect(learning.successfulCompactionCount).toBe(0);
  });
});

describe("observation validation", () => {
  it("rejects observations that violate the invariants", () => {
    const profile = makeProfile();
    const foldPoint = new FoldPoint();

    expect(() =>
      foldPoint.observeRequest(SESSION, profile, {
        timestamp: BASE_TIMESTAMP,
        promptTokens: 1_000,
        cachedInputTokens: 2_000,
      }),
    ).toThrow(RangeError);

    expect(() =>
      foldPoint.observeRequest(SESSION, profile, {
        timestamp: BASE_TIMESTAMP,
        promptTokens: 1_000,
        cacheWriteTokens: 2_000,
      }),
    ).toThrow(RangeError);

    expect(() =>
      foldPoint.observeRequest(SESSION, profile, { timestamp: BASE_TIMESTAMP, promptTokens: -1 }),
    ).toThrow(RangeError);

    expect(() =>
      foldPoint.recordCompaction(SESSION, profile, {
        timestamp: BASE_TIMESTAMP,
        beforeTokens: 0,
        afterTokens: 0,
        success: true,
      }),
    ).toThrow(RangeError);

    expect(() =>
      foldPoint.recordCompaction(SESSION, profile, {
        timestamp: Number.NaN,
        beforeTokens: 1_000,
        afterTokens: 100,
        success: true,
      }),
    ).toThrow(RangeError);
  });
});
