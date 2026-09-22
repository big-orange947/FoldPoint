/**
 * FoldPoint public type surface.
 *
 * FoldPoint is a decision kernel. It answers one question: should this agent session
 * compact its context right now? It answers from metadata only — token counts,
 * timestamps, cache statistics, prices and past compaction results. It never receives,
 * stores or inspects message content.
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
  /** Not enough model calls have passed since the last compaction. */
  | "COOLDOWN_ACTIVE"
  /** Estimated reclaim is below the minimum reclaim token floor. */
  | "INSUFFICIENT_RECLAIM_TOKENS"
  /** Estimated reclaim is below the minimum reclaim ratio. */
  | "INSUFFICIENT_RECLAIM_RATIO"
  /** Cached prefix is (probably) still alive, so keeping the context is cheap. */
  | "CACHE_STILL_VALUABLE"
  /** Cached prefix is (probably) gone, so replaying the current context is expensive. */
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
 * A model + compactor combination. State is isolated per profile.
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

  /** Exact provider cache expiry, when the host can read it. */
  cacheExpiresAt?: number;
}

/** Everything FoldPoint needs for one decision. Metadata only. */
export interface FoldPointInput {
  profile: FoldPointProfile;

  timestamp: number;

  /** Token count the next model call is expected to carry. */
  contextTokens: number;

  /** Tokens already known to sit in the cached prefix. */
  cachedTokens?: number;

  /** Milliseconds since the last real request. Derived from state when omitted. */
  idleMs?: number;

  /** True when the host may pause the agent here and run the compactor. */
  safeBoundary?: boolean;

  /** Host estimate of how many model calls remain in this session. */
  expectedFutureCalls?: number;

  /** Host opt-out from economic compaction. Window safety can still return FORCE. */
  compactionAllowed?: boolean;

  /** Exact provider cache expiry for the current context, when known. */
  cacheExpiresAt?: number;
}

/** The outcome of a real compaction call. */
export interface CompactionObservation {
  timestamp: number;

  beforeTokens: number;
  afterTokens: number;

  /** Usage of the compaction call itself. */
  promptTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;

  /** Actual cost of the compaction call, when the provider reports it. */
  actualCost?: number;

  success: boolean;
}

/** Reported when a session ends, so FoldPoint can learn the real reuse horizon. */
export interface SessionEndObservation {
  timestamp: number;
  /**
   * Model calls performed between the most recent compaction and the end of the session.
   * Defaults to the profile's own `callsSinceLastCompaction` counter.
   */
  callsSinceLastCompaction?: number;
}

/** Intermediate results behind a decision. Always returned, in every branch. */
export interface FoldPointDecisionMetrics {
  /** contextTokens / contextWindowTokens. */
  utilization: number;
  remainingTokens: number;

  estimatedPostCompactTokens: number;
  estimatedReclaimTokens: number;
  estimatedReclaimRatio: number;

  /** Effective cache survival used in the cost model, in [0, 1]. */
  estimatedCacheSurvival: number;

  estimatedKeepCost: number;
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
   * `softWindowBreakEvenCalls` while utilization is below the soft window, and capped by
   * the estimated time the context needs to regrow to its pre-compaction size.
   */
  effectiveHorizonCalls: number;
  /**
   * Calls needed for the context to regrow by the estimated reclaim, at the learned growth
   * rate. null when the growth rate is unknown or zero.
   */
  callsUntilRefill: number | null;

  callsSinceLastCompaction: number;
  /** Successful compaction results backing the retention estimate. */
  compactionSamples: number;
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

/** Per-profile online state. JSON-serializable, no content, no secrets. */
export interface FoldPointProfileState {
  version: 1;

  requestCount: number;
  compactionCount: number;
  successfulCompactionCount: number;

  lastRequestAt?: number;
  lastCompactionAt?: number;
  /** Exact cache expiry of the most recent observed request, when reported. */
  lastCacheExpiresAt?: number;
  callsSinceLastCompaction: number;

  /** afterTokens / beforeTokens. */
  retentionRatioEma: number;
  /** compaction output tokens / beforeTokens. */
  compactOutputRatioEma: number;
  /** Cost of one compaction call; currency when real prices exist, else normalized tokens. */
  compactionCostEma?: number;
  /** cachedInputTokens / promptTokens. */
  cacheHitRatioEma: number;
  /** Conservative estimate of how many more calls a session makes. */
  reuseHorizonEma: number;
  /** Average tokens the context grows by between two consecutive model calls. */
  growthPerCallEma: number;
  /** Prompt size of the last observed request; used only to learn the growth rate. */
  lastPromptTokens?: number;

  retentionSamples: number;
  compactionCostSamples: number;
  cacheSamples: number;
  horizonSamples: number;
  growthSamples: number;
}

/** Whole-engine state. Profile keys are produced by `profileKey`. */
export interface FoldPointState {
  version: 1;
  profiles: Record<string, FoldPointProfileState>;
}

/** All cold-start and policy parameters. Every one of them is overridable. */
export interface FoldPointDefaults {
  /** Cold-start retention ratio used before any real compaction result exists. */
  retentionRatio: number;
  /** Cold-start compaction output tokens / context tokens. */
  compactOutputRatio: number;
  /** Cold-start reuse horizon, in future model calls. */
  expectedFutureCalls: number;
  /** Minimum model calls between two compactions. */
  minCallsBetweenCompactions: number;
  /** Minimum reclaim, in tokens, for an economic compaction to be considered. */
  minReclaimTokens: number;
  /** Minimum reclaim ratio, for an economic compaction to be considered. */
  minReclaimRatio: number;
  /** Below this utilization, the uncertainty penalty is multiplied. */
  softWindowRatio: number;
  /**
   * Below the soft window, compaction must repay itself inside this many calls.
   * This is the "quick payback" requirement: when the window is not scarce, only a
   * fast break-even justifies compacting a small context.
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
  /** Below this effective cache survival, the cache counts as "likely expired". */
  cacheValuableThreshold: number;
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
