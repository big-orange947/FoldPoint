import type { CachePolicy, PricingSnapshot } from "../src/index";

/**
 * A deterministic simulated agent session.
 *
 * Ground truth (how well the compactor really compresses, what the provider really
 * charges) lives here and is NEVER handed to a strategy: FoldPoint only ever sees what a
 * host would report through `observeRequest` / `recordCompaction`.
 */
export interface Scenario {
  id: string;
  name: string;
  title: string;
  seed: number;

  contextWindowTokens: number;
  pricing: PricingSnapshot;
  cachePolicy: CachePolicy;

  steps: number;
  startTokens: number;
  /** Tokens appended to the context at the start of every step. */
  growthPerStep: number;
  /** Seeded jitter applied to the per-step growth, in tokens. */
  growthJitter: number;
  /** Output tokens of each regular model call. */
  outputTokens: number;
  /** Milliseconds of idle time between model calls. */
  idleMs: number;

  compactor: {
    /** Ground-truth afterTokens / beforeTokens. */
    retentionRatio: number;
    /** Ground-truth compaction output tokens / beforeTokens. */
    outputRatio: number;
    successRate: number;
  };

  /** Expected future calls the host is willing to declare, when it plausibly knows. */
  hostHorizon?: number;
  /** A single step that appends an unusually large tool output. */
  suddenGrowth?: { step: number; tokens: number };
}

const USD = {
  currency: "USD",
  inputPerMillion: 3,
  outputPerMillion: 15,
  cacheReadPerMillion: 0.3,
  cacheWritePerMillion: 3.75,
};

const CHEAP_CACHE = {
  currency: "USD",
  inputPerMillion: 3,
  outputPerMillion: 15,
  cacheReadPerMillion: 0.1,
  cacheWritePerMillion: 3.75,
};

const NO_CACHE_DISCOUNT = {
  currency: "USD",
  inputPerMillion: 3,
  outputPerMillion: 15,
  cacheReadPerMillion: 3,
  cacheWritePerMillion: 3.75,
};

/** A short task: the window is never close to full and no compaction should be needed. */
const SCENARIO_A: Scenario = {
  id: "A",
  name: "short-task",
  title: "Short task that never approaches the window",
  seed: 1_001,
  contextWindowTokens: 200_000,
  pricing: USD,
  cachePolicy: { ttlMs: 60_000 },
  steps: 8,
  startTokens: 4_000,
  growthPerStep: 3_000,
  growthJitter: 500,
  outputTokens: 400,
  idleMs: 8_000,
  compactor: { retentionRatio: 0.3, outputRatio: 0.1, successRate: 1 },
};

/** A long tool-driven task that re-sends the same prefix on every call. */
const SCENARIO_B: Scenario = {
  id: "B",
  name: "long-tool-task",
  title: "Long tool-calling task with a stable, repeatedly replayed prefix",
  seed: 1_002,
  contextWindowTokens: 200_000,
  pricing: USD,
  cachePolicy: { ttlMs: 120_000 },
  steps: 80,
  startTokens: 8_000,
  growthPerStep: 5_000,
  growthJitter: 1_500,
  outputTokens: 600,
  idleMs: 15_000,
  compactor: { retentionRatio: 0.35, outputRatio: 0.1, successRate: 1 },
  hostHorizon: 10,
};

/** The cache stays warm and cache reads are very cheap: replaying is nearly free. */
const SCENARIO_C: Scenario = {
  id: "C",
  name: "cache-alive",
  title: "Warm cache with very cheap cache reads and short idle gaps",
  seed: 1_003,
  contextWindowTokens: 200_000,
  pricing: CHEAP_CACHE,
  cachePolicy: { ttlMs: 300_000 },
  steps: 80,
  startTokens: 20_000,
  growthPerStep: 6_000,
  growthJitter: 1_000,
  outputTokens: 500,
  idleMs: 5_000,
  compactor: { retentionRatio: 0.4, outputRatio: 0.1, successRate: 1 },
  hostHorizon: 20,
};

/** The same cheap cache, but every gap exceeds the TTL: the prefix is plain input again. */
const SCENARIO_D: Scenario = {
  id: "D",
  name: "cache-expired",
  title: "Idle gaps beyond the TTL turn the cheap cached prefix into plain input",
  seed: 1_004,
  contextWindowTokens: 200_000,
  pricing: CHEAP_CACHE,
  cachePolicy: { ttlMs: 120_000 },
  steps: 80,
  startTokens: 20_000,
  growthPerStep: 6_000,
  growthJitter: 1_000,
  outputTokens: 500,
  idleMs: 400_000,
  compactor: { retentionRatio: 0.4, outputRatio: 0.1, successRate: 1 },
  hostHorizon: 20,
};

/** A strong compactor: once learned, compaction should become attractive earlier. */
const SCENARIO_E: Scenario = {
  id: "E",
  name: "good-compactor",
  title: "Strong compactor (after/before = 0.25), cache cold so compactor quality dominates",
  seed: 1_005,
  contextWindowTokens: 200_000,
  pricing: USD,
  cachePolicy: { ttlMs: 120_000 },
  steps: 70,
  startTokens: 10_000,
  growthPerStep: 6_000,
  growthJitter: 1_000,
  outputTokens: 500,
  idleMs: 400_000,
  compactor: { retentionRatio: 0.25, outputRatio: 0.08, successRate: 1 },
  hostHorizon: 15,
};

/** A weak compactor: once learned, economic compaction should stop firing. */
const SCENARIO_F: Scenario = {
  id: "F",
  name: "bad-compactor",
  title: "Weak compactor (after/before = 0.95), cache cold so compactor quality dominates",
  seed: 1_006,
  contextWindowTokens: 200_000,
  pricing: USD,
  cachePolicy: { ttlMs: 120_000 },
  steps: 70,
  startTokens: 10_000,
  growthPerStep: 6_000,
  growthJitter: 1_000,
  outputTokens: 500,
  idleMs: 400_000,
  compactor: { retentionRatio: 0.95, outputRatio: 0.08, successRate: 1 },
  hostHorizon: 15,
};

/** The compaction call itself is expensive: it must not fire early. */
const SCENARIO_G: Scenario = {
  id: "G",
  name: "expensive-compaction",
  title: "Expensive compaction call (large output, high output price)",
  seed: 1_007,
  contextWindowTokens: 200_000,
  pricing: {
    currency: "USD",
    inputPerMillion: 3,
    outputPerMillion: 60,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  cachePolicy: { ttlMs: 120_000 },
  steps: 70,
  startTokens: 10_000,
  growthPerStep: 6_000,
  growthJitter: 1_000,
  outputTokens: 500,
  idleMs: 20_000,
  compactor: { retentionRatio: 0.4, outputRatio: 0.4, successRate: 1 },
  hostHorizon: 10,
};

/** A single huge tool output: only the window guard can save the session. */
const SCENARIO_H: Scenario = {
  id: "H",
  name: "sudden-growth",
  title: "One step adds a very large tool output",
  seed: 1_008,
  contextWindowTokens: 200_000,
  pricing: USD,
  cachePolicy: { ttlMs: 120_000 },
  steps: 40,
  startTokens: 10_000,
  growthPerStep: 2_000,
  growthJitter: 300,
  outputTokens: 400,
  idleMs: 20_000,
  compactor: { retentionRatio: 0.3, outputRatio: 0.1, successRate: 1 },
  hostHorizon: 12,
  suddenGrowth: { step: 20, tokens: 180_000 },
};

/** The context regrows quickly after every compaction: churn must be prevented. */
const SCENARIO_I: Scenario = {
  id: "I",
  name: "compaction-churn",
  title: "Context regrows fast, so repeated compaction is tempting",
  seed: 1_009,
  contextWindowTokens: 200_000,
  pricing: USD,
  cachePolicy: { ttlMs: 120_000 },
  steps: 60,
  startTokens: 10_000,
  growthPerStep: 9_000,
  growthJitter: 500,
  outputTokens: 500,
  idleMs: 20_000,
  compactor: { retentionRatio: 0.5, outputRatio: 0.1, successRate: 1 },
  hostHorizon: 30,
};

/** No cache discount at all: cache variables must not manufacture savings. */
const SCENARIO_J: Scenario = {
  id: "J",
  name: "no-cache-discount",
  title: "Provider charges the same for cache reads and plain input",
  seed: 1_010,
  contextWindowTokens: 200_000,
  pricing: NO_CACHE_DISCOUNT,
  cachePolicy: { ttlMs: 120_000 },
  steps: 70,
  startTokens: 10_000,
  growthPerStep: 6_000,
  growthJitter: 1_000,
  outputTokens: 500,
  idleMs: 20_000,
  compactor: { retentionRatio: 0.4, outputRatio: 0.1, successRate: 1 },
  hostHorizon: 15,
};

export const SCENARIOS: readonly Scenario[] = Object.freeze([
  SCENARIO_A,
  SCENARIO_B,
  SCENARIO_C,
  SCENARIO_D,
  SCENARIO_E,
  SCENARIO_F,
  SCENARIO_G,
  SCENARIO_H,
  SCENARIO_I,
  SCENARIO_J,
]);

/** mulberry32: tiny, fast, fully deterministic. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Per-step growth for a scenario, including seeded jitter and any sudden jump. */
export function growthAtStep(scenario: Scenario, step: number, random: () => number): number {
  const jitter = scenario.growthJitter > 0 ? (random() * 2 - 1) * scenario.growthJitter : 0;
  const sudden = scenario.suddenGrowth?.step === step ? scenario.suddenGrowth.tokens : 0;
  return Math.max(0, Math.round(scenario.growthPerStep + jitter + sudden));
}
