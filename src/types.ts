/**
 * FoldPoint public type surface.
 *
 * FoldPoint is a decision kernel. It answers one question: should this agent session
 * compact its context right now? It answers from metadata only — token counts, timestamps,
 * cache statistics, prices and past compaction results. It never receives, stores or
 * inspects message content.
 *
 * State is split in two:
 * - **profile learning state** is shared across sessions (how well this model + compactor
 *   combination behaves);
 * - **session runtime state** belongs to one session and is discarded by `endSession`.
 */

/** The only three answers FoldPoint can give. */
export type FoldPointAction = "KEEP" | "COMPACT" | "FORCE";

/**
 * Stable, machine-readable reason codes. Hosts and plugins map these to logs or metrics;
 * they must never be parsed as natural language.
 */
export type FoldPointReason =
  /** Window pressure reached the hard window ratio. */
  | "HARD_WINDOW_RATIO"
  /** Remaining window dropped to (or below) the configured reserve. */
  | "RESERVE_TOKENS_REACHED"
  /** The host explicitly disabled economic compaction for this step. */
  | "COMPACTION_DISABLED"
  /** The host is not at a step boundary where compaction may run. */
  | "UNSAFE_BOUNDARY"
  /** Not enough model calls have passed since the last compaction attempt. */
  | "COOLDOWN_ACTIVE"
  /** Estimated reclaim is below the minimum reclaim token floor. */
  | "INSUFFICIENT_RECLAIM_TOKENS"
  /** Estimated reclaim is below the minimum reclaim ratio. */
  | "INSUFFICIENT_RECLAIM_RATIO"
  /** The cached prefix is probably still usable, so keeping the context is cheap. */
  | "CACHE_STILL_VALUABLE"
  /** The cached prefix is probably gone, so replaying the current context is expensive. */
  | "CACHE_LIKELY_EXPIRED"
  /** Adjusted net saving did not clear the configured minimum. */
  | "NO_POSITIVE_SAVING"
  /** No positive per-call saving, so compaction can never repay itself. */
  | "NO_BREAK_EVEN"
  /** Break-even exists but needs more future calls than the horizon provides. */
  | "BREAK_EVEN_BEYOND_HORIZON"
  /** Estimated benefit is not backed by enough observed samples. */
  | "LOW_CONFIDENCE"
  /** Break-even is inside the horizon and adjusted net saving is positive. */
  | "ECONOMIC_TRIGGER"
  /** Break-even calls fit inside the expected future calls. */
  | "BREAK_EVEN_WITHIN_HORIZON"
  /** Nothing else applied; the conservative default is to keep. */
  | "DEFAULT_KEEP";

/**
 * Model price snapshot. Prices are always supplied by the host (config, adapter or user);
 * FoldPoint never fetches prices and never hard-codes a vendor's numbers.
 */
export interface PricingSnapshot {
  currency?: string;

  /** Price per 1,000,000 input tokens. */
  inputPerMillion: number;
  /** Price per 1,000,000 output tokens. */
  outputPerMillion: number;

  /** Price per 1,000,000 cached input (cache read) tokens. Omit when unknown/unsupported. */
  cacheReadPerMillion?: number;
  /** Price per 1,000,000 cache write tokens. Defaults to the input price when omitted. */
  cacheWritePerMillion?: number;

  /** Audit only; never used by the core computation. */
  source?: string;
  /** Audit only; never used by the core computation. */
  effectiveAt?: number;
}

/** What the host knows about the provider-side cache. */
export interface CachePolicy {
  /** Fixed provider cache TTL, when known. */
  ttlMs?: number;
  /** Used for probabilistic decay when no TTL is known. */
  halfLifeMs?: number;
  /** The provider (or this profile) has no usable prompt cache. */
  disabled?: boolean;
}

/**
 * A model + compactor combination. Learning state is isolated per profile.
 * Suggested key: provider + model + contextWindowTokens + compactorId.
 */
export interface FoldPointProfile {
  provider?: string;
  model: string;
  contextWindowTokens: number;
  /** The compactor implementation this profile feeds; compaction quality differs per compactor. */
  compactorId: string;
  /** Optional price information. */
  pricing?: PricingSnapshot;
  /** Known provider cache behaviour. */
  cachePolicy?: CachePolicy;
}

/** One real model request, reported by the host after the call returns. */
export interface RequestObservation {
  timestamp: number;

  promptTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;

  /** Actual cost of this call, when the provider reports it. */
  actualCost?: number;

  /**
   * Exact provider cache expiry for the prefix this request just (re)built, when the host
   * can read it. Reporting `undefined` clears any previously stored expiry.
   */
  cacheExpiresAt?: number;
}

/** Everything FoldPoint needs for one decision. Metadata only. */
export interface FoldPointInput {
  /** Stable, host-owned, non-sensitive session identifier (a UUID, not message text). */
  sessionId: string;

  profile: FoldPointProfile;

  timestamp: number;

  /** Token count the next model call is expected to carry. */
  contextTokens: number;

  /** Tokens the host knows are served from the provider cache for this prompt. */
  cachedTokens?: number;

  /** Milliseconds since the last real request of *this session*. Derived from state when omitted. */
  idleMs?: number;

  /** True when the host may pause the agent here and run the compactor. */
  safeBoundary?: boolean;

  /**
   * Host estimate of how many model calls remain in this session, **including the call this
   * decision is about**: the break-even compares `C_now + (N - 1) * C_later` against the
   * compaction, so a host that counts only the later calls understates the horizon by one.
   */
  expectedFutureCalls?: number;

  /** Host opt-out from economic compaction. Window safety can still return FORCE. */
  compactionAllowed?: boolean;

  /** Exact provider cache expiry for the current prefix, when known. */
  cacheExpiresAt?: number;
}

/** The outcome of a real compaction attempt. */
export interface CompactionObservation {
  timestamp: number;

  beforeTokens: number;
  afterTokens: number;

  /** Usage of the compaction call itself. */
  promptTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;

  /** Actual cost of the compaction call, when the provider reports it. */
  actualCost?: number;

  success: boolean;
}

/** Reported when a session ends. */
export interface SessionEndObservation {
  timestamp: number;
}

/** Intermediate results behind a decision. Always returned, in every branch. */
export interface FoldPointDecisionMetrics {
  /** contextTokens / contextWindowTokens. */
  utilization: number;
  remainingTokens: number;

  estimatedPostCompactTokens: number;
  estimatedReclaimTokens: number;
  estimatedReclaimRatio: number;

  /** Fraction of the current context the cache could cover, in [0, 1]. */
  estimatedCacheCoverageRatio: number;
  /** Probability that the candidate cached prefix is still usable, in [0, 1]. */
  estimatedCacheAliveProbability: number;
  /**
   * Probability that a *later* call still finds its prefix alive. Deliberately not the same
   * value as `estimatedCacheAliveProbability`: this call's expiry is a fact, the future is a
   * forecast.
   */
  estimatedCacheLaterAliveProbability: number;
  /**
   * Tokens a *later* call could reuse from the prefix this call leaves behind. Deliberately
   * not `estimatedEffectiveCachedTokens`: a host that reports no served prefix because the
   * cache lapsed still leaves a prefix behind.
   */
  estimatedCacheLaterCandidateTokens: number;
  /** candidateCachedTokens * aliveProbability. */
  estimatedEffectiveCachedTokens: number;

  /** Cost of this call, including any prefix it has to write now. */
  estimatedCurrentCallReplayCost: number;
  /** Expected cost of a later call on the kept context. */
  estimatedLaterCallReplayCost: number;
  estimatedKeepCost: number;
  /** Cost of the compaction call itself, in the snapshot's currency. */
  estimatedCompactCallCost: number;
  /**
   * Cost of the first replay after a compaction: the compacted context is written as the new
   * prefix. Compare a post-compaction call against this, not against the current-call cost.
   */
  estimatedFirstPostCompactReplayCost: number;
  estimatedCompactCost: number;
  estimatedNetSaving: number;
  /**
   * `estimatedNetSaving * confidence - uncertaintyPenalty * estimatedCompactCallCost`.
   * This is the value compared against `minNetSaving`; it is exposed for explainability.
   */
  adjustedNetSaving: number;

  estimatedSavingPerFutureCall: number;
  /** null when there is no positive per-call saving. */
  breakEvenCalls: number | null;
  /** The host-provided or learned horizon, in future calls. */
  expectedFutureCalls: number;
  /**
   * The horizon actually used by the economic gate: `expectedFutureCalls`, capped by
   * `softWindowBreakEvenCalls` while utilization is below the soft window.
   */
  effectiveHorizonCalls: number;

  /** Calls since the last compaction attempt in this session. */
  callsSinceLastAttempt: number;
  /** Successful compaction results backing the retention estimate. */
  retentionSamples: number;
}

export interface FoldPointDecision {
  action: FoldPointAction;
  reasons: FoldPointReason[];

  /**
   * How much real evidence the estimate rests on, in [0, 1].
   * This is an evidence score, not a probability of task quality.
   */
  confidence: number;

  metrics: FoldPointDecisionMetrics;

  /**
   * Advisory token count at which the host should ask again. Only present for KEEP.
   * Always greater than the current contextTokens.
   */
  nextCheckAtTokens?: number;
}

/**
 * Cross-session learning state for one profile. JSON-serializable, content-free.
 * Everything here is scale-free: ratios and counts, never absolute amounts.
 */
export interface FoldPointProfileLearningState {
  version: 2;

  successfulCompactionCount: number;

  /** afterTokens / beforeTokens. */
  retentionRatioEma: number;
  retentionSamples: number;

  /** prompt tokens the compaction call read / beforeTokens. Cold start 1. */
  compactPromptRatioEma: number;
  compactPromptSamples: number;

  /** compaction output tokens / beforeTokens. Cold start 0.12. */
  compactOutputRatioEma: number;
  compactOutputSamples: number;

  /** cachedInputTokens / promptTokens of the compaction call. Cold start 0. */
  compactCachedInputRatioEma: number;
  compactCachedInputSamples: number;

  /** cacheWriteTokens / promptTokens of the compaction call. Cold start 0. */
  compactCacheWriteRatioEma: number;
  compactCacheWriteSamples: number;

  /**
   * actualCost / modeledCost, dimensionless. Cold start 1.
   * Never stores a currency amount.
   */
  compactCostScaleEma: number;
  compactCostScaleSamples: number;

  /** cachedInputTokens / promptTokens. Cache *coverage*, not cache survival. */
  cacheCoverageRatioEma: number;
  cacheCoverageSamples: number;

  /** Calls between a successful compaction and the end of that session. */
  reuseHorizonEma: number;
  horizonSamples: number;
}

/** Per-session runtime state. Discarded by `endSession`. Content-free. */
export interface FoldPointSessionState {
  version: 2;

  requestCount: number;

  compactionAttemptCount: number;
  successfulCompactionCount: number;
  failedCompactionCount: number;

  /** Reset by any compaction attempt, successful or not. */
  callsSinceLastAttempt: number;

  /** Used to learn the reuse horizon at session end. */
  callsSinceLastSuccessfulCompaction: number;

  lastRequestAt?: number;
  lastAttemptAt?: number;
  lastSuccessfulCompactionAt?: number;

  /** Exact expiry of the prefix the most recent request of this session built. */
  cacheExpiresAt?: number;
}

/** Whole-engine state. Keys are produced by `profileKey` and `sessionKey`. */
export interface FoldPointState {
  version: 2;
  profiles: Record<string, FoldPointProfileLearningState>;
  sessions: Record<string, FoldPointSessionState>;
}

/** All cold-start and policy parameters. Every one of them is overridable. */
export interface FoldPointDefaults {
  /** Cold-start retention ratio used before any real compaction result exists. */
  retentionRatio: number;
  /** Cold-start prompt tokens the compaction call reads / context tokens. */
  compactPromptRatio: number;
  /** Cold-start compaction output tokens / context tokens. */
  compactOutputRatio: number;
  /** Cold-start cached input share of the compaction prompt. */
  compactCachedInputRatio: number;
  /** Cold-start cache-write share of the compaction prompt. */
  compactCacheWriteRatio: number;
  /** Cold-start multiplier from modeled to actual compaction cost. */
  compactCostScale: number;
  /** Cold-start reuse horizon, in future model calls. */
  expectedFutureCalls: number;
  /** Minimum model calls between two compaction attempts. */
  minCallsBetweenCompactions: number;
  /** Minimum reclaim, in tokens, for an economic compaction to be considered. */
  minReclaimTokens: number;
  /** Minimum reclaim ratio, for an economic compaction to be considered. */
  minReclaimRatio: number;
  /** Below this utilization, the quick-payback policy guard applies. */
  softWindowRatio: number;
  /**
   * Below the soft window, break-even must fit inside this many calls.
   * A quality-oriented policy guard, not a mathematical optimum.
   */
  softWindowBreakEvenCalls: number;
  /** At or above this utilization, FoldPoint returns FORCE. */
  hardWindowRatio: number;
  /** Minimum free window that must remain; otherwise FoldPoint returns FORCE. */
  reserveTokens: number;
  /** EMA smoothing factor for every online estimate. */
  emaAlpha: number;
  /** Minimum adjusted net saving required for COMPACT. */
  minNetSaving: number;
  /** Cost-uncertainty penalty coefficient applied to the compaction call cost. */
  uncertaintyPenalty: number;
  /** Multiplier applied to `uncertaintyPenalty` below the soft window. */
  softWindowPenaltyMultiplier: number;
  /** Evidence score floor, so that a fresh profile can still act on overwhelming economics. */
  confidenceFloor: number;
  /** Sample count at which the evidence score reaches half of its remaining range. */
  confidenceHalfSaturationSamples: number;
  /** Below this cache alive probability, the cache counts as "likely expired". */
  cacheAliveThreshold: number;
  /** Below this confidence, KEEP is annotated with LOW_CONFIDENCE. */
  lowConfidenceThreshold: number;
}

/** Constructor options for the stateful engine. */
export interface FoldPointOptions {
  /** Partial overrides of the cold-start defaults. */
  defaults?: Partial<FoldPointDefaults>;
  /** State to import at construction time. */
  state?: FoldPointState;
}

/** Options for the pure decision function (no state management). */
export type FoldPointDecisionOptions = Omit<FoldPointOptions, "state">;
