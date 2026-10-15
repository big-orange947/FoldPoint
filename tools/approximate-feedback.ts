/** Research-only host-estimate tracker. Never feeds exact calibration or production policy. */
export interface ApproximateFeedback {
  /** One ordered stream of compatible model/compactor/host-estimator metadata. */
  basisKey: string;
  sequence: number;
  success: boolean;
  source: "host-immediate" | "host-delayed";
  beforeTokens: number;
  afterTokens: number;
  /** Explicit host assumptions, not error bars learned from one observation. */
  beforeErrorTokens: number;
  afterErrorTokens: number;
  /** Added context in the SAME units. Required for delayed observations. */
  growth?: { lowerTokens: number; upperTokens: number };
}

type IntervalSample = {
  point: number;
  lower: number;
  upper: number;
  before: number;
  source: ApproximateFeedback["source"];
};

const count = (n: number) => {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError("invalid approximate token count");
};

export class ApproximateRetentionTracker {
  private samples: IntervalSample[] = [];
  private mean?: number;
  private lastSequence = 0;
  private accepted = 0;

  constructor(
    private readonly basisKey: string,
    private readonly alpha = 0.25,
  ) {
    if (!/^[A-Za-z0-9._:/+#-]{1,128}$/.test(basisKey)) throw new RangeError("invalid basis key");
    if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) throw new RangeError("invalid alpha");
  }

  observe(o: ApproximateFeedback) {
    count(o.sequence);
    if (o.sequence === 0) throw new RangeError("sequence must be positive");
    for (const n of [o.beforeTokens, o.afterTokens, o.beforeErrorTokens, o.afterErrorTokens])
      count(n);
    if (o.beforeTokens === 0 || o.beforeErrorTokens >= o.beforeTokens)
      throw new RangeError("before size must stay positive under its error assumption");
    if (typeof o.success !== "boolean" || !["host-immediate", "host-delayed"].includes(o.source))
      throw new RangeError("invalid feedback provenance");
    if (o.growth) {
      count(o.growth.lowerTokens);
      count(o.growth.upperTokens);
      if (o.growth.lowerTokens > o.growth.upperTokens)
        throw new RangeError("invalid growth interval");
    }
    const upperBefore = o.beforeTokens + o.beforeErrorTokens;
    const upperAfter = o.afterTokens + o.afterErrorTokens;
    if (!Number.isSafeInteger(upperBefore) || !Number.isSafeInteger(upperAfter))
      throw new RangeError("approximate interval overflow");
    // Wrong configuration must not consume this stream's sequence or mutate its learning.
    if (o.basisKey !== this.basisKey) return "incompatible-basis" as const;
    if (o.sequence <= this.lastSequence) return "duplicate-or-out-of-order" as const;
    this.lastSequence = o.sequence;
    if (!o.success) return "failed" as const;
    if (o.source === "host-delayed" && !o.growth) return "unknown-growth" as const;
    const growth = o.growth ?? { lowerTokens: 0, upperTokens: 0 };
    if (growth.lowerTokens > upperAfter) return "inconsistent-growth" as const;
    const lower =
      Math.max(0, o.afterTokens - o.afterErrorTokens - growth.upperTokens) / upperBefore;
    const upper = (upperAfter - growth.lowerTokens) / (o.beforeTokens - o.beforeErrorTokens);
    // Keep the nominal estimate independent of how wide its uncertainty assumption is.
    const nominalGrowth = growth.lowerTokens + (growth.upperTokens - growth.lowerTokens) / 2;
    const point = Math.max(0, o.afterTokens - nominalGrowth) / o.beforeTokens;
    // Explicit heuristic: wider relative intervals influence the EMA less. Not confidence.
    const influence = 1 / (1 + (upper - lower) / Math.max(point, Number.EPSILON));
    const step = this.alpha * influence;
    this.mean = this.mean === undefined ? point : this.mean + step * (point - this.mean);
    this.samples.push({ point, lower, upper, before: o.beforeTokens, source: o.source });
    if (this.samples.length > 32) this.samples.shift();
    this.accepted++;
    return "accepted-approximate" as const;
  }

  snapshot() {
    return {
      basisKey: this.basisKey,
      acceptedApproximate: this.accepted,
      exactSamples: 0 as const,
      retainedSamples: this.samples.length,
      sources: {
        hostImmediate: this.samples.filter((s) => s.source === "host-immediate").length,
        hostDelayed: this.samples.filter((s) => s.source === "host-delayed").length,
      },
      calibratedErrorBudget: false as const,
      lastSequence: this.lastSequence,
      canDrivePolicy: false as const,
      estimate:
        this.mean === undefined
          ? null
          : {
              ratio: this.mean,
              // Include all recent input intervals plus the EMA's remaining historical influence.
              lowerRatio: Math.min(this.mean, ...this.samples.map((s) => s.lower)),
              upperRatio: Math.max(this.mean, ...this.samples.map((s) => s.upper)),
              minBefore: Math.min(...this.samples.map((s) => s.before)),
              maxBefore: Math.max(...this.samples.map((s) => s.before)),
            },
    };
  }

  predict(beforeTokens: number, beforeErrorTokens = 0) {
    count(beforeTokens);
    count(beforeErrorTokens);
    if (beforeErrorTokens > beforeTokens || !Number.isSafeInteger(beforeTokens + beforeErrorTokens))
      throw new RangeError("invalid prediction interval");
    const s = this.snapshot();
    if (!s.estimate) return null;
    return {
      pointTokens: s.estimate.ratio * beforeTokens,
      lowerTokens: s.estimate.lowerRatio * (beforeTokens - beforeErrorTokens),
      upperTokens: s.estimate.upperRatio * (beforeTokens + beforeErrorTokens),
      extrapolated:
        beforeTokens - beforeErrorTokens < s.estimate.minBefore ||
        beforeTokens + beforeErrorTokens > s.estimate.maxBefore,
      basisKey: this.basisKey,
      kind: "assumed-error-history-envelope" as const,
      calibratedConfidenceInterval: false as const,
      canDrivePolicy: false as const,
    };
  }
}
