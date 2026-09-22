/**
 * Online learning: the same decision input, evaluated as real compaction results arrive.
 *
 * Run with: npm run example:online-learning
 */
import {
  FoldPoint,
  type FoldPointProfile,
  type FoldPointProfileState,
  profileKey,
} from "../src/index";

const profile: FoldPointProfile = {
  provider: "example",
  model: "example-model",
  contextWindowTokens: 200_000,
  compactorId: "summary-v2",
  pricing: { currency: "USD", inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 },
  cachePolicy: { ttlMs: 300_000 },
};

const started = Date.now();

function probe(state: FoldPointProfileState, label: string): void {
  const foldPoint = new FoldPoint({
    state: { version: 1, profiles: { [profileKey(profile)]: state } },
  });
  const decision = foldPoint.decide({
    profile,
    timestamp: started,
    contextTokens: 150_000,
    cachedTokens: 20_000,
    idleMs: 600_000, // the cache is cold
    safeBoundary: true,
    compactionAllowed: true,
    expectedFutureCalls: 8,
  });

  console.log(
    [
      label.padEnd(34),
      `retention=${state.retentionRatioEma.toFixed(3)}`,
      `samples=${state.retentionSamples}`,
      `postCompact=${Math.round(decision.metrics.estimatedPostCompactTokens)}`,
      `reclaim=${Math.round(decision.metrics.estimatedReclaimTokens)}`,
      `breakEven=${decision.metrics.breakEvenCalls?.toFixed(2) ?? "n/a"}`,
      `confidence=${decision.confidence.toFixed(2)}`,
      `-> ${decision.action}`,
    ].join("  "),
  );
}

// A fresh profile only has the cold-start defaults.
const fresh = new FoldPoint();
probe(fresh.getProfileState(profile), "cold start (defaults)");

// Feed it real compaction results and watch the estimate move.
const foldPoint = new FoldPoint();
const compactions: Array<{ before: number; after: number; cost: number }> = [
  { before: 120_000, after: 36_000, cost: 0.42 }, // a strong compactor
  { before: 140_000, after: 35_000, cost: 0.48 },
  { before: 160_000, after: 40_000, cost: 0.55 },
  { before: 150_000, after: 38_000, cost: 0.5 },
];

compactions.forEach((compaction, index) => {
  foldPoint.recordCompaction(profile, {
    timestamp: started + index,
    beforeTokens: compaction.before,
    afterTokens: compaction.after,
    actualCost: compaction.cost,
    success: true,
  });
  probe(foldPoint.getProfileState(profile), `after real compaction #${index + 1}`);
});

// A failed compaction must not move the retention estimate at all.
const beforeFailure = foldPoint.getProfileState(profile);
foldPoint.recordCompaction(profile, {
  timestamp: started + 100,
  beforeTokens: 150_000,
  afterTokens: 10_000,
  success: false,
});
const afterFailure = foldPoint.getProfileState(profile);

console.log(
  `\nfailed compaction: retention ${beforeFailure.retentionRatioEma.toFixed(4)} -> ${afterFailure.retentionRatioEma.toFixed(4)}, samples ${beforeFailure.retentionSamples} -> ${afterFailure.retentionSamples}`,
);
console.log(
  `counters still move: compactionCount=${afterFailure.compactionCount}, successfulCompactionCount=${afterFailure.successfulCompactionCount}`,
);
