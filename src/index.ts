/**
 * FoldPoint — a lightweight, cache-aware break-even trigger for agent context compaction.
 *
 * FoldPoint does not compact context. It decides when compaction is economically justified
 * or operationally required, from metadata only.
 */

export type { CacheSurvivalEstimate, CacheSurvivalInput, CacheSurvivalSource } from "./cache";
export {
  estimateCacheSurvival,
  resolveCacheExpiresAt,
  resolveCacheHitRatio,
  resolveIdleMs,
} from "./cache";
export { DEFAULTS, NUMERIC_BOUNDS, resolveDefaults, validateDefaults } from "./defaults";
export { FoldPoint, profileKey } from "./engine";
export { decideFoldPoint, validateFoldPointInput } from "./estimator";
export {
  applyCompactionObservation,
  applyRequestObservation,
  applySessionEnd,
  createProfileState,
  normalizeProfileState,
  validateCompactionObservation,
  validateRequestObservation,
} from "./learner";
export {
  CONFIDENCE_WEIGHTS,
  clamp,
  computeConfidence,
  emaUpdate,
  percentile,
  safeDivide,
  sampleConfidence,
} from "./math";
export type { UnitPrices } from "./pricing";
export { assertValidPricing, costOfUsage, resolveUnitPrices, tokenOnlyPricing } from "./pricing";
export { ALL_REASONS, REASON_DESCRIPTIONS } from "./reasons";
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
  FoldPointProfileState,
  FoldPointReason,
  FoldPointState,
  PricingSnapshot,
  RequestObservation,
  SessionEndObservation,
} from "./types";
