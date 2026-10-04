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
  /** Host-owned runtime risk allowance; never replenished using guessed payback. */
  remainingRuntimeLossBudget?: number;
  /** Diagnostic comparison only: false reproduces the previous force-only wait path. */
  allowWaitOne?: boolean;
}

export interface RuntimeSurvivalEstimate {
  compactNowCost: number;
  keepThenForceCost: number;
  waitOneThenCompactCost: number;
  bestWaitCost: number;
  waitOneAvailable: boolean;
  expectedSaving: number;
  stressedSaving: number;
  immediateLoss: number;
  stressedImmediateLoss: number;
  immediateLossBudget: number;
  remainingRuntimeLossBudget: number | null;
  runtimeRiskAllowed: boolean;
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

/** An estimated-risk ledger, not a provider spending cap or realized-regret bound.
 * Charge at dispatch/settlement, not on repeated read-only decisions. Failed dispatched
 * summaries consume their observed fees. Safety FORCE is separate from economic risk.
 * Never refund using a fabricated counterfactual saving. Create anew for each runtime.
 */
export class RuntimeRiskBudget {
  private spent = 0;
  constructor(private readonly budget: number) {
    bounded("runtimeRiskBudget", budget, Number.MAX_VALUE);
  }
  charge(estimatedOrObservedLoss: number): void {
    bounded("estimatedOrObservedLoss", estimatedOrObservedLoss, Number.MAX_VALUE);
    if (!Number.isFinite(this.spent + estimatedOrObservedLoss))
      throw new RangeError("runtime risk total overflow");
    this.spent += estimatedOrObservedLoss;
  }
  report() {
    return {
      budget: this.budget,
      spent: this.spent,
      remaining: Math.max(0, this.budget - this.spent),
      overBudget: this.spent > this.budget,
    };
  }
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
  const remainingRisk =
    options.remainingRuntimeLossBudget === undefined
      ? Infinity
      : bounded("remainingRuntimeLossBudget", options.remainingRuntimeLossBudget, Number.MAX_VALUE);
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

  function path(firstCompactAt: 0 | 1 | null, probability: number, keptRatio: number) {
    let context = original;
    let prefix = 0;
    let cost = 0;
    let survival = 1;
    let reachForce = 0;
    let first = true;
    let available = true;
    for (let i = 0; i < maxCalls; i++) {
      const force = i > 0 && context >= m.guardedForceBoundaryTokens;
      const planned = i === firstCompactAt;
      const compact = planned || force;
      if (planned && i === 1 && !force) {
        const keepReplay = costOfCall(prices, context, {
          prefixTokens: prefix * coverage,
          aliveProbability: m.estimatedCacheLaterAliveProbability,
          cachingInPlay,
        });
        const loss = Math.max(
          0,
          context * summaryPerToken +
            context *
              keptRatio *
              (cachingInPlay ? prices.cacheWritePerToken : prices.inputPerToken) -
            keepReplay,
        );
        available = loss <= remainingRisk && loss <= lossRatio * keepReplay;
      }
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
    return { cost, reachForce, available };
  }

  const now = path(0, q, retention);
  const defer = path(null, q, retention);
  const waitOne = path(1, q, retention);
  const stressQ = Math.max(0, q - qStress);
  const stressRetention = Math.min(1, retention + retentionStress);
  const stressNow = path(0, stressQ, stressRetention);
  const stressDefer = path(null, stressQ, stressRetention);
  const stressWaitOne = path(1, stressQ, stressRetention);
  if (options.allowWaitOne !== undefined && typeof options.allowWaitOne !== "boolean")
    throw new RangeError("allowWaitOne must be boolean");
  const waitOneAvailable =
    options.allowWaitOne !== false && maxCalls > 1 && waitOne.available && stressWaitOne.available;
  const bestWaitCost = Math.min(defer.cost, waitOneAvailable ? waitOne.cost : Infinity);
  const stressedSaving =
    Math.min(stressDefer.cost, waitOneAvailable ? stressWaitOne.cost : Infinity) - stressNow.cost;
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
  const expectedSaving = bestWaitCost - now.cost;
  const runtimeRiskAllowed = Math.max(immediateLoss, stressedImmediateLoss) <= remainingRisk;
  const requiredSaving = marginRatio * m.estimatedCompactCallCost;
  return {
    compactNowCost: now.cost,
    keepThenForceCost: defer.cost,
    waitOneThenCompactCost: waitOne.cost,
    bestWaitCost,
    waitOneAvailable,
    expectedSaving,
    stressedSaving,
    immediateLoss,
    stressedImmediateLoss,
    immediateLossBudget,
    remainingRuntimeLossBudget: Number.isFinite(remainingRisk) ? remainingRisk : null,
    runtimeRiskAllowed,
    probabilityOfUnmodeledTail: q ** maxCalls,
    modeledCalls: maxCalls,
    probabilityReachForce: defer.reachForce,
    eligible,
    shouldCompact:
      eligible &&
      runtimeRiskAllowed &&
      q ** maxCalls <= 0.05 &&
      immediateLoss <= immediateLossBudget &&
      stressedImmediateLoss <= immediateLossBudget &&
      expectedSaving > requiredSaving &&
      stressedSaving > requiredSaving,
  };
}
