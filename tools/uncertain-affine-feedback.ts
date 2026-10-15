/** Approximate host-coordinate research model. Not a measured compactor model or policy API. */
import { type ApproximateFeedback, ApproximateRetentionTracker } from "./approximate-feedback";

type Sample = { x: number; y: number; beforeError: number; afterError: number };

export class UncertainAffineFeedback {
  private readonly gate: ApproximateRetentionTracker;
  private samples: Sample[] = [];

  constructor(
    private readonly basisKey: string,
    private readonly alpha = 0.25,
  ) {
    this.gate = new ApproximateRetentionTracker(basisKey, alpha);
  }

  observe(o: ApproximateFeedback) {
    const status = this.gate.observe(o);
    if (status !== "accepted-approximate") return status;
    const growth = o.growth ?? { lowerTokens: 0, upperTokens: 0 };
    const midpoint = growth.lowerTokens + (growth.upperTokens - growth.lowerTokens) / 2;
    this.samples.push({
      x: o.beforeTokens,
      y: Math.max(0, o.afterTokens - midpoint),
      beforeError: o.beforeErrorTokens,
      afterError: o.afterErrorTokens + (growth.upperTokens - growth.lowerTokens) / 2,
    });
    if (this.samples.length > 32) this.samples.shift();
    return status;
  }

  private solveModel() {
    // Age counts accepted observations, just as EMA controls do. No endpoint or task identity.
    const rows = this.samples
      .map((p, index) => {
        const assumedError = Math.max(1, p.afterError + (p.y / p.x) * p.beforeError);
        return {
          ...p,
          weight: (1 - this.alpha) ** (this.samples.length - index - 1) / assumedError ** 2,
        };
      })
      .filter((p) => p.weight > 0);
    if (rows.length < 3) return null;
    const minX = Math.min(...rows.map((p) => p.x));
    const maxX = Math.max(...rows.map((p) => p.x));
    if (maxX - minX < 0.2 * maxX) return null;
    // Scale x and normalize weights for numerical stability; minimize weighted nominal residuals.
    const maxWeight = Math.max(...rows.map((p) => p.weight));
    const points = rows.map((p) => ({ ...p, weight: p.weight / maxWeight, z: p.x / maxX }));
    const total = points.reduce((s, p) => s + p.weight, 0);
    const x = points.reduce((s, p) => s + p.weight * p.z, 0) / total;
    const y = points.reduce((s, p) => s + p.weight * p.y, 0) / total;
    const xx = points.reduce((s, p) => s + p.weight * (p.z - x) ** 2, 0);
    const xy = points.reduce((s, p) => s + p.weight * (p.z - x) * (p.y - y), 0);
    const slope = xx > 0 ? xy / xx : 0;
    const candidates = [
      { slope: 0, floor: y },
      {
        slope:
          points.reduce((s, p) => s + p.weight * p.z * p.y, 0) /
          points.reduce((s, p) => s + p.weight * p.z ** 2, 0),
        floor: 0,
      },
      ...(slope >= 0 && y - slope * x >= 0 ? [{ slope, floor: y - slope * x }] : []),
    ];
    const loss = (c: (typeof candidates)[number]) =>
      points.reduce((s, p) => s + p.weight * (p.y - c.slope * p.z - c.floor) ** 2, 0);
    const best = candidates.reduce((a, b) => (loss(a) <= loss(b) ? a : b));
    const model = { slope: best.slope / maxX, floor: best.floor };
    const envelope = Math.max(
      ...rows.map(
        (p) =>
          Math.abs(p.y - model.slope * p.x - model.floor) +
          p.afterError +
          model.slope * p.beforeError,
      ),
    );
    return { ...model, envelope, minBefore: minX, maxBefore: maxX };
  }

  snapshot() {
    return {
      ...this.gate.snapshot(),
      model: this.solveModel(),
      modelKind: "uncertain-nonnegative-affine" as const,
    };
  }

  predict(beforeTokens: number, beforeErrorTokens = 0) {
    // Validate input and obtain a provenance-preserving fallback interval, without using its EMA point.
    const fallback = this.gate.predict(beforeTokens, beforeErrorTokens);
    if (!fallback) return null;
    const model = this.solveModel();
    if (!model) {
      const last = this.samples.at(-1);
      if (!last) throw new Error("missing compatible sample");
      return {
        ...fallback,
        pointTokens: (beforeTokens * last.y) / last.x,
        source: "last-observation-fallback" as const,
      };
    }
    const point = model.floor + model.slope * beforeTokens;
    const width = model.envelope + model.slope * beforeErrorTokens;
    return {
      pointTokens: point,
      lowerTokens: Math.max(0, point - width),
      upperTokens: point + width,
      extrapolated:
        beforeTokens - beforeErrorTokens < model.minBefore ||
        beforeTokens + beforeErrorTokens > model.maxBefore,
      basisKey: this.basisKey,
      kind: "assumed-error-residual-envelope" as const,
      calibratedConfidenceInterval: false as const,
      canDrivePolicy: false as const,
      source: "weighted-affine" as const,
    };
  }
}
