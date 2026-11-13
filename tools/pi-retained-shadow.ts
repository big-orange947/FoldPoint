/** Metadata-only forward predictions. Host estimates are never promoted to exact token truth. */
import { costOfUsage, type UnitPrices } from "../src/pricing";
import { predictSize, RetainedSizeChoice } from "./retained-size-choice";

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
export class PiRetainedShadow {
  private learner = new RetainedSizeChoice();
  private sequence = 0;
  private pending = new Map<string, number>();
  private summary: { before: number; forecast: number; seq: number } | undefined;
  readonly events: Record<string, unknown>[] = [];
  constructor(private prices: UnitPrices) {}
  beforeSummary(before: number) {
    if (this.summary) throw new Error("duplicate summary forecast");
    const state = this.learner.snapshot(),
      forecast = predictSize(state.model, before),
      seq = ++this.sequence;
    this.summary = { before, forecast, seq };
    this.events.push({
      type: "summary_prediction",
      seq,
      beforeHostTokens: before,
      priorSamples: state.samples,
      model: state.kind,
      predictedAfterHostTokens: forecast,
      predictedInputCostIfCold: before * this.prices.inputPerToken,
      summaryOutputPrediction: null,
    });
  }
  afterSummary(before: number, after: number) {
    if (!Number.isSafeInteger(after) || after <= 0 || after >= before)
      throw new Error("invalid host feedback");
    const previous = this.summary;
    if (!previous || previous.before !== before) throw new Error("unpaired summary forecast");
    this.events.push({
      type: "summary_feedback",
      seq: ++this.sequence,
      predictionSeq: previous.seq,
      beforeHostTokens: before,
      afterHostEstimate: after,
      relativeError: previous.forecast / after - 1,
      hostEstimateOnly: true,
    });
    this.learner.observe(before, after);
    this.summary = undefined;
  }
  beforeRequest(stage: string, promptEstimate: number) {
    if (
      !/^(pre-compaction|summary|first-post|second-post|third-post|fourth-post|fifth-post)$/.test(
        stage,
      )
    )
      throw new Error("invalid stage");
    if (!Number.isFinite(promptEstimate) || promptEstimate < 0 || this.pending.has(stage))
      throw new Error("invalid request forecast");
    const state = this.learner.snapshot(),
      seq = ++this.sequence;
    this.pending.set(stage, seq);
    this.events.push({
      type: "request_prediction",
      seq,
      stage,
      priorSamples: state.samples,
      model: state.kind,
      retainedModel: state.model,
      predictedAfterHostTokensIfCompacted:
        promptEstimate > 1 ? predictSize(state.model, promptEstimate) : null,
      promptHostEstimate: promptEstimate,
      inputCostIfCold: promptEstimate * this.prices.inputPerToken,
      inputCostIfAllCached: promptEstimate * this.prices.cacheReadPerToken,
      cacheUsageKnown: false,
    });
  }
  afterRequest(stage: string, usage: Usage) {
    const seq = this.pending.get(stage);
    if (seq === undefined) throw new Error("unpaired provider usage");
    if (!Object.values(usage).every((v) => Number.isSafeInteger(v) && v >= 0))
      throw new Error("invalid provider usage");
    const u = {
      promptTokens: usage.input + usage.cacheRead + usage.cacheWrite,
      outputTokens: usage.output,
      cachedInputTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
    };
    this.events.push({
      type: "request_usage",
      seq: ++this.sequence,
      stage,
      predictionSeq: seq,
      usage: u,
      inputCost: costOfUsage(this.prices, { ...u, outputTokens: 0 }),
      totalCost: costOfUsage(this.prices, u),
    });
    this.pending.delete(stage);
  }
  report() {
    return {
      events: this.events,
      pendingRequests: this.pending.size,
      pendingSummary: this.summary !== undefined,
      samples: this.learner.snapshot().samples,
      applied: false,
      hostEstimatesOnly: true,
      timingControlExercised: false,
    };
  }
}
