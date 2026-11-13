import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { resolveUnitPrices } from "../src/pricing";
import { simulateRetentionWorld } from "../tools/adaptive-retention-validation";
import { ChangeAwareRetainedSize } from "../tools/change-aware-retained-size";
import {
  feedbackNoiseChecks,
  renderChangeAware,
  type validateChangeAware,
} from "../tools/change-aware-retention-validation";

it("confirms a change only after the second observation and keeps only confirming evidence", () => {
  const l = new ChangeAwareRetainedSize();
  expect(l.snapshot().model).toEqual({ slope: 0.1, intercept: 0 });
  for (let i = 0; i < 8; i++) l.observe(500000, 24000);
  const before = l.snapshot();
  expect(l.snapshot()).toEqual(before);
  l.observe(500000, 70000);
  expect(l.diagnostics().resets).toEqual([]);
  l.observe(610000, 85400);
  expect(l.diagnostics().resets).toEqual([10]);
  expect(l.snapshot().samples).toBe(2);
  expect(l.snapshot().model.slope).toBeCloseTo(0.14, 12);
  expect(l.snapshot().scoredCommonSamples).toBe(1);
  const prior = l.diagnostics();
  expect(() => l.observe(10, 11)).toThrow();
  expect(l.diagnostics()).toEqual(prior);
});

it("does not reset on the predefined isolated outliers, alternating errors or steady noise", () => {
  const checks = feedbackNoiseChecks();
  for (const x of checks.filter((r) => !["abrupt-up", "abrupt-down"].includes(r.scenario)))
    expect(x.resets).toEqual([]);
  for (const x of checks.filter((r) => ["abrupt-up", "abrupt-down"].includes(r.scenario))) {
    expect(x.resets).toEqual([62]);
    expect(x.postChangeMeanError).toBeLessThan(x.oldPostChangeMeanError);
  }
});

it("exposes the limitation that two correlated outliers can look like a real change", () => {
  const l = new ChangeAwareRetainedSize();
  for (let i = 0; i < 8; i++) l.observe(500000, 24000);
  l.observe(500000, 72000);
  l.observe(500000, 72000);
  expect(l.diagnostics().resets).toEqual([10]);
});

it("keeps actions and reset timing prefix-identical across different task endpoints", () => {
  const world = {
    initialContext: 100000,
    initialPrompt: 93824,
    growth: Array(120).fill(16000),
    retentionRatio: 0.14,
    prices: resolveUnitPrices({
      inputPerMillion: 0.3,
      outputPerMillion: 1.2,
      cacheReadPerMillion: 0.0006,
    }),
    summaryInputRate: 3e-7,
    summaryOutput: 10000,
    ordinaryOutput: 300,
  };
  const model = (step: number) =>
    step < 60 ? { slope: 0, intercept: 24000 } : { slope: 0.14, intercept: 0 };
  const a = new ChangeAwareRetainedSize(),
    b = new ChangeAwareRetainedSize();
  const long = simulateRetentionWorld(world, model, "adaptive", a),
    short = simulateRetentionWorld(
      { ...world, growth: world.growth.slice(0, 90) },
      model,
      "adaptive",
      b,
    );
  expect(long.predictions.filter((r) => r.step <= 90)).toEqual(short.predictions);
  expect(long.actions.filter((s) => s <= 90)).toEqual(short.actions);
});

it("binds the complete result and reports all reset counts and fees", () => {
  const r = JSON.parse(readFileSync("benchmarks/reports/change-aware-retention.json", "utf8")) as {
    paidCalls: number;
    baselineSha256: string;
    sources: Record<string, string>;
    rows: ReturnType<typeof validateChangeAware>;
    noise: ReturnType<typeof feedbackNoiseChecks>;
  };
  expect(r.paidCalls).toBe(0);
  expect(r.rows).toHaveLength(864);
  expect(r.noise).toHaveLength(18);
  for (const [path, hash] of Object.entries(r.sources))
    expect(hash).toBe(
      createHash("sha256").update(readFileSync(path, "utf8").replace(/\r\n/g, "\n")).digest("hex"),
    );
  expect(r.baselineSha256).toBe(
    createHash("sha256")
      .update(readFileSync("benchmarks/reports/adaptive-price-validation.json"))
      .digest("hex"),
  );
  for (const x of r.rows) {
    expect(x.candidate.totalCost).toBeCloseTo(
      x.candidate.ordinaryCost + x.candidate.summaryCost,
      12,
    );
    expect(x.costChange).toBeCloseTo(x.candidate.totalCost / x.baselineCost - 1, 12);
    expect(x.diagnostics.observed).toBe(x.candidate.summaries);
  }
  expect(readFileSync("benchmarks/change-aware-retention.md", "utf8").replace(/\r\n/g, "\n")).toBe(
    renderChangeAware(r),
  );
});
