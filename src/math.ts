import type { FoldPointDefaults } from "./types";

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
 * Structural weights of the evidence score. Retention dominates because it is the dominant
 * unknown in the cost model; compaction usage, cache coverage and the horizon each
 * contribute a fifth. The weights sum to 1.
 */
export const CONFIDENCE_WEIGHTS = Object.freeze({
  retention: 0.4,
  compactionUsage: 0.2,
  cacheCoverage: 0.2,
  horizon: 0.2,
});

/** Every sample source that feeds the evidence score. */
export interface ConfidenceSampleCounts {
  retentionSamples: number;
  /** Compaction calls that reported usage data (prompt, output, cache or cost scale). */
  compactionUsageSamples: number;
  cacheCoverageSamples: number;
  horizonSamples: number;
}

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
 *
 * It starts at `confidenceFloor` (never zero, so overwhelming economics can still act on a
 * fresh profile), is monotone non-decreasing in every sample count, approaches 1 as samples
 * accumulate, and never affects the window-safety FORCE.
 */
export function computeConfidence(
  samples: ConfidenceSampleCounts,
  defaults: FoldPointDefaults,
): number {
  const halfSaturation = defaults.confidenceHalfSaturationSamples;
  const evidence =
    CONFIDENCE_WEIGHTS.retention * sampleConfidence(samples.retentionSamples, halfSaturation) +
    CONFIDENCE_WEIGHTS.compactionUsage *
      sampleConfidence(samples.compactionUsageSamples, halfSaturation) +
    CONFIDENCE_WEIGHTS.cacheCoverage *
      sampleConfidence(samples.cacheCoverageSamples, halfSaturation) +
    CONFIDENCE_WEIGHTS.horizon * sampleConfidence(samples.horizonSamples, halfSaturation);

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
