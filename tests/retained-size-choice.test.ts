import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { costOfCall, resolveUnitPrices } from "../src/pricing";
import { adaptiveCycleCost } from "../tools/adaptive-cycle-choice";
import {
  renderRetentionValidation,
  simulateRetentionWorld,
  type validateRetainedPredictions,
  type validateRetentionExecution,
} from "../tools/adaptive-retention-validation";
import { ratioCycleCost } from "../tools/ratio-cycle-choice";
import { predictSize, RetainedSizeChoice } from "../tools/retained-size-choice";
import { simulateTraceWorld } from "../tools/trace-driven-simulation";

const input = {
  context: 550000,
  growth: 16000,
  retention: 0.14,
  samples: 1,
  prices: resolveUnitPrices({
    inputPerMillion: 0.3,
    outputPerMillion: 1.2,
    cacheReadPerMillion: 0.006,
  }),
  summaryInputRate: 3e-7,
  summaryOutput: 1348,
  offset: 6176,
};
it("starts at ten percent and chooses models only from previously scored forecasts", () => {
  const learner = new RetainedSizeChoice();
  expect(learner.snapshot().kind).toBe("prior");
  expect(predictSize(learner.snapshot().model, 600000)).toBe(60000);
  learner.observe(200000, 24000);
  expect(learner.snapshot().kind).toBe("ratio"); // no scored absolute forecast yet
  learner.observe(350000, 24000);
  expect(learner.snapshot().kind).toBe("absolute");
  expect(predictSize(learner.snapshot().model, 600000)).toBe(24000);
  expect(() => learner.observe(10, 20)).toThrow();
  expect(() => learner.observe(Infinity, 1)).toThrow();
});

it("preserves proportional behavior and only admits affine models with history and span", () => {
  const ratio = new RetainedSizeChoice(),
    affine = new RetainedSizeChoice(),
    narrow = new RetainedSizeChoice();
  for (const before of [
    200000, 350000, 600000, 250000, 650000, 450000, 300000, 550000, 220000, 680000, 400000, 580000,
  ]) {
    ratio.observe(before, Math.round(before * 0.14));
    affine.observe(before, Math.round(before * 0.06 + 18000));
    narrow.observe(500000, 24000);
  }
  expect(ratio.snapshot().kind).toBe("ratio");
  expect(predictSize(ratio.snapshot().model, 600000)).toBe(84000);
  expect(affine.snapshot().kind).toBe("affine");
  expect(predictSize(affine.snapshot().model, 600000)).toBe(54000);
  expect(narrow.snapshot().kind).not.toBe("affine");
});

it("reconciles generalized cycle billing with ordinary per-call charges", () => {
  for (const model of [
    { slope: 0.14, intercept: 0 },
    { slope: 0, intercept: 24000 },
    { slope: 0.06, intercept: 18000 },
  ]) {
    let after = predictSize(model, 550000),
      total = 0,
      calls = 0;
    for (let cycle = 0; cycle < 64; cycle++) {
      const n = Math.ceil((550000 - after) / 16000),
        before = after + n * 16000;
      let bill =
          before * input.summaryInputRate + input.summaryOutput * input.prices.outputPerToken,
        prefix = 0;
      for (let j = 0; j < n; j++) {
        const prompt = Math.max(0, after + j * 16000 - input.offset);
        bill += costOfCall(input.prices, prompt, {
          prefixTokens: prefix,
          aliveProbability: j === 0 ? 0 : 1,
          cachingInPlay: true,
        });
        prefix = prompt;
      }
      if (cycle >= 8) {
        total += bill;
        calls += n;
      }
      after = predictSize(model, before);
    }
    expect(adaptiveCycleCost(input, model, 550000)).toBeCloseTo(total / calls, 12);
  }
  expect(adaptiveCycleCost(input, { slope: 0.14, intercept: 0 }, 550000)).toBeCloseTo(
    ratioCycleCost(input, 550000),
    12,
  );
});

it("matches old simulator controls and is prefix-identical when future task length changes", () => {
  const world = {
    initialContext: 100000,
    initialPrompt: 93824,
    growth: Array(200).fill(16000),
    retentionRatio: 0.14,
    prices: input.prices,
    summaryInputRate: input.summaryInputRate,
    summaryOutput: 1348,
    ordinaryOutput: 300,
  };
  for (const policy of ["ratio", "fixed50", "fixed60"] as const) {
    const a = simulateRetentionWorld(world, () => ({ slope: 0.14, intercept: 0 }), policy);
    const b = simulateTraceWorld(world, policy === "ratio" ? "ratio-cycle" : policy);
    expect(a.totalCost).toBeCloseTo(b.totalCost, 12);
    expect(a.actions).toEqual(b.actions.map((x) => x.step));
  }
  const model = () => ({ slope: 0, intercept: 24000 });
  const long = simulateRetentionWorld(world, model, "adaptive"),
    short = simulateRetentionWorld(
      { ...world, growth: world.growth.slice(0, 100) },
      model,
      "adaptive",
    );
  expect(long.predictions.filter((x) => x.step <= 100)).toEqual(short.predictions);
  expect(long.actions.filter((x) => x <= 100)).toEqual(short.actions);
});

it("binds reports to code and retains cost ties and regressions", () => {
  const r = JSON.parse(
    readFileSync("benchmarks/reports/adaptive-retention-validation.json", "utf8"),
  ) as {
    paidCalls: number;
    sources: Record<string, string>;
    predictions: ReturnType<typeof validateRetainedPredictions>;
    rows: ReturnType<typeof validateRetentionExecution>;
  };
  expect(r.paidCalls).toBe(0);
  expect(r.rows).toHaveLength(48);
  for (const [path, hash] of Object.entries(r.sources))
    expect(hash).toBe(
      createHash("sha256").update(readFileSync(path, "utf8").replace(/\r\n/g, "\n")).digest("hex"),
    );
  expect(r.rows.some((x) => x.costChangeVsRatio > 0)).toBe(true);
  for (const row of r.rows)
    for (const bill of [row.adaptive, row.ratio, row.fixed50, row.fixed60])
      expect(bill.totalCost).toBeCloseTo(bill.ordinaryCost + bill.summaryCost, 12);
  expect(
    readFileSync("benchmarks/adaptive-retention-validation.md", "utf8").replace(/\r\n/g, "\n"),
  ).toBe(renderRetentionValidation(r));
});
