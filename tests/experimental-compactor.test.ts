import { describe, expect, it } from "vitest";
import {
  ExperimentalCompactorLearner,
  predictCompactorTokens,
} from "../src/experimental-compactor";

describe("experimental compactor token learner", () => {
  const observe = (l: ExperimentalCompactorLearner, x: number, y: number, output = 2000) =>
    l.observe({
      beforeTokens: x,
      afterTokens: y,
      outputTokens: output,
      summaryInputCostPerToken: 0.000002,
    });
  it("does not identify a fixed term from one sample or identical sizes", () => {
    const l = new ExperimentalCompactorLearner();
    observe(l, 100000, 50000);
    expect(l.snapshot()).toBeUndefined();
    observe(l, 100000, 50000);
    observe(l, 100000, 50000);
    expect(l.snapshot()).toBeUndefined();
  });
  it("copies bounded prior metadata and strips unknown fields on export", () => {
    const observation = {
      beforeTokens: 100000,
      afterTokens: 10000,
      outputTokens: 2000,
      summaryInputCostPerToken: 2e-6,
      accidentalBody: "must not persist",
    };
    const l = new ExperimentalCompactorLearner([observation]);
    observation.afterTokens = 50000;
    expect(l.exportObservations()[0]?.afterTokens).toBe(10000);
    expect(l.exportObservations()[0]).not.toHaveProperty("accidentalBody");
    const exported = l.exportObservations();
    const first = exported[0];
    if (!first) throw new Error("missing observation");
    first.afterTokens = 70000;
    expect(l.exportObservations()[0]?.afterTokens).toBe(10000);
    expect(() => new ExperimentalCompactorLearner(Array(33).fill(observation))).toThrow();
    expect(
      () => new ExperimentalCompactorLearner([{ ...observation, outputTokens: -1 }]),
    ).toThrow();
  });
  it("fits stable observed output and retention sizes without being given a floor", () => {
    const l = new ExperimentalCompactorLearner();
    for (const x of [100000, 150000, 200000]) observe(l, x, 50000);
    const model = l.snapshot();
    expect(model).toBeDefined();
    if (!model) throw new Error("missing model");
    expect(predictCompactorTokens(model, 120000)).toEqual({
      afterTokens: 50000,
      outputTokens: 2000,
    });
    expect(predictCompactorTokens(model, 30000).afterTokens).toBe(30000);
  });
  it("fits proportional and affine observations and residual pressure", () => {
    const l = new ExperimentalCompactorLearner();
    for (const x of [100000, 150000, 200000]) observe(l, x, 10000 + x * 0.1, x * 0.003);
    const model = l.snapshot();
    if (!model) throw new Error("missing model");
    expect(predictCompactorTokens(model, 120000).afterTokens).toBeCloseTo(22000);
    expect(predictCompactorTokens(model, 120000).outputTokens).toBeCloseTo(360);
    model.after.residual = 123;
    expect(predictCompactorTokens(model, 120000, true).afterTokens).toBeCloseTo(22123);
  });
  it("keeps bounded copies, rejects malformed observations and learns changed metadata", () => {
    const l = new ExperimentalCompactorLearner();
    expect(() => observe(l, 0, 0)).toThrow();
    expect(() => observe(l, 100, 101)).toThrow();
    expect(() => observe(l, 100.1, 50)).toThrow();
    for (let i = 0; i < 40; i++) observe(l, 100000 + i * 10000, 50000);
    expect(l.snapshot()?.samples).toBe(32);
    for (let i = 0; i < 32; i++) observe(l, 100000 + i * 10000, 25000, 3000);
    expect(l.snapshot()?.after.intercept).toBe(25000);
    const model = l.snapshot();
    if (!model) throw new Error("missing model");
    expect(() => predictCompactorTokens(model, NaN)).toThrow();
  });
  it("retains a learned affine model across consistent low-span feedback without changing strict snapshot", () => {
    const l = new ExperimentalCompactorLearner();
    for (const x of [100000, 200000, 300000]) observe(l, x, 10000 + x * 0.1);
    for (let i = 0; i < 100; i++) observe(l, 150000, 25000);
    expect(l.snapshot()).toBeUndefined();
    const state = l.snapshotWithFallback();
    expect(state.source).toBe("retained");
    expect(state.observationsSinceFit).toBeGreaterThan(32);
    if (!state.model) throw new Error("missing retained model");
    expect(predictCompactorTokens(state.model, 150000).afterTokens).toBeCloseTo(25000);
    state.model.after.intercept = 999999;
    expect(l.snapshotWithFallback().model?.after.intercept).toBeCloseTo(10000);
    expect(l.exportObservations()).toHaveLength(32);
  });
  it("never invents a model for an unidentifiable cold start", () => {
    const l = new ExperimentalCompactorLearner();
    for (let i = 0; i < 40; i++) observe(l, 150000, 25000);
    expect(l.snapshotWithFallback()).toMatchObject({
      source: "unavailable",
      reason: "not-learned",
    });
    expect(l.snapshotWithFallback().model).toBeUndefined();
  });
  it.each(["retention", "output", "price"] as const)(
    "invalidates retention on %s drift and never resurrects it after eviction",
    (kind) => {
      const l = new ExperimentalCompactorLearner();
      for (const x of [100000, 200000, 300000]) observe(l, x, 25000);
      for (let i = 0; i < 32; i++) observe(l, 150000, 25000);
      expect(l.snapshotWithFallback().source).toBe("retained");
      l.observe({
        beforeTokens: 150000,
        afterTokens: kind === "retention" ? 50000 : 25000,
        outputTokens: kind === "output" ? 5000 : 2000,
        summaryInputCostPerToken: kind === "price" ? 3e-6 : 2e-6,
      });
      expect(l.snapshotWithFallback()).toMatchObject({
        source: "unavailable",
        reason: kind === "price" ? "summary-price-change" : "feedback-drift",
      });
      for (let i = 0; i < 32; i++) observe(l, 150000, 25000);
      expect(l.snapshotWithFallback().source).toBe("unavailable");
      for (const x of [100000, 200000, 300000]) observe(l, x, 25000);
      expect(l.snapshotWithFallback().source).toBe("fitted");
    },
  );
});
