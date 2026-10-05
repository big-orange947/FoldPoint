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
});
