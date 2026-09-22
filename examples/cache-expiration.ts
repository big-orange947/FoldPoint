/**
 * Why the cache changes the right moment to compact.
 *
 * The same context, the same prices and the same compactor history produce different
 * answers depending on whether the provider cache is still alive.
 *
 * Run with: npm run example:cache-expiration
 */
import { FoldPoint, type FoldPointProfile, profileKey } from "../src/index";

const started = Date.now();

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

function history(profile: FoldPointProfile): FoldPoint {
  const foldPoint = new FoldPoint({
    state: {
      version: 1,
      profiles: {
        [profileKey(profile)]: {
          version: 1,
          requestCount: 40,
          compactionCount: 2,
          successfulCompactionCount: 2,
          callsSinceLastCompaction: 12,
          retentionRatioEma: 0.3,
          compactOutputRatioEma: 0.08,
          compactionCostEma: 0.45,
          cacheHitRatioEma: 0.95,
          reuseHorizonEma: 12,
          growthPerCallEma: 6_000,
          retentionSamples: 2,
          compactionCostSamples: 2,
          cacheSamples: 40,
          horizonSamples: 2,
          growthSamples: 40,
        },
      },
    },
  });
  return foldPoint;
}

function evaluate(label: string, ttlMs: number, idleMs: number): void {
  const profile = profileWithTtl(ttlMs);
  const foldPoint = history(profile);

  const decision = foldPoint.decide({
    profile,
    timestamp: started,
    contextTokens: 130_000,
    cachedTokens: 125_000,
    idleMs,
    safeBoundary: true,
    compactionAllowed: true,
    expectedFutureCalls: 12,
  });

  console.log(
    [
      label.padEnd(38),
      `idle=${String(idleMs).padStart(7)}ms`,
      `survival=${decision.metrics.estimatedCacheSurvival.toFixed(3)}`,
      `keepCost=${decision.metrics.estimatedKeepCost.toFixed(4)}`,
      `compactCost=${decision.metrics.estimatedCompactCost.toFixed(4)}`,
      `netSaving=${decision.metrics.estimatedNetSaving.toFixed(4)}`,
      `breakEven=${decision.metrics.breakEvenCalls?.toFixed(2) ?? "n/a"}`,
      `-> ${decision.action}`,
      `[${decision.reasons.join(", ")}]`,
    ].join("  "),
  );
}

console.log("Same 130k context, 125k of it cached, 12 calls left:\n");
evaluate("warm cache, cache reads are cheap", 300_000, 5_000);
evaluate("cache about to expire", 60_000, 55_000);
evaluate("cache already expired", 60_000, 600_000);
evaluate("no TTL known, short idle", Number.POSITIVE_INFINITY, 5_000);

console.log(
  "\nThe compaction call itself reads the whole context, so it costs the same in every row:",
);
console.log("only the cost of *keeping* changes, and that is what moves the decision.");
