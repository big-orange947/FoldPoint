/**
 * FoldPoint — a lightweight, cache-aware break-even trigger for agent context compaction.
 *
 * FoldPoint does not compact context. It decides when compaction is economically justified
 * or operationally required, from metadata only.
 */

export type { CacheAliveSource, CacheModel, CacheModelInput } from "./cache";
export {
  estimateCacheModel,
  isCachingInPlay,
  resolveCacheCoverageRatio,
  resolveCacheExpiresAt,
  resolveIdleMs,
  resolveLaterAliveProbability,
  resolveLaterCandidateTokens,
} from "./cache";
export {
  DEFAULTS,
  isResolvedDefaults,
  NUMERIC_BOUNDS,
  resolveDefaults,
  validateDefaults,
} from "./defaults";
export { FoldPoint, profileKey, sessionKey } from "./engine";
export type { BreakEvenInput } from "./estimator";
export { computeBreakEvenCalls, decideFoldPoint, validateFoldPointInput } from "./estimator";
export type { StateUpdate } from "./learner";
export {
  applyCompactionObservation,
  applyRequestObservation,
  applySessionEnd,
  createProfileLearningState,
  createSessionState,
  normalizeProfileLearningState,
  normalizeSessionState,
  validateCompactionObservation,
  validateRequestObservation,
} from "./learner";
export type { ConfidenceSampleCounts } from "./math";
export {
  CONFIDENCE_WEIGHTS,
  clamp,
  computeConfidence,
  emaUpdate,
  percentile,
  safeDivide,
  sampleConfidence,
} from "./math";
export type { CallCacheState, UnitPrices } from "./pricing";
export {
  assertValidPricing,
  costOfCall,
  costOfUsage,
  isTokenOnlyPricing,
  resolveUnitPrices,
  tokenOnlyPricing,
} from "./pricing";
export { ALL_REASONS, REASON_DESCRIPTIONS } from "./reasons";
export type {
  TraceCacheWarmEvent,
  TraceCompactionEvent,
  TraceDecisionEvent,
  TraceEvent,
  TraceEventType,
  TraceHeaderEvent,
  TraceInput,
  TraceOutcome,
  TraceParseResult,
  TracePrediction,
  TraceProfile,
  TraceRecorderOptions,
  TraceRequestEvent,
  TraceSessionEndEvent,
} from "./trace";
export {
  isTraceEvent,
  parseTraceJsonl,
  TRACE_FORMAT_VERSION,
  TraceRecorder,
  validateTraceEvent,
} from "./trace";
export type {
  CachePolicy,
  CompactionObservation,
  FoldPointAction,
  FoldPointDecision,
  FoldPointDecisionMetrics,
  FoldPointDecisionOptions,
  FoldPointDefaults,
  FoldPointInput,
  FoldPointOptions,
  FoldPointProfile,
  FoldPointProfileLearningState,
  FoldPointReason,
  FoldPointSessionState,
  FoldPointState,
  PricingSnapshot,
  RequestObservation,
  SessionEndObservation,
} from "./types";
export { FOLDPOINT_VERSION } from "./version";
