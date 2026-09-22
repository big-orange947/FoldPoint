import type { FoldPointDefaults, FoldPointProfileState } from "./types";

/** Clamps `value` into `[min, max]`. NaN collapses to `min`. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

/** Division that never returns NaN or Infinity: falls back when the denominator is unusable. */
export function safeDivide(numerator: number, denominator: number, fallback: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return fallback;
  }
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : fallback;
}

/** One EMA step: `alpha * observation + (1 - alpha) * previous`. */
export function emaUpdate(previous: number, observation: number, alpha: number): number {
  const a = clamp(alpha, 0, 1);
  const result = a * observation + (1 - a) * previous;
  return Number.isFinite(result) ? result : previous;
}

/**
 * Structural weights of the evidence score. Retention dominates because it is the
 * dominant unknown in the cost model.
 */
export const CONFIDENCE_WEIGHTS = Object.freeze({
  retention: 0.5,
  cache: 0.25,
  horizon: 0.25,
});

/** Saturating evidence curve: 0 samples -> 0, `halfSaturation` samples -> 0.5, large -> ~1. */
export function sampleConfidence(samples: number, halfSaturation: number): number {
  const n = Number.isFinite(samples) && samples > 0 ? samples : 0;
  if (!Number.isFinite(halfSaturation) || halfSaturation <= 0) {
    return n > 0 ? 1 : 0;
  }
  return n / (n + halfSaturation);
}

/**
 * Evidence score in [0, 1]: how much of the estimate rests on observed samples.
 * It starts at `confidenceFloor` (never zero, so overwhelming economics can still act)
 * and approaches 1 as retention, cache and horizon samples accumulate.
 */
export function computeConfidence(
  state: Pick<FoldPointProfileState, "retentionSamples" | "cacheSamples" | "horizonSamples">,
  defaults: FoldPointDefaults,
): number {
  const halfSaturation = defaults.confidenceHalfSaturationSamples;
  const evidence =
    CONFIDENCE_WEIGHTS.retention * sampleConfidence(state.retentionSamples, halfSaturation) +
    CONFIDENCE_WEIGHTS.cache * sampleConfidence(state.cacheSamples, halfSaturation) +
    CONFIDENCE_WEIGHTS.horizon * sampleConfidence(state.horizonSamples, halfSaturation);

  return clamp(defaults.confidenceFloor + (1 - defaults.confidenceFloor) * evidence, 0, 1);
}

/** Linear-interpolation percentile over an unsorted sample array. Does not mutate the input. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = clamp(p, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  if (lower === upper) {
    return lowerValue;
  }
  return lowerValue + (upperValue - lowerValue) * (rank - lower);
}
