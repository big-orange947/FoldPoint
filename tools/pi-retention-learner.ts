/** Immediate host-coordinate learning only. No billing, network, or live policy changes. */
import { createHash } from "node:crypto";
import { predictRetainedFloor, type RetainedFloor } from "./retained-floor";
import { UncertainAffineFeedback } from "./uncertain-affine-feedback";

export interface RetentionBinding {
  profileBinding: string;
  compactorBinding: string;
  estimatorId: string;
}
export interface RetentionAssumptions {
  beforeErrorTokens: number;
  afterErrorTokens: number;
  /** Explicit drift heuristic, not a calibrated confidence threshold. */
  driftToleranceRatio: number;
}
const count = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const object = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

export class PiImmediateRetentionLearner {
  private readonly binding: RetentionBinding;
  private readonly assumptions: RetentionAssumptions;
  private readonly basis: string;
  private tracker: UncertainAffineFeedback;
  private lastSequence = 0;
  private accepted = 0;
  private driftResets = 0;

  constructor(binding: RetentionBinding, assumptions: RetentionAssumptions) {
    if (
      ![binding.profileBinding, binding.compactorBinding].every((s) => /^[a-f0-9]{64}$/.test(s)) ||
      !/^[A-Za-z0-9._:/+#-]{1,64}$/.test(binding.estimatorId)
    )
      throw new RangeError("invalid retention binding");
    if (
      !count(assumptions.beforeErrorTokens) ||
      !count(assumptions.afterErrorTokens) ||
      !Number.isFinite(assumptions.driftToleranceRatio) ||
      assumptions.driftToleranceRatio < 0 ||
      assumptions.driftToleranceRatio > 1
    )
      throw new RangeError("invalid retention assumptions");
    this.binding = {
      profileBinding: binding.profileBinding,
      compactorBinding: binding.compactorBinding,
      estimatorId: binding.estimatorId,
    };
    this.assumptions = {
      beforeErrorTokens: assumptions.beforeErrorTokens,
      afterErrorTokens: assumptions.afterErrorTokens,
      driftToleranceRatio: assumptions.driftToleranceRatio,
    };
    this.basis = createHash("sha256")
      .update(JSON.stringify([this.binding, this.assumptions]))
      .digest("hex");
    this.tracker = new UncertainAffineFeedback(this.basis);
  }

  snapshot() {
    const state = this.tracker.snapshot();
    return {
      basis: this.basis,
      accepted: this.accepted,
      lastSequence: this.lastSequence,
      driftResets: this.driftResets,
      retainedSamples: state.retainedSamples,
      identifiable: state.model !== null,
      model: state.model,
      minBefore: state.estimate?.minBefore ?? null,
      maxBefore: state.estimate?.maxBefore ?? null,
      hostEstimateOnly: true,
      calibratedConfidenceInterval: false,
      canDrivePolicy: false,
    };
  }

  /** Call BEFORE observe() to score a new observation. Never trains on the target. */
  predict(
    beforeTokens: number,
    prior: RetainedFloor = { totalRatio: 0.1, recentBudgetTokens: 20000 },
  ) {
    if (!count(beforeTokens) || beforeTokens === 0) throw new RangeError("invalid prediction size");
    const state = this.snapshot();
    // Validate an explicitly supplied prior even when a fitted model is available.
    const priorPoint = predictRetainedFloor(prior, beforeTokens);
    if (state.accepted === 0)
      return { status: "prior-only" as const, pointTokens: priorPoint, state };
    const prediction = this.tracker.predict(beforeTokens, this.assumptions.beforeErrorTokens);
    if (!prediction) throw new Error("missing accepted retention state");
    if (prediction.extrapolated)
      return { status: "outside-observed-range" as const, pointTokens: null, state };
    return {
      status: state.identifiable
        ? ("fitted-host-model" as const)
        : ("local-low-span-fallback" as const),
      pointTokens: Math.min(beforeTokens, Math.max(0, prediction.pointTokens)),
      state,
    };
  }

  observe(sample: unknown) {
    const s = object(sample);
    if (s?.v !== 1 || s.source !== "pi-compaction-result-estimatedTokensAfter")
      return "not-immediate-feedback" as const;
    if (
      s.binding !== this.binding.profileBinding ||
      s.compactorBinding !== this.binding.compactorBinding
    )
      return "incompatible-binding" as const;
    if (
      !count(s.sequence) ||
      s.sequence === 0 ||
      !count(s.beforeTokens) ||
      s.beforeTokens === 0 ||
      !count(s.afterTokens) ||
      s.afterTokens > s.beforeTokens ||
      s.beforeTokens <= this.assumptions.beforeErrorTokens ||
      !Number.isSafeInteger(s.beforeTokens + this.assumptions.beforeErrorTokens) ||
      !Number.isSafeInteger(s.afterTokens + this.assumptions.afterErrorTokens)
    )
      return "invalid-observation" as const;
    if (s.sequence <= this.lastSequence) return "duplicate-or-out-of-order" as const;
    const previous = this.tracker.predict(s.beforeTokens, this.assumptions.beforeErrorTokens);
    const fitted = this.tracker.snapshot().model;
    const drift =
      previous &&
      fitted &&
      !previous.extrapolated &&
      Math.abs(s.afterTokens - previous.pointTokens) >
        Math.max(1, fitted.envelope + fitted.slope * this.assumptions.beforeErrorTokens) +
          this.assumptions.driftToleranceRatio * previous.pointTokens;
    if (drift) {
      this.tracker = new UncertainAffineFeedback(this.basis);
      this.driftResets++;
    }
    const status = this.tracker.observe({
      basisKey: this.basis,
      sequence: s.sequence,
      success: true,
      source: "host-immediate",
      beforeTokens: s.beforeTokens,
      afterTokens: s.afterTokens,
      beforeErrorTokens: this.assumptions.beforeErrorTokens,
      afterErrorTokens: this.assumptions.afterErrorTokens,
    });
    if (status !== "accepted-approximate") throw new Error("unexpected retention gate result");
    this.lastSequence = s.sequence;
    this.accepted++;
    return drift ? ("accepted-after-drift-reset" as const) : ("accepted" as const);
  }
}
