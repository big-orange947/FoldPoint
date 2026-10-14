import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  ExperimentalCompactorLearner,
  type TraceCompactionEvent,
  TraceRecorder,
} from "../src/index";
import {
  admitMeasuredFeedback,
  renderFeedbackProbe,
  runFeedbackProbe,
} from "../tools/compactor-feedback-probe";

function measured(): TraceCompactionEvent {
  return new TraceRecorder({ now: () => 0 }).compaction(
    "feedback-test",
    {
      timestamp: 1,
      beforeTokens: 100_000,
      afterTokens: 25_000,
      success: true,
      promptTokens: 150_000,
      cachedInputTokens: 100_000,
      cacheWriteTokens: 50_000,
      outputTokens: 2_000,
    },
    {
      afterTokensSource: "host-measured",
      firstPostCompactionRequest: { timestamp: 2, promptTokens: 80_000, outputTokens: 3_000 },
    },
  );
}

describe("controlled feedback wiring, not a real provider benchmark", () => {
  it("predicts before feedback, learns context and output separately, and reconciles every fee", () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network forbidden"));
    try {
      const r = runFeedbackProbe();
      expect(r.passed).toBe(true);
      expect(Object.values(r.checks)).toEqual(Array(17).fill(true));
      expect(r.usage).toEqual({ paidCalls: 0, externalHttpCalls: 0 });
      expect(r.defaultPolicyChanged).toBe(false);
      expect(r.piFeedbackChanged).toBe(false);
      expect(r.core).toMatchObject({
        coldPrediction: 10_000,
        afterSingleFeedback: 13_500,
        observedAfter: 24_000,
      });
      expect(r.checkpoints.map((c) => c.prediction)).toEqual([null, null, null]);
      expect(r.heldout.prediction).toEqual({ afterTokens: 30_000, outputTokens: 2_750 });
      expect(r.heldout.predictedSummaryCost).toBeCloseTo(0.28875, 12);
      expect(r.accounting).toMatchObject({
        compactions: 4,
        compactionsNotRun: 1,
        calls: 1,
        cacheWarms: 1,
        unpricedCompactions: 0,
      });
      expect(r.accounting.totalCost).toBeCloseTo(1.395765, 12);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("uses same-basis context feedback, not subsequent prompt or summary output; counts input partitions once", () => {
    const learner = new ExperimentalCompactorLearner();
    expect(admitMeasuredFeedback(learner, measured())).toBe("accepted");
    const p = learner.exportObservations()[0];
    expect(p).toMatchObject({ beforeTokens: 100_000, afterTokens: 25_000, outputTokens: 2_000 });
    // Input-only effective cost: (100k*0.3 + 50k*3.75)/1M / 100k.
    expect(p?.summaryInputCostPerToken).toBeCloseTo(2.175e-6, 15);
  });

  it("never trains on estimates, unknown sizes, legacy unlabelled sizes or incomplete usage", () => {
    const learner = new ExperimentalCompactorLearner();
    const event = measured();
    const variants = [
      { ...event, afterTokensSource: "host-estimate" as const },
      { ...event, afterTokensSource: undefined },
      { ...event, afterTokens: null },
      { ...event, usage: { promptTokens: 100_000, outputTokens: 2_000 } },
    ];
    expect(variants.map((e) => admitMeasuredFeedback(learner, e))).toEqual([
      "unmeasured-size",
      "unmeasured-size",
      "unknown-size",
      "incomplete-usage",
    ]);
    expect(learner.exportObservations()).toEqual([]);
  });

  it("does not learn a failed attempt or revive an invalidated fit without fresh spanning data", () => {
    const learner = new ExperimentalCompactorLearner();
    expect(
      admitMeasuredFeedback(learner, {
        ...measured(),
        success: false,
        firstPostCompactionRequest: undefined,
      }),
    ).toBe("failed");
    expect(learner.exportObservations()).toEqual([]);
    const r = runFeedbackProbe();
    expect(r.drift).toMatchObject({
      stable: "retained",
      invalidated: "unavailable",
      reason: "feedback-drift",
      recovered: "fitted",
    });
    expect(r.drift.prediction).toEqual({ afterTokens: 70_000, outputTokens: 5_500 });
  });

  it.each([
    {
      promptTokens: 150_000,
      cachedInputTokens: 100_000,
      cacheWriteTokens: 100_000,
      outputTokens: 2_000,
    },
    { promptTokens: 150_000, cachedInputTokens: -1, cacheWriteTokens: 0, outputTokens: 2_000 },
    { promptTokens: 150_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: Number.NaN },
    { promptTokens: 150_000.5, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 2_000 },
  ])("rejects malformed usage without clamping it into a training sample: %j", (usage) => {
    const learner = new ExperimentalCompactorLearner();
    expect(() => admitMeasuredFeedback(learner, { ...measured(), usage })).toThrow(RangeError);
    expect(learner.exportObservations()).toEqual([]);
  });

  it("keeps the report deterministic and matches the published offline artifact", () => {
    const r = runFeedbackProbe();
    expect(runFeedbackProbe()).toEqual(r);
    expect(
      readFileSync(
        fileURLToPath(new URL("../benchmarks/compactor-feedback.md", import.meta.url)),
        "utf8",
      ),
    ).toBe(renderFeedbackProbe(r));
    expect(r.limitations.join(" ")).toContain("不证明真实任务质量或省钱");
  });
});
