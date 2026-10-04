/** Opt-in research policy. Not wired into FoldPoint.decide or the Pi adapter. */
import { isCachingInPlay } from "./cache";
import { costOfCall, resolveUnitPrices } from "./pricing";
import type { FoldPointDecision, FoldPointInput } from "./types";

export interface RuntimeSurvivalOptions {
  /** P(another ordinary model call in this runtime). No future user commands. */
  continuationProbability: number;
  /** Maximum extra expense if this call ends the runtime, relative to its replay cost. */
  maxImmediateLossRatio: number;
  /** Bounded look-ahead; the unmodeled tail is reported, not claimed to be zero. */
  maxCalls?: number;
  probabilityStress?: number;
  retentionStress?: number;
  savingMarginRatio?: number;
}

export interface RuntimeSurvivalEstimate {
  compactNowCost: number;
  keepThenForceCost: number;
  expectedSaving: number;
  stressedSaving: number;
  immediateLoss: number;
  stressedImmediateLoss: number;
  immediateLossBudget: number;
  probabilityOfUnmodeledTail: number;
  modeledCalls: number;
  probabilityReachForce: number;
  eligible: boolean;
  shouldCompact: boolean;
}

function bounded(name: string, value: number, max = 1): number {
  if (!Number.isFinite(value) || value < 0 || value > max)
    throw new RangeError(`${name} must be finite in [0, ${max}]`);
  return value;
}

/** Beta-smoothed transition frequency, not a task-completion estimator.
 * Call only with ordinary task calls from one completed or censored runtime.
 * Interrupted runtimes contribute observed continuations, never an invented ending.
 * Keep one instance per compatible host/model/workload; do not learn on held-out tests.
 */
export class RuntimeContinuationLearner {
  private continued = 0;
  private ended = 0;
  constructor(
    private readonly priorProbability: number,
    private readonly priorWeight = 10,
  ) {
    bounded("priorProbability", priorProbability);
    if (priorProbability === 1) throw new RangeError("priorProbability must be less than 1");
    if (!Number.isFinite(priorWeight) || priorWeight <= 0)
      throw new RangeError("priorWeight must be finite and positive");
  }
  observeRuntime(ordinaryCalls: number, completed: boolean): void {
    if (!Number.isSafeInteger(ordinaryCalls) || ordinaryCalls < 0)
      throw new RangeError("ordinaryCalls must be a non-negative safe integer");
    if (typeof completed !== "boolean") throw new RangeError("completed must be boolean");
    this.continued += Math.max(ordinaryCalls - 1, 0);
    if (completed && ordinaryCalls > 0) this.ended += 1;
  }
  report() {
    return {
      continued: this.continued,
      ended: this.ended,
      continuationProbability:
        (this.priorProbability * this.priorWeight + this.continued) /
        (this.priorWeight + this.continued + this.ended),
    };
  }
}

const BLOCKING_REASONS = new Set([
  "COMPACTION_DISABLED",
  "RUNTIME_IDLE",
  "UNSAFE_BOUNDARY",
  "COOLDOWN_ACTIVE",
  "INSUFFICIENT_RECLAIM_TOKENS",
  "INSUFFICIENT_RECLAIM_RATIO",
  "BELOW_SOFT_WINDOW",
]);

/** Reuses the core's learned cost metadata and safety/eligibility gates, not its horizon.
 * Both paths share a geometric runtime survival distribution and positive growth forecast.
 * Summaries, rebuilds and repeated safety compactions are billed on each path independently.
 * This is a bounded conditional expectation, NOT a guarantee of payback or task quality.
 */
export function estimateRuntimeSurvival(
  input: FoldPointInput,
  baseline: FoldPointDecision,
  options: RuntimeSurvivalOptions,
): RuntimeSurvivalEstimate {
  const q = bounded("continuationProbability", options.continuationProbability);
  if (q === 1) throw new RangeError("continuationProbability must be less than 1");
  const lossRatio = bounded("maxImmediateLossRatio", options.maxImmediateLossRatio, 100);
  const qStress = bounded("probabilityStress", options.probabilityStress ?? 0.05);
  const retentionStress = bounded("retentionStress", options.retentionStress ?? 0.05);
  const marginRatio = bounded("savingMarginRatio", options.savingMarginRatio ?? 0.1);
  const maxCalls = options.maxCalls ?? 64;
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 256)
    throw new RangeError("maxCalls must be an integer in [1, 256]");
  const m = baseline.metrics;
  const prices = resolveUnitPrices(input.profile.pricing);
  const original = input.contextTokens;
  const retention = original > 0 ? m.estimatedPostCompactTokens / original : 1;
  const coverage = original > 0 ? m.estimatedCacheLaterCandidateTokens / original : 0;
  const growth = m.estimatedGrowthTokensPerCall;
  const summaryPerToken = original > 0 ? m.estimatedCompactCallCost / original : 0;
  const cachingInPlay = isCachingInPlay(
    {
      cachePolicy: input.profile.cachePolicy,
      cacheExpiresAt: input.cacheExpiresAt,
      hasCacheDiscount: prices.hasCacheDiscount,
    },
    m.estimatedCacheLaterCandidateTokens > 0,
  );

  function path(compactNow: boolean, probability: number, keptRatio: number) {
    let context = original;
    let prefix = 0;
    let cost = 0;
    let survival = 1;
    let reachForce = 0;
    let first = true;
    for (let i = 0; i < maxCalls; i++) {
      const force = i > 0 && context >= m.guardedForceBoundaryTokens;
      const compact = (i === 0 && compactNow) || force;
      if (force && reachForce === 0) reachForce = survival;
      if (compact) {
        cost += survival * context * summaryPerToken;
        context *= keptRatio;
        prefix = 0;
      }
      const replay = compact
        ? context * (cachingInPlay ? prices.cacheWritePerToken : prices.inputPerToken)
        : first
          ? m.estimatedCurrentCallReplayCost
          : costOfCall(prices, context, {
              prefixTokens: prefix * coverage,
              aliveProbability: m.estimatedCacheLaterAliveProbability,
              cachingInPlay,
            });
      cost += survival * replay;
      prefix = context;
      context += growth;
      first = false;
      survival *= probability;
    }
    return { cost, reachForce };
  }

  const now = path(true, q, retention);
  const defer = path(false, q, retention);
  const stressQ = Math.max(0, q - qStress);
  const stressRetention = Math.min(1, retention + retentionStress);
  const stressedSaving =
    path(false, stressQ, stressRetention).cost - path(true, stressQ, stressRetention).cost;
  const immediateLoss = Math.max(
    0,
    m.estimatedCompactCallCost +
      m.estimatedFirstPostCompactReplayCost -
      m.estimatedCurrentCallReplayCost,
  );
  const immediateLossBudget = lossRatio * m.estimatedCurrentCallReplayCost;
  const stressedImmediateLoss = Math.max(
    0,
    m.estimatedCompactCallCost +
      original *
        stressRetention *
        (cachingInPlay ? prices.cacheWritePerToken : prices.inputPerToken) -
      m.estimatedCurrentCallReplayCost,
  );
  const eligible =
    baseline.action !== "FORCE" &&
    input.runtimeStatus !== "idle" &&
    input.safeBoundary !== false &&
    input.compactionAllowed !== false &&
    original > 0 &&
    !baseline.reasons.some((reason) => BLOCKING_REASONS.has(reason));
  const expectedSaving = defer.cost - now.cost;
  const requiredSaving = marginRatio * m.estimatedCompactCallCost;
  return {
    compactNowCost: now.cost,
    keepThenForceCost: defer.cost,
    expectedSaving,
    stressedSaving,
    immediateLoss,
    stressedImmediateLoss,
    immediateLossBudget,
    probabilityOfUnmodeledTail: q ** maxCalls,
    modeledCalls: maxCalls,
    probabilityReachForce: defer.reachForce,
    eligible,
    shouldCompact:
      eligible &&
      q ** maxCalls <= 0.05 &&
      immediateLoss <= immediateLossBudget &&
      stressedImmediateLoss <= immediateLossBudget &&
      expectedSaving > requiredSaving &&
      stressedSaving > requiredSaving,
  };
}
