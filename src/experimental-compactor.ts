/** Bounded metadata-only research learner. Create separately for each compatible compactor. */
export interface CompactorTokenModel {
  after: { slope: number; intercept: number; residual: number };
  output: { slope: number; intercept: number; residual: number };
  samples: number;
  minBefore: number;
  maxBefore: number;
  summaryInputCostPerToken: number;
}

export type CompactorTokenObservation = {
  beforeTokens: number;
  afterTokens: number;
  outputTokens: number;
  summaryInputCostPerToken: number;
};

export type CompactorModelAvailability = {
  source: "fitted" | "retained" | "unavailable";
  reason:
    | "identifiable"
    | "low-span-consistent"
    | "not-learned"
    | "feedback-drift"
    | "summary-price-change";
  observationsSinceFit: number;
  model?: CompactorTokenModel;
};

const copyModel = (m: CompactorTokenModel): CompactorTokenModel => ({
  ...m,
  after: { ...m.after },
  output: { ...m.output },
});

/** Nonnegative affine least squares; compare interior and both boundary solutions. */
function fitAffine(
  points: readonly CompactorTokenObservation[],
  pick: (p: CompactorTokenObservation) => number,
) {
  const n = points.length;
  const x = points.reduce((s, p) => s + p.beforeTokens, 0) / n;
  const y = points.reduce((s, p) => s + pick(p), 0) / n;
  const xx = points.reduce((s, p) => s + (p.beforeTokens - x) ** 2, 0);
  const xy = points.reduce((s, p) => s + (p.beforeTokens - x) * (pick(p) - y), 0);
  const slope = xx > 0 ? xy / xx : 0;
  const candidates = [
    { slope: 0, intercept: y },
    {
      slope:
        points.reduce((s, p) => s + p.beforeTokens * pick(p), 0) /
        points.reduce((s, p) => s + p.beforeTokens ** 2, 0),
      intercept: 0,
    },
    ...(slope >= 0 && y - slope * x >= 0 ? [{ slope, intercept: y - slope * x }] : []),
  ];
  const error = (c: { slope: number; intercept: number }) =>
    points.reduce((s, p) => s + (pick(p) - c.slope * p.beforeTokens - c.intercept) ** 2, 0);
  const best = candidates.reduce((a, b) => (error(a) <= error(b) ? a : b));
  return {
    ...best,
    residual: Math.max(
      ...points.map((p) => Math.abs(pick(p) - best.slope * p.beforeTokens - best.intercept)),
    ),
  };
}

export class ExperimentalCompactorLearner {
  private points: CompactorTokenObservation[] = [];
  private lastIdentifiable?: CompactorTokenModel;
  private fittedPriceRange?: { min: number; max: number };
  private observationsSinceFit = 0;
  private unavailableReason: CompactorModelAvailability["reason"] = "not-learned";

  /** Host owns compatibility and storage. Copy bounded prior observations, never task truth. */
  constructor(history: readonly CompactorTokenObservation[] = []) {
    if (history.length > 32) throw new RangeError("compactor history exceeds 32 observations");
    for (const observation of history) this.observe(observation);
  }

  exportObservations(): CompactorTokenObservation[] {
    return this.points.map((p) => ({ ...p }));
  }

  observe(observation: CompactorTokenObservation): void {
    for (const v of [observation.beforeTokens, observation.afterTokens, observation.outputTokens])
      if (!Number.isSafeInteger(v) || v < 0)
        throw new RangeError("invalid compactor token observation");
    if (observation.beforeTokens === 0 || observation.afterTokens > observation.beforeTokens)
      throw new RangeError("invalid compactor token observation");
    if (
      !Number.isFinite(observation.summaryInputCostPerToken) ||
      observation.summaryInputCostPerToken < 0
    )
      throw new RangeError("invalid summary input price");
    this.points.push({
      beforeTokens: observation.beforeTokens,
      afterTokens: observation.afterTokens,
      outputTokens: observation.outputTokens,
      summaryInputCostPerToken: observation.summaryInputCostPerToken,
    });
    if (this.points.length > 32) this.points.shift();
    const fit = this.snapshot();
    if (fit) {
      this.lastIdentifiable = copyModel(fit);
      this.fittedPriceRange = {
        min: Math.min(...this.points.map((p) => p.summaryInputCostPerToken)),
        max: Math.max(...this.points.map((p) => p.summaryInputCostPerToken)),
      };
      this.observationsSinceFit = 0;
    } else {
      this.observationsSinceFit++;
      const incompatibility = this.retentionIncompatibility();
      if (incompatibility) {
        this.lastIdentifiable = undefined;
        this.fittedPriceRange = undefined;
        this.unavailableReason = incompatibility;
      }
    }
  }

  private retentionIncompatibility(): "feedback-drift" | "summary-price-change" | undefined {
    const model = this.lastIdentifiable;
    const prices = this.fittedPriceRange;
    if (!model || !prices) return undefined;
    for (const p of this.points) {
      const epsilon = 1e-10 * Math.max(prices.max, p.summaryInputCostPerToken, Number.MIN_VALUE);
      if (
        p.summaryInputCostPerToken < prices.min - epsilon ||
        p.summaryInputCostPerToken > prices.max + epsilon
      )
        return "summary-price-change";
      for (const key of ["after", "output"] as const) {
        const c = model[key];
        const predicted = c.slope * p.beforeTokens + c.intercept;
        const observed = key === "after" ? p.afterTokens : p.outputTokens;
        // Quantization + observed residual + explicit 5% drift tolerance. Not a confidence interval.
        if (Math.abs(observed - predicted) > Math.max(1, c.residual) + 0.05 * predicted)
          return "feedback-drift";
      }
    }
    return undefined;
  }

  /** Explicit recovery; snapshot() remains the strict current-window fit.
   * Host must create a new learner when model/compactor compatibility changes.
   * Retention validates recent observed inputs only, not extrapolation or task quality.
   */
  snapshotWithFallback(): CompactorModelAvailability {
    const current = this.snapshot();
    if (current)
      return { source: "fitted", reason: "identifiable", observationsSinceFit: 0, model: current };
    if (this.lastIdentifiable)
      return {
        source: "retained",
        reason: "low-span-consistent",
        observationsSinceFit: this.observationsSinceFit,
        model: copyModel(this.lastIdentifiable),
      };
    return {
      source: "unavailable",
      reason: this.unavailableReason,
      observationsSinceFit: this.observationsSinceFit,
    };
  }

  snapshot(): CompactorTokenModel | undefined {
    const points = this.points;
    if (points.length < 3) return undefined;
    const minBefore = Math.min(...points.map((p) => p.beforeTokens));
    const maxBefore = Math.max(...points.map((p) => p.beforeTokens));
    // Repeated identical inputs cannot identify a fixed term versus a ratio.
    if (maxBefore - minBefore < 0.2 * maxBefore) return undefined;
    return {
      after: fitAffine(points, (p) => p.afterTokens),
      output: fitAffine(points, (p) => p.outputTokens),
      samples: points.length,
      minBefore,
      maxBefore,
      summaryInputCostPerToken:
        points.reduce((s, p) => s + p.summaryInputCostPerToken, 0) / points.length,
    };
  }
}

/** Residual envelope is a stress heuristic, not a statistical confidence interval. */
export function predictCompactorTokens(
  model: CompactorTokenModel,
  before: number,
  stressed = false,
) {
  if (!Number.isFinite(before) || before < 0) throw new RangeError("invalid prediction size");
  const predict = (c: CompactorTokenModel["after"]) =>
    c.slope * before + c.intercept + (stressed ? c.residual : 0);
  return {
    afterTokens: Math.min(before, predict(model.after)),
    outputTokens: predict(model.output),
  };
}
