/**
 * Minimal host integration.
 *
 * Run with: npm run example:basic
 */
import { FoldPoint, type FoldPointProfile } from "../src/index";

const foldPoint = new FoldPoint();

const profile: FoldPointProfile = {
  provider: "example",
  model: "example-model",
  contextWindowTokens: 200_000,
  compactorId: "native-summary-v1",
  pricing: {
    currency: "USD",
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  cachePolicy: { ttlMs: 300_000 },
};

const started = Date.now();
let contextTokens = 40_000;
let lastPromptTokens = 0;

for (let step = 0; step < 12; step += 1) {
  const timestamp = started + step * 10_000;
  contextTokens += 12_000;

  // The provider would report these numbers after the call; here they are simulated.
  const cachedTokens = lastPromptTokens > 0 ? Math.min(lastPromptTokens, contextTokens) : 0;

  const decision = foldPoint.decide({
    profile,
    timestamp,
    contextTokens,
    cachedTokens,
    safeBoundary: true,
    compactionAllowed: true,
  });

  console.log(
    [
      `step ${String(step).padStart(2)}`,
      `context=${contextTokens}`,
      `utilization=${decision.metrics.utilization.toFixed(3)}`,
      `survival=${decision.metrics.estimatedCacheSurvival.toFixed(2)}`,
      `breakEven=${decision.metrics.breakEvenCalls?.toFixed(2) ?? "n/a"}`,
      `-> ${decision.action}`,
      `[${decision.reasons.join(", ")}]`,
    ].join("  "),
  );

  if (decision.action !== "KEEP") {
    const afterTokens = Math.round(contextTokens * 0.35);
    console.log(`         host compacts: ${contextTokens} -> ${afterTokens} tokens`);
    foldPoint.recordCompaction(profile, {
      timestamp,
      beforeTokens: contextTokens,
      afterTokens,
      promptTokens: contextTokens,
      outputTokens: 2_000,
      success: true,
    });
    contextTokens = afterTokens;
    lastPromptTokens = 0;
  }

  foldPoint.observeRequest(profile, {
    timestamp,
    promptTokens: contextTokens,
    cachedInputTokens: Math.min(lastPromptTokens, contextTokens),
    outputTokens: 400,
  });
  lastPromptTokens = contextTokens;
}

foldPoint.endSession(profile, { timestamp: started + 12 * 10_000 });

console.log("\nlearned profile state:");
console.log(JSON.stringify(foldPoint.getProfileState(profile), null, 2));
console.log("\nexported state is plain JSON:");
console.log(JSON.stringify(foldPoint.exportState()));
