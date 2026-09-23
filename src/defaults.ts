import type { FoldPointDefaults } from "./types";

/**
 * Cold-start defaults.
 *
 * These numbers are generic starting points, not tuned optima. They are deliberately
 * conservative: with no real evidence FoldPoint should prefer KEEP, except for the
 * window-safety trigger, which is never weakened by uncertainty.
 *
 * Every value is overridable through `FoldPointOptions.defaults`.
 */
export const DEFAULTS: Readonly<FoldPointDefaults> = Object.freeze({
  retentionRatio: 0.4,

  // Compaction call usage ratios, relative to the context being compacted.
  compactPromptRatio: 1,
  compactOutputRatio: 0.12,
  compactCachedInputRatio: 0,
  compactCacheWriteRatio: 0,
  compactCostScale: 1,

  expectedFutureCalls: 3,

  minCallsBetweenCompactions: 3,

  minReclaimTokens: 4096,
  minReclaimRatio: 0.2,

  softWindowRatio: 0.65,
  softWindowBreakEvenCalls: 3,
  hardWindowRatio: 0.9,

  reserveTokens: 8192,

  emaAlpha: 0.25,

  minNetSaving: 0,

  uncertaintyPenalty: 0.15,
  softWindowPenaltyMultiplier: 2,

  confidenceFloor: 0.35,
  confidenceHalfSaturationSamples: 2,

  cacheAliveThreshold: 0.5,
  lowConfidenceThreshold: 0.5,
});

/**
 * Numerical safety bounds. These clamp degenerate estimates so that the formulas stay
 * finite and monotone. They are numerical guards, not scenario switches.
 */
export const NUMERIC_BOUNDS = Object.freeze({
  /** A compaction that reclaims less than 5% of the context is treated as reclaiming 5%. */
  retentionRatioMin: 0.05,
  retentionRatioMax: 1,
  /** A compaction call that reads more than twice the context is treated as reading twice. */
  compactPromptRatioMax: 2,
  /** Upper bound for the learned compaction output ratio. */
  compactOutputRatioMax: 1,
  /** Learned actualCost / modeledCost is clamped to this range. */
  compactCostScaleMin: 0.1,
  compactCostScaleMax: 10,
});

const RATIO_KEYS = [
  "retentionRatio",
  "compactOutputRatio",
  "compactCachedInputRatio",
  "compactCacheWriteRatio",
  "minReclaimRatio",
  "softWindowRatio",
  "hardWindowRatio",
  "confidenceFloor",
  "cacheAliveThreshold",
  "lowConfidenceThreshold",
] as const;

const NON_NEGATIVE_KEYS = [
  "compactPromptRatio",
  "compactCostScale",
  "minCallsBetweenCompactions",
  "minReclaimTokens",
  "reserveTokens",
  "minNetSaving",
  "uncertaintyPenalty",
] as const;

function assertFiniteNumber(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(
      `FoldPoint default "${name}" must be a finite number, received ${String(value)}`,
    );
  }
}

function assertRatio(name: string, value: unknown): void {
  assertFiniteNumber(name, value);
  if (value < 0 || value > 1) {
    throw new RangeError(`FoldPoint default "${name}" must be within [0, 1], received ${value}`);
  }
}

function assertNonNegative(name: string, value: unknown): void {
  assertFiniteNumber(name, value);
  if (value < 0) {
    throw new RangeError(`FoldPoint default "${name}" must be >= 0, received ${value}`);
  }
}

/** Validates a resolved default set. Throws `RangeError` on impossible configurations. */
export function validateDefaults(defaults: FoldPointDefaults): void {
  for (const key of RATIO_KEYS) {
    assertRatio(key, defaults[key]);
  }
  for (const key of NON_NEGATIVE_KEYS) {
    assertNonNegative(key, defaults[key]);
  }

  assertFiniteNumber("compactPromptRatio", defaults.compactPromptRatio);
  if (defaults.compactPromptRatio > NUMERIC_BOUNDS.compactPromptRatioMax) {
    throw new RangeError(
      `FoldPoint default "compactPromptRatio" must be <= ${NUMERIC_BOUNDS.compactPromptRatioMax}, received ${defaults.compactPromptRatio}`,
    );
  }

  assertFiniteNumber("compactCostScale", defaults.compactCostScale);
  if (
    defaults.compactCostScale < NUMERIC_BOUNDS.compactCostScaleMin ||
    defaults.compactCostScale > NUMERIC_BOUNDS.compactCostScaleMax
  ) {
    throw new RangeError(
      `FoldPoint default "compactCostScale" must be within [${NUMERIC_BOUNDS.compactCostScaleMin}, ${NUMERIC_BOUNDS.compactCostScaleMax}], received ${defaults.compactCostScale}`,
    );
  }

  assertFiniteNumber("emaAlpha", defaults.emaAlpha);
  if (defaults.emaAlpha <= 0 || defaults.emaAlpha > 1) {
    throw new RangeError(
      `FoldPoint default "emaAlpha" must be within (0, 1], received ${defaults.emaAlpha}`,
    );
  }

  assertFiniteNumber("expectedFutureCalls", defaults.expectedFutureCalls);
  if (defaults.expectedFutureCalls < 1) {
    throw new RangeError(
      `FoldPoint default "expectedFutureCalls" must be >= 1, received ${defaults.expectedFutureCalls}`,
    );
  }

  assertFiniteNumber("softWindowBreakEvenCalls", defaults.softWindowBreakEvenCalls);
  if (defaults.softWindowBreakEvenCalls < 1) {
    throw new RangeError(
      `FoldPoint default "softWindowBreakEvenCalls" must be >= 1, received ${defaults.softWindowBreakEvenCalls}`,
    );
  }

  assertFiniteNumber("confidenceHalfSaturationSamples", defaults.confidenceHalfSaturationSamples);
  if (defaults.confidenceHalfSaturationSamples <= 0) {
    throw new RangeError(
      `FoldPoint default "confidenceHalfSaturationSamples" must be > 0, received ${defaults.confidenceHalfSaturationSamples}`,
    );
  }

  assertFiniteNumber("softWindowPenaltyMultiplier", defaults.softWindowPenaltyMultiplier);
  if (defaults.softWindowPenaltyMultiplier < 1) {
    throw new RangeError(
      `FoldPoint default "softWindowPenaltyMultiplier" must be >= 1, received ${defaults.softWindowPenaltyMultiplier}`,
    );
  }

  if (defaults.retentionRatio <= 0) {
    throw new RangeError(
      `FoldPoint default "retentionRatio" must be > 0, received ${defaults.retentionRatio}`,
    );
  }

  if (defaults.hardWindowRatio <= defaults.softWindowRatio) {
    throw new RangeError(
      `FoldPoint default "hardWindowRatio" (${defaults.hardWindowRatio}) must be greater than "softWindowRatio" (${defaults.softWindowRatio})`,
    );
  }
}

/** Marker for a default set that already passed {@link validateDefaults}. */
const RESOLVED_DEFAULTS = Symbol.for("foldpoint.resolvedDefaults");

let cachedDefaultSet: FoldPointDefaults | undefined;

/**
 * True when the value is a default set produced by {@link resolveDefaults}.
 * Lets the hot decision path reuse an already validated set instead of rebuilding it.
 */
export function isResolvedDefaults(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  return (value as unknown as Record<PropertyKey, unknown>)[RESOLVED_DEFAULTS] === true;
}

/**
 * Merges host overrides over `DEFAULTS` and validates the result.
 *
 * The resolved set is frozen: it is shared with the decision path, which must never be able
 * to mutate it. The no-override case is memoized, so calling `decideFoldPoint` without
 * options costs nothing extra.
 */
export function resolveDefaults(overrides?: Partial<FoldPointDefaults>): FoldPointDefaults {
  if (overrides === undefined && cachedDefaultSet !== undefined) {
    return cachedDefaultSet;
  }

  const merged: FoldPointDefaults = { ...DEFAULTS };

  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        continue;
      }
      if (!(key in DEFAULTS)) {
        throw new RangeError(`Unknown FoldPoint default "${key}"`);
      }
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }

  validateDefaults(merged);
  Object.defineProperty(merged, RESOLVED_DEFAULTS, {
    value: true,
    enumerable: false,
    writable: false,
  });
  Object.freeze(merged);

  if (overrides === undefined) {
    cachedDefaultSet = merged;
  }
  return merged;
}
