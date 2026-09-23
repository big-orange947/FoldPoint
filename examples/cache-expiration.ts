/**
 * Cache coverage and cache aliveness are two different things.
 *
 * The same context, the same prices and the same compactor history produce different
 * answers depending on how much of the prompt the cache *could* cover and whether that
 * prefix is still alive.
 *
 * Run with: npm run example:cache-expiration
 */
import { FoldPoint, type FoldPointProfile, profileKey } from "../src/index";

const started = Date.now();
const sessionId = "cache-demo-session";

function profileWithTtl(ttlMs: number): FoldPointProfile {
  return {
    provider: "example",
    model: "example-model",
    contextWindowTokens: 200_000,
    compactorId: "summary-v2",
    pricing: {
      currency: "USD",
      inputPerMillion: 3,
      outputPerMillion: 15,
      cacheReadPerMillion: 0.3,
      cacheWritePerMillion: 3.75,
    },
    cachePolicy: { ttlMs },
  };
}

function seededHistory(profile: FoldPointProfile): FoldPoint {
  return new FoldPoint({
    state: {
      version: 2,
      profiles: {
        [profileKey(profile)]: {
          version: 2,
          successfulCompactionCount: 2,
          retentionRatioEma: 0.3,
          retentionSamples: 2,
          compactPromptRatioEma: 1,
          compactPromptSamples: 2,
          compactOutputRatioEma: 0.08,
          compactOutputSamples: 2,
          compactCachedInputRatioEma: 0,
          compactCachedInputSamples: 0,
          compactCacheWriteRatioEma: 0,
          compactCacheWriteSamples: 0,
          compactCostScaleEma: 1,
          compactCostScaleSamples: 0,
          cacheCoverageRatioEma: 0.95,
          cacheCoverageSamples: 40,
          reuseHorizonEma: 12,
          horizonSamples: 2,
        },
      },
      sessions: {},
    },
  });
}

function evaluate(label: string, ttlMs: number, idleMs: number, cachedTokens: number): void {
  const profile = profileWithTtl(ttlMs);
  const foldPoint = seededHistory(profile);

  const decision = foldPoint.decide({
    sessionId,
    profile,
    timestamp: started,
    contextTokens: 130_000,
    cachedTokens,
    idleMs,
    safeBoundary: true,
    compactionAllowed: true,
    expectedFutureCalls: 12,
  });

  console.log(
    [
      label.padEnd(34),
      `coverage=${decision.metrics.estimatedCacheCoverageRatio.toFixed(2)}`,
      `alive=${decision.metrics.estimatedCacheAliveProbability.toFixed(2)}`,
      `effective=${String(Math.round(decision.metrics.estimatedEffectiveCachedTokens)).padStart(7)}`,
      `keep=$${decision.metrics.estimatedKeepCost.toFixed(3)}`,
      `compact=$${decision.metrics.estimatedCompactCost.toFixed(3)}`,
      `breakEven=${decision.metrics.breakEvenCalls?.toFixed(2) ?? "n/a"}`,
      `-> ${decision.action}`,
      `[${decision.reasons.join(", ")}]`,
    ].join("  "),
  );
}

console.log("Same 130k context, 12 calls left, cache reads 10x cheaper than input:\n");
evaluate("warm cache, full coverage", 300_000, 5_000, 125_000);
evaluate("warm cache, partial coverage", 300_000, 5_000, 60_000);
evaluate("cache already expired", 60_000, 600_000, 125_000);
evaluate("no TTL known, short idle", Number.POSITIVE_INFINITY, 5_000, 125_000);

console.log(
  "\nCoverage and aliveness meet exactly once, in effectiveCachedTokens: coverage is never",
);
console.log("multiplied into the replay cost a second time.");
