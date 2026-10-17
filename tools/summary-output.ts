/** Research-only output model. Host input units and provider output usage stay explicitly distinct. */
import { UncertainAffineFeedback } from "./uncertain-affine-feedback";

export class SummaryOutputLearner {
  private readonly fitter: UncertainAffineFeedback;
  private ratio = 0.002;
  private accepted = 0;

  constructor(private readonly basisKey: string) {
    this.fitter = new UncertainAffineFeedback(basisKey);
  }

  observe(o: {
    sequence: number;
    beforeTokens: number;
    beforeErrorTokens: number;
    outputTokens: number;
    success: boolean;
  }) {
    const status = this.fitter.observe({
      basisKey: this.basisKey,
      sequence: o.sequence,
      source: "host-immediate",
      success: o.success,
      beforeTokens: o.beforeTokens,
      beforeErrorTokens: o.beforeErrorTokens,
      afterTokens: o.outputTokens,
      afterErrorTokens: 0,
    });
    if (status === "accepted-approximate") {
      this.ratio += 0.25 * (o.outputTokens / o.beforeTokens - this.ratio);
      this.accepted++;
    }
    return status;
  }

  snapshot() {
    const state = this.fitter.snapshot();
    const model = state.model;
    return {
      slope: model?.slope ?? this.ratio,
      intercept: model?.floor ?? 0,
      source: model
        ? ("affine" as const)
        : this.accepted
          ? ("ratio-ema" as const)
          : ("ratio-prior" as const),
      samples: this.accepted,
      retainedSamples: state.retainedSamples,
      legacyRatio: this.ratio,
      minBefore: model?.minBefore ?? null,
      maxBefore: model?.maxBefore ?? null,
      hostInputEstimated: true,
      outputReported: true,
      calibratedConfidenceInterval: false as const,
      canDrivePolicy: false as const,
    };
  }

  predict(beforeTokens: number) {
    if (!Number.isSafeInteger(beforeTokens) || beforeTokens < 1)
      throw new RangeError("invalid output prediction input");
    const model = this.snapshot();
    return { ...model, outputTokens: model.intercept + model.slope * beforeTokens };
  }
}
