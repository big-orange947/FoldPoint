/**
 * Online learning: the same decision input, evaluated as real compaction results arrive.
 *
 * Shows the split between profile learning state (shared across sessions, scale-free ratios)
 * and session runtime state (per session, discarded by endSession).
 *
 * Run with: npm run example:online-learning
 */
import {
  FoldPoint,
  type FoldPointProfile,
  type FoldPointProfileLearningState,
  profileKey,
  sessionKey,
} from "../src/index";

const profile: FoldPointProfile = {
  provider: "example",
  model: "example-model",
  contextWindowTokens: 200_000,
  compactorId: "summary-v2",
  pricing: { currency: "USD", inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 },
  cachePolicy: { ttlMs: 300_000 },
};

const sessionId = "learning-demo-session";
const started = Date.now();

function probe(learning: FoldPointProfileLearningState, label: string): void {
  const foldPoint = new FoldPoint({
    state: {
      version: 2,
      profiles: { [profileKey(profile)]: learning },
      sessions: {},
    },
  });

  const decision = foldPoint.decide({
    sessionId,
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
      `retention=${learning.retentionRatioEma.toFixed(3)}`,
      `samples=${learning.retentionSamples}`,
      `postCompact=${Math.round(decision.metrics.estimatedPostCompactTokens)}`,
      `reclaim=${Math.round(decision.metrics.estimatedReclaimTokens)}`,
      `compactCall=$${decision.metrics.estimatedCompactCallCost.toFixed(4)}`,
      `breakEven=${decision.metrics.breakEvenCalls?.toFixed(2) ?? "n/a"}`,
      `confidence=${decision.confidence.toFixed(2)}`,
      `-> ${decision.action}`,
    ].join("  "),
  );
}

const fresh = new FoldPoint();
probe(fresh.getProfileState(profile), "cold start (defaults)");

const foldPoint = new FoldPoint();
const compactions: Array<{ before: number; after: number }> = [
  { before: 10_000, after: 3_000 }, // learned on a small context...
  { before: 140_000, after: 35_000 },
  { before: 160_000, after: 40_000 },
  { before: 150_000, after: 38_000 },
];

compactions.forEach((compaction, index) => {
  foldPoint.recordCompaction(sessionId, profile, {
    timestamp: started + index,
    beforeTokens: compaction.before,
    afterTokens: compaction.after,
    promptTokens: compaction.before,
    outputTokens: Math.round(compaction.before * 0.08),
    success: true,
  });
  probe(foldPoint.getProfileState(profile), `after real compaction #${index + 1}`);
});

// The usage ratios scale to whatever context is being compacted, so a ratio learned on a
// 10k context prices a 150k context correctly. There is no stored currency amount.
const learning = foldPoint.getProfileState(profile);
console.log(
  `\nusage ratios: prompt=${learning.compactPromptRatioEma.toFixed(3)} output=${learning.compactOutputRatioEma.toFixed(3)}`,
);
console.log(
  `cost scale: ${learning.compactCostScaleEma.toFixed(3)} (samples ${learning.compactCostScaleSamples}, dimensionless)`,
);

// A failed attempt teaches nothing, but it does restart the cooldown.
const before = foldPoint.getSessionState(sessionId, profile);
foldPoint.recordCompaction(sessionId, profile, {
  timestamp: started + 100,
  beforeTokens: 150_000,
  afterTokens: 10_000,
  success: false,
});
const after = foldPoint.getSessionState(sessionId, profile);

console.log(
  `\nfailed attempt: retention samples ${before.compactionAttemptCount} -> ${after.compactionAttemptCount} attempts, ${after.failedCompactionCount} failed, callsSinceLastAttempt=${after.callsSinceLastAttempt}`,
);
console.log(
  `retention learning untouched: samples=${foldPoint.getProfileState(profile).retentionSamples}`,
);
console.log(`session key: ${sessionKey(sessionId, profile)}`);
