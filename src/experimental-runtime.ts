/** Opt-in research policy. Not wired into FoldPoint.decide or the Pi adapter. */
import { isCachingInPlay } from "./cache";
import { type CompactorTokenModel, predictCompactorTokens } from "./experimental-compactor";
import {
  type CycleBilling,
  postCompactBill,
  summaryBill,
  validateCycleBilling,
} from "./experimental-cycle";
import { costOfCall, resolveUnitPrices } from "./pricing";
import type { FoldPointDecision, FoldPointInput } from "./types";

export interface RuntimeDurationModel {
  /** Completed ordinary calls in this runtime; excludes summaries, retries and warm-ups. */
  completedCalls: number;
  /** Explicit host prior. Not inferred from task text or a known task endpoint. */
  components: readonly { weight: number; continuationProbability: number }[];
}

/** Conditional survival of a mixture, not a geometric fit to its current mean hazard. */
export function estimateRuntimeDuration(
  model: RuntimeDurationModel,
  maxCalls = 64,
  stressMass = 0.05,
) {
  if (!Number.isSafeInteger(model.completedCalls) || model.completedCalls < 0)
    throw new RangeError("completedCalls must be a non-negative safe integer");
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 256)
    throw new RangeError("maxCalls must be an integer in [1, 256]");
  bounded("stressMass", stressMass);
  if (model.components.length < 1 || model.components.length > 8)
    throw new RangeError("duration model requires 1..8 components");
  const logs = model.components.map((c) => {
    bounded("weight", c.weight, Number.MAX_VALUE);
    if (c.weight === 0) throw new RangeError("component weight must be positive");
    bounded("continuationProbability", c.continuationProbability);
    if (c.continuationProbability === 1)
      throw new RangeError("component probability must be less than 1");
    return (
      Math.log(c.weight) +
      (model.completedCalls === 0
        ? 0
        : c.continuationProbability === 0
          ? -Infinity
          : model.completedCalls * Math.log(c.continuationProbability))
    );
  });
  const largest = Math.max(...logs);
  if (!Number.isFinite(largest)) throw new RangeError("observed duration impossible under prior");
  const masses = logs.map((v) => Math.exp(v - largest));
  const total = masses.reduce((a, b) => a + b, 0);
  const posterior = masses.map((v) => v / total);
  const shortest = model.components.reduce(
    (best, c, i) =>
      c.continuationProbability < (model.components[best]?.continuationProbability ?? Infinity)
        ? i
        : best,
    0,
  );
  // Stress shifts posterior mass toward shorter durations, not every q by a fixed amount.
  const stressed = posterior.map(
    (w, i) => w * (1 - stressMass) + (i === shortest ? stressMass : 0),
  );
  const curve = (weights: number[]) =>
    Array.from({ length: maxCalls + 1 }, (_, k) =>
      weights.reduce(
        (sum, w, i) => sum + w * (model.components[i]?.continuationProbability ?? 0) ** k,
        0,
      ),
    );
  return {
    posterior,
    survival: curve(posterior),
    stressedSurvival: curve(stressed),
    expectedCallsIncludingCurrent: posterior.reduce(
      (sum, w, i) => sum + w / (1 - (model.components[i]?.continuationProbability ?? 0)),
      0,
    ),
  };
}

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
  /** Opt-in repeating economic boundaries, instead of safety-only future summaries. */
  rolloutMode?: "safety" | "renewal";
  /** Opt-in expected immediate-ending loss; never a realized regret guarantee. */
  endingRiskMode?: "worst-case" | "survival-weighted";
  /** Required for weighted mode: ending loss allowance / modeled WAIT input+summary cost. */
  endingLossBudgetRatio?: number;
  durationModel?: RuntimeDurationModel;
  /** Opt-in differential timing margin; requires renewal and the wait-one alternative. */
  savingMarginBasis?: "summary" | "timing";
  /** Past successful observations only; never supply fixture truth or future summaries. */
  compactorTokenModel?: CompactorTokenModel;
  /** Explicit host billing contract only; never infer summary cache sharing from model name. */
  cycleBilling?: CycleBilling;
  /** Opt-in: stress the SAME nominally selected WAIT policy, not an independent envelope winner. */
  stressWaitSelection?: "paired-policy";
  /** One-step improvement against WAIT's nominally selected common continuation policy.
   * Reuses its repeat boundary on NOW; no recursive future economic-rule equivalence. */
  renewalComparison?: "shared-wait-continuation";
  /** Extra conservative qualification hypothesis for current and forecast economic attempts.
   * Stops before KEEP's next safety action; NOT necessary for full-task savings or recursive equivalence. */
  forecastPaybackGate?: "single-cycle";
  /** Opt-in host execution gates; values must match the host, not fixture targets. */
  executionConstraints?: {
    hasAttempt: boolean;
    minCallsBetweenCompactions: number;
    minReclaimTokens: number;
    minReclaimRatio: number;
    softWindowTokens: number;
  };
}

export interface RuntimeSurvivalEstimate {
  commonContinuation?: {
    repeatBoundaryTokens: number;
    waitFirstCompactAt: 1 | null;
    independentlyOptimizedNowCost: number;
    independentlyOptimizedStressedNowCost: number;
  };
  forecastPaybackBlocks?: number;
  cyclePayback?: {
    horizonCalls: number;
    nominalSaving: number;
    stressedSaving: number;
    requiredSaving: number;
    allowed: boolean;
  };
  stressWaitPolicy?: {
    firstCompactAt: 1 | null;
    repeatBoundaryTokens: number;
    nominalCost: number;
    stressedCost: number;
    independentlyOptimizedStressedCost: number;
    stressedNowCost: number;
  };
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
  rolloutCandidates: number;
  selectedRepeatBoundaryTokens: number | null;
  assessedEndingLoss: number;
  continuationProbabilityNext: number;
  expectedCallsIncludingCurrent: number;
  requiredSaving: number;
  savingMarginCostScale: number;
  forecastCooldownBlocks: number;
  forecastReclaimBlocks: number;
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
  let q = bounded("continuationProbability", options.continuationProbability);
  if (q === 1) throw new RangeError("continuationProbability must be less than 1");
  const lossRatio = bounded("maxImmediateLossRatio", options.maxImmediateLossRatio, 100);
  const qStress = bounded("probabilityStress", options.probabilityStress ?? 0.05);
  if (options.stressWaitSelection !== undefined && options.stressWaitSelection !== "paired-policy")
    throw new RangeError("invalid stressWaitSelection");
  if (options.renewalComparison !== undefined) {
    if (options.renewalComparison !== "shared-wait-continuation")
      throw new RangeError("invalid renewalComparison");
    if (options.rolloutMode !== "renewal" || options.stressWaitSelection !== "paired-policy")
      throw new RangeError("shared continuation requires renewal and paired-policy stress");
    if (options.forecastPaybackGate !== undefined)
      throw new RangeError("shared continuation ablation excludes the single-cycle gate");
  }
  if (options.forecastPaybackGate !== undefined && options.forecastPaybackGate !== "single-cycle")
    throw new RangeError("invalid forecastPaybackGate");
  const retentionStress = bounded("retentionStress", options.retentionStress ?? 0.05);
  const marginRatio = bounded("savingMarginRatio", options.savingMarginRatio ?? 0.1);
  if (
    options.savingMarginBasis !== undefined &&
    !["summary", "timing"].includes(options.savingMarginBasis)
  )
    throw new RangeError("invalid savingMarginBasis");
  if (
    options.savingMarginBasis === "timing" &&
    (options.rolloutMode !== "renewal" || options.allowWaitOne === false)
  )
    throw new RangeError("timing margin requires renewal with wait-one enabled");
  const endingBudgetRatio =
    options.endingRiskMode === "survival-weighted"
      ? bounded("endingLossBudgetRatio", options.endingLossBudgetRatio ?? NaN)
      : 0;
  const remainingRisk =
    options.remainingRuntimeLossBudget === undefined
      ? Infinity
      : bounded("remainingRuntimeLossBudget", options.remainingRuntimeLossBudget, Number.MAX_VALUE);
  const maxCalls = options.maxCalls ?? 64;
  if (options.rolloutMode !== undefined && !["safety", "renewal"].includes(options.rolloutMode))
    throw new RangeError("invalid rolloutMode");
  if (
    options.endingRiskMode !== undefined &&
    !["worst-case", "survival-weighted"].includes(options.endingRiskMode)
  )
    throw new RangeError("invalid endingRiskMode");
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 256)
    throw new RangeError("maxCalls must be an integer in [1, 256]");
  const duration = options.durationModel
    ? estimateRuntimeDuration(options.durationModel, maxCalls, qStress)
    : undefined;
  if (duration) q = duration.survival[1] ?? 0;
  const nominalCurve = duration?.survival;
  const stressedCurve = duration?.stressedSurvival;
  const curveSums = new Map<readonly number[], number[]>();
  for (const curve of [nominalCurve, stressedCurve]) {
    if (!curve) continue;
    const sums = Array<number>(maxCalls + 1).fill(0);
    for (let i = maxCalls - 1; i >= 0; i--) sums[i] = (sums[i + 1] ?? 0) + (curve[i] ?? 0);
    curveSums.set(curve, sums);
  }
  const m = baseline.metrics;
  const prices = resolveUnitPrices(input.profile.pricing);
  const original = input.contextTokens;
  const retention = original > 0 ? m.estimatedPostCompactTokens / original : 1;
  const coverage = original > 0 ? m.estimatedCacheLaterCandidateTokens / original : 0;
  const growth = m.estimatedGrowthTokensPerCall;
  const summaryPerToken = original > 0 ? m.estimatedCompactCallCost / original : 0;
  const tokenModel = options.compactorTokenModel;
  const billing = options.cycleBilling;
  if (billing) {
    validateCycleBilling(billing);
    if (!tokenModel) throw new RangeError("cycleBilling requires compactorTokenModel");
  }
  const constraints = options.executionConstraints;
  if (constraints) {
    if (typeof constraints.hasAttempt !== "boolean")
      throw new RangeError("hasAttempt must be boolean");
    for (const v of [
      constraints.minCallsBetweenCompactions,
      constraints.minReclaimTokens,
      constraints.softWindowTokens,
    ])
      if (!Number.isSafeInteger(v) || v < 0) throw new RangeError("invalid execution constraint");
    bounded("minReclaimRatio", constraints.minReclaimRatio);
  }
  if (tokenModel) {
    bounded("summary input price", tokenModel.summaryInputCostPerToken, Number.MAX_VALUE);
    for (const c of [tokenModel.after, tokenModel.output])
      for (const v of [c.slope, c.intercept, c.residual])
        bounded("compactor coefficient", v, Number.MAX_VALUE);
  }
  // Independently observed input billing, not the old ratio's output fee subtracted twice.
  const summaryInputPerToken = tokenModel ? tokenModel.summaryInputCostPerToken : summaryPerToken;
  function summaryCost(context: number, stressed = false, prefix = 0, alive = 0) {
    if (billing && tokenModel)
      return summaryBill(prices, tokenModel, context, prefix, alive, billing, stressed);
    return tokenModel
      ? context * summaryInputPerToken +
          predictCompactorTokens(tokenModel, context, stressed).outputTokens * prices.outputPerToken
      : context * summaryPerToken;
  }
  function postTokens(context: number, keptRatio: number) {
    if (!tokenModel) return context * keptRatio;
    const stressed = keptRatio > retention;
    return Math.min(
      context,
      predictCompactorTokens(tokenModel, context, stressed).afterTokens +
        (stressed ? context * retentionStress : 0),
    );
  }
  const cachingInPlay = isCachingInPlay(
    {
      cachePolicy: input.profile.cachePolicy,
      cacheExpiresAt: input.cacheExpiresAt,
      hasCacheDiscount: prices.hasCacheDiscount,
    },
    m.estimatedCacheLaterCandidateTokens > 0,
  );
  const currentPrefix =
    input.reusablePrefixTokens ??
    input.cachedTokens ??
    (m.estimatedCacheAliveProbability > 0
      ? m.estimatedEffectiveCachedTokens / m.estimatedCacheAliveProbability
      : 0);
  function rebuildCost(after: number) {
    if (!billing) return after * (cachingInPlay ? prices.cacheWritePerToken : prices.inputPerToken);
    const cost = postCompactBill(prices, after, cachingInPlay, billing);
    return cost.prewarm + cost.ordinary;
  }

  function riskLoss(loss: number, probability: number) {
    return loss * (options.endingRiskMode === "survival-weighted" ? 1 - probability : 1);
  }
  function futureMass(age: number, horizon: number, stressed: boolean) {
    const geometric = (probability: number) =>
      horizon <= 1 ? 0 : (probability * (1 - probability ** (horizon - 1))) / (1 - probability);
    if (!duration || !options.durationModel)
      return geometric(stressed ? Math.max(0, q - qStress) : q);
    const components = options.durationModel.components;
    const masses = duration.posterior.map(
      (w, j) => w * (components[j]?.continuationProbability ?? 0) ** age,
    );
    const total = masses.reduce((sum, v) => sum + v, 0);
    if (total === 0) return 0;
    const shortest = components.reduce(
      (best, c, j) =>
        c.continuationProbability < (components[best]?.continuationProbability ?? Infinity)
          ? j
          : best,
      0,
    );
    return masses.reduce(
      (sum, v, j) =>
        sum +
        ((v / total) * (stressed ? 1 - qStress : 1) + (stressed && j === shortest ? qStress : 0)) *
          geometric(components[j]?.continuationProbability ?? 0),
      0,
    );
  }
  function cycleAllowed(context: number, prefix: number, age: number, first: boolean) {
    const horizon =
      growth > 0
        ? Math.max(
            1,
            Math.min(maxCalls, Math.ceil((m.guardedForceBoundaryTokens - context) / growth)),
          )
        : maxCalls;
    const alive = first ? m.estimatedCacheAliveProbability : m.estimatedCacheLaterAliveProbability;
    const shared = first ? currentPrefix : prefix * coverage;
    const keep = first
      ? m.estimatedCurrentCallReplayCost
      : costOfCall(prices, context, {
          prefixTokens: shared,
          aliveProbability: alive,
          cachingInPlay,
        });
    const unit = costOfCall(prices, 1, {
      prefixTokens: coverage,
      aliveProbability: m.estimatedCacheLaterAliveProbability,
      cachingInPlay,
    });
    const nominalAfter = postTokens(context, retention);
    const stressedAfter = postTokens(context, Math.min(1, retention + retentionStress));
    const nominalSummary = summaryCost(context, false, shared, alive);
    const stressedSummary = summaryCost(context, true, shared, alive);
    const saving = (after: number, fee: number, stressed: boolean) => {
      const delta = (context - after) * unit;
      // A zero-token summary has no readable prefix on its first appended request.
      const nextCost = (tokens: number) =>
        costOfCall(prices, tokens + growth, {
          prefixTokens: tokens * coverage,
          aliveProbability: m.estimatedCacheLaterAliveProbability,
          cachingInPlay,
        });
      const correction =
        horizon > 1
          ? (nextCost(context) - nextCost(after) - delta) * futureMass(age, 2, stressed)
          : 0;
      return (
        keep - fee - rebuildCost(after) + delta * futureMass(age, horizon, stressed) + correction
      );
    };
    const scale =
      options.savingMarginBasis === "timing" && options.allowWaitOne !== false && horizon > 1
        ? keep +
          (billing
            ? Math.max(
                0,
                summaryCost(context + growth, false, shared + growth, alive) - nominalSummary,
              )
            : growth * summaryPerToken)
        : nominalSummary;
    const nominalSaving = saving(nominalAfter, nominalSummary, false);
    const stressedSaving = saving(stressedAfter, stressedSummary, true);
    const requiredSaving = marginRatio * scale;
    return {
      horizonCalls: horizon,
      nominalSaving,
      stressedSaving,
      requiredSaving,
      allowed: nominalSaving > requiredSaving && stressedSaving > requiredSaving,
    };
  }
  function path(
    firstCompactAt: 0 | 1 | null,
    probability: number,
    keptRatio: number,
    repeatBoundary = m.guardedForceBoundaryTokens,
    curve?: readonly number[],
  ) {
    let context = original;
    let prefix = currentPrefix;
    let cost = 0;
    let survival = 1;
    let reachForce = 0;
    let first = true;
    let available = true;
    let hasAttempt = constraints?.hasAttempt ?? false;
    let callsSinceAttempt = m.callsSinceLastAttempt;
    let cooldownBlocks = 0;
    let reclaimBlocks = 0;
    let paybackBlocks = 0;
    for (let i = 0; i < maxCalls; i++) {
      if (curve) survival = curve[i] ?? 0;
      const stepProbability = curve && survival > 0 ? (curve[i + 1] ?? 0) / survival : probability;
      const force = i > 0 && context >= m.guardedForceBoundaryTokens;
      const planned = i === firstCompactAt;
      let compact = planned || force || (i > 0 && context >= repeatBoundary);
      if (compact && !force && constraints) {
        const reclaim = context - postTokens(context, keptRatio);
        const cooldown = hasAttempt && callsSinceAttempt < constraints.minCallsBetweenCompactions;
        const insufficient =
          reclaim < constraints.minReclaimTokens ||
          reclaim / Math.max(context, 1) < constraints.minReclaimRatio ||
          context < constraints.softWindowTokens;
        if (cooldown) cooldownBlocks++;
        if (insufficient) reclaimBlocks++;
        if (cooldown || insufficient) {
          compact = false;
          if (planned) available = false;
        }
      }
      if (
        compact &&
        !force &&
        options.forecastPaybackGate === "single-cycle" &&
        !cycleAllowed(context, prefix, i, first).allowed
      ) {
        paybackBlocks++;
        if (planned) available = false;
        // Price NOW as a counterfactual even when it cannot dispatch.
        if (i > 0) compact = false;
      }
      if (compact && i > 0 && !force) {
        const keepReplay = costOfCall(prices, context, {
          prefixTokens: prefix * coverage,
          aliveProbability: m.estimatedCacheLaterAliveProbability,
          cachingInPlay,
        });
        const loss = Math.max(
          0,
          summaryCost(
            context,
            keptRatio > retention,
            prefix * coverage,
            m.estimatedCacheLaterAliveProbability,
          ) +
            rebuildCost(postTokens(context, keptRatio)) -
            keepReplay,
        );
        const prospectiveBudget =
          options.endingRiskMode === "survival-weighted"
            ? endingBudgetRatio *
              keepReplay *
              (curve && survival > 0
                ? (curveSums.get(curve)?.[i] ?? 0) / survival
                : (1 - probability ** (maxCalls - i)) / (1 - probability))
            : lossRatio * keepReplay;
        const allowed =
          riskLoss(loss, stepProbability) <= remainingRisk &&
          riskLoss(loss, stepProbability) <= prospectiveBudget;
        if (planned) available = allowed;
        else if (!allowed) compact = false;
      }
      if (force && reachForce === 0) reachForce = survival;
      if (compact) {
        cost +=
          survival *
          summaryCost(
            context,
            keptRatio > retention,
            first ? currentPrefix : prefix * coverage,
            first ? m.estimatedCacheAliveProbability : m.estimatedCacheLaterAliveProbability,
          );
        context = postTokens(context, keptRatio);
        prefix = 0;
        hasAttempt = true;
        callsSinceAttempt = 0;
      }
      const replay = compact
        ? rebuildCost(context)
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
      callsSinceAttempt++;
      survival *= probability;
    }
    return { cost, reachForce, available, cooldownBlocks, reclaimBlocks, paybackBlocks };
  }

  let now = path(0, q, retention, undefined, nominalCurve);
  const defer = path(null, q, retention, undefined, nominalCurve);
  const waitOne = path(1, q, retention, undefined, nominalCurve);
  const stressQ = stressedCurve ? (stressedCurve[1] ?? 0) : Math.max(0, q - qStress);
  const stressRetention = Math.min(1, retention + retentionStress);
  let stressNow = path(0, stressQ, stressRetention, undefined, stressedCurve);
  const stressDefer = path(null, stressQ, stressRetention, undefined, stressedCurve);
  const stressWaitOne = path(1, stressQ, stressRetention, undefined, stressedCurve);
  if (options.allowWaitOne !== undefined && typeof options.allowWaitOne !== "boolean")
    throw new RangeError("allowWaitOne must be boolean");
  const waitOneAvailable =
    options.allowWaitOne !== false && maxCalls > 1 && waitOne.available && stressWaitOne.available;
  let bestWaitCost = Math.min(defer.cost, waitOneAvailable ? waitOne.cost : Infinity);
  let pairedWait = {
    firstCompactAt: null as 1 | null,
    repeatBoundaryTokens: m.guardedForceBoundaryTokens,
    nominalCost: defer.cost,
    stressedCost: stressDefer.cost,
  };
  if (waitOneAvailable && waitOne.cost < pairedWait.nominalCost)
    pairedWait = {
      firstCompactAt: 1,
      repeatBoundaryTokens: m.guardedForceBoundaryTokens,
      nominalCost: waitOne.cost,
      stressedCost: stressWaitOne.cost,
    };
  let independentStressWaitCost = Math.min(
    stressDefer.cost,
    waitOneAvailable ? stressWaitOne.cost : Infinity,
  );
  let stressedSaving =
    Math.min(stressDefer.cost, waitOneAvailable ? stressWaitOne.cost : Infinity) - stressNow.cost;
  let rolloutCandidates = 1;
  let selectedRepeatBoundaryTokens: number | null = null;
  if (options.rolloutMode === "renewal") {
    // Shared policy family on NOW and WAIT. No task endpoint or fixture threshold.
    // Sixteen bounded boundaries span the estimated post-compaction state to safety.
    const floor = Math.min(
      m.guardedForceBoundaryTokens,
      postTokens(m.guardedForceBoundaryTokens, stressRetention) + Math.max(growth, 1),
    );
    const boundaries = Array.from(
      { length: 16 },
      (_, i) => floor + ((m.guardedForceBoundaryTokens - floor) * i) / 15,
    );
    rolloutCandidates = boundaries.length;
    let bestNow = Infinity;
    let bestStressNow = Infinity;
    let bestWait = Infinity;
    let bestStressWait = Infinity;
    let selectedNow = now;
    for (const boundary of boundaries) {
      const candidate = path(0, q, retention, boundary, nominalCurve);
      const stressed = path(0, stressQ, stressRetention, boundary, stressedCurve);
      if (candidate.cost < bestNow) {
        bestNow = candidate.cost;
        selectedRepeatBoundaryTokens = boundary;
        bestStressNow = stressed.cost;
        selectedNow = candidate;
      }
      const waitCandidate = path(null, q, retention, boundary, nominalCurve);
      const stressWaitCandidate = path(null, stressQ, stressRetention, boundary, stressedCurve);
      if (waitCandidate.cost < pairedWait.nominalCost)
        pairedWait = {
          firstCompactAt: null,
          repeatBoundaryTokens: boundary,
          nominalCost: waitCandidate.cost,
          stressedCost: stressWaitCandidate.cost,
        };
      bestWait = Math.min(bestWait, waitCandidate.cost);
      bestStressWait = Math.min(bestStressWait, stressWaitCandidate.cost);
    }
    now = { ...selectedNow, cost: bestNow };
    stressNow = { ...stressNow, cost: bestStressNow };
    bestWaitCost = Math.min(bestWaitCost, bestWait);
    stressedSaving =
      Math.min(stressDefer.cost, waitOneAvailable ? stressWaitOne.cost : Infinity, bestStressWait) -
      bestStressNow;
    independentStressWaitCost = Math.min(independentStressWaitCost, bestStressWait);
  }
  let commonContinuation: RuntimeSurvivalEstimate["commonContinuation"];
  if (options.renewalComparison === "shared-wait-continuation") {
    commonContinuation = {
      repeatBoundaryTokens: pairedWait.repeatBoundaryTokens,
      waitFirstCompactAt: pairedWait.firstCompactAt,
      independentlyOptimizedNowCost: now.cost,
      independentlyOptimizedStressedNowCost: stressNow.cost,
    };
    // One baseline policy, selected on WAIT only. Do not optimize a different NOW future.
    // Both branches retain their own context, cache, cooldown, summaries and prewarm bills.
    selectedRepeatBoundaryTokens = pairedWait.repeatBoundaryTokens;
    now = path(0, q, retention, selectedRepeatBoundaryTokens, nominalCurve);
    stressNow = path(0, stressQ, stressRetention, selectedRepeatBoundaryTokens, stressedCurve);
    bestWaitCost = pairedWait.nominalCost;
  }
  if (options.stressWaitSelection === "paired-policy")
    stressedSaving = pairedWait.stressedCost - stressNow.cost;
  const immediateLoss = Math.max(
    0,
    summaryCost(original, false, currentPrefix, m.estimatedCacheAliveProbability) +
      (tokenModel
        ? rebuildCost(postTokens(original, retention))
        : m.estimatedFirstPostCompactReplayCost) -
      m.estimatedCurrentCallReplayCost,
  );
  const immediateLossBudget =
    options.endingRiskMode === "survival-weighted"
      ? endingBudgetRatio * Math.min(bestWaitCost, stressDefer.cost)
      : lossRatio * m.estimatedCurrentCallReplayCost;
  const stressedImmediateLoss = Math.max(
    0,
    summaryCost(original, true, currentPrefix, m.estimatedCacheAliveProbability) +
      rebuildCost(postTokens(original, stressRetention)) -
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
  // Cumulative ledger still reserves full loss; weighting only changes the per-action gate.
  const runtimeRiskAllowed = Math.max(immediateLoss, stressedImmediateLoss) <= remainingRisk;
  const assessedEndingLoss = Math.max(
    riskLoss(immediateLoss, q),
    riskLoss(stressedImmediateLoss, stressQ),
  );
  // Shared summary fees remain in both rollout bills. The timing margin uses the expense
  // exposed by advancing a request and one growth increment, not the entire shared summary.
  const savingMarginCostScale =
    options.savingMarginBasis === "timing" && waitOneAvailable
      ? m.estimatedCurrentCallReplayCost +
        (billing
          ? Math.max(
              0,
              summaryCost(
                original + growth,
                false,
                currentPrefix + growth,
                m.estimatedCacheLaterAliveProbability,
              ) -
                summaryCost(original, false, currentPrefix, m.estimatedCacheLaterAliveProbability),
            )
          : growth * summaryPerToken)
      : billing
        ? summaryCost(original, false, currentPrefix, m.estimatedCacheAliveProbability)
        : m.estimatedCompactCallCost;
  const requiredSaving = marginRatio * savingMarginCostScale;
  return {
    ...(commonContinuation ? { commonContinuation } : {}),
    ...(options.forecastPaybackGate
      ? {
          forecastPaybackBlocks: now.paybackBlocks,
          cyclePayback: cycleAllowed(original, currentPrefix, 0, true),
        }
      : {}),
    ...(options.stressWaitSelection === "paired-policy"
      ? {
          stressWaitPolicy: {
            ...pairedWait,
            independentlyOptimizedStressedCost: independentStressWaitCost,
            stressedNowCost: stressNow.cost,
          },
        }
      : {}),
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
    probabilityOfUnmodeledTail: nominalCurve?.[maxCalls] ?? q ** maxCalls,
    modeledCalls: maxCalls,
    probabilityReachForce: defer.reachForce,
    eligible,
    rolloutCandidates,
    selectedRepeatBoundaryTokens,
    assessedEndingLoss,
    continuationProbabilityNext: q,
    expectedCallsIncludingCurrent: duration?.expectedCallsIncludingCurrent ?? 1 / (1 - q),
    requiredSaving,
    savingMarginCostScale,
    forecastCooldownBlocks: now.cooldownBlocks,
    forecastReclaimBlocks: now.reclaimBlocks,
    shouldCompact:
      eligible &&
      now.available &&
      runtimeRiskAllowed &&
      (nominalCurve?.[maxCalls] ?? q ** maxCalls) <= 0.05 &&
      assessedEndingLoss <= immediateLossBudget &&
      expectedSaving > requiredSaving &&
      stressedSaving > requiredSaving,
  };
}
