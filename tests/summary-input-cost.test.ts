import { expect, it } from "vitest";
import { summaryUsageBill } from "../src/experimental-cycle";
import { resolveUnitPrices } from "../src/pricing";
import { SummaryInputCostLearner } from "../tools/summary-input-cost";

const prices = resolveUnitPrices({
  currency: "USD",
  inputPerMillion: 3,
  outputPerMillion: 15,
  cacheReadPerMillion: 0.3,
  cacheWritePerMillion: 3.75,
});
const usage = {
  promptTokens: 20_000,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 600,
};
const sample = {
  binding: "model-price-compactor-cache-v1",
  sequence: 1,
  success: true,
  beforeTokens: 10_000,
  usage,
  prices,
};

it("learns aggregate passes without knowing the number of HTTP requests; predicts only after observation", () => {
  for (const passes of [1, 2, 5]) {
    const learner = new SummaryInputCostLearner(sample.binding);
    expect(learner.snapshot(sample.binding).effectiveInputCostPerBeforeToken).toBeNull();
    expect(learner.observe({ ...sample, usage: { ...usage, promptTokens: passes * 10_000 } })).toBe(
      true,
    );
    const rate = learner.snapshot(sample.binding).effectiveInputCostPerBeforeToken;
    expect(rate).toBeCloseTo(passes * 3e-6, 12);
    expect(summaryUsageBill(prices, 12_000, 700, 0, 1, {}, rate as number)).toBeCloseTo(
      12_000 * passes * 3e-6 + 700 * 15e-6,
      12,
    );
  }
});

it("includes cache read/write once and excludes output from the learned input price", () => {
  const learner = new SummaryInputCostLearner(sample.binding);
  learner.observe({
    ...sample,
    usage: { ...usage, cachedInputTokens: 8000, cacheWriteTokens: 4000 },
  });
  const rate = learner.snapshot(sample.binding).effectiveInputCostPerBeforeToken as number;
  expect(rate * 10_000).toBeCloseTo(8000 * 0.3e-6 + 4000 * 3.75e-6 + 8000 * 3e-6, 12);
  expect(summaryUsageBill(prices, 10_000, 600, 9000, 1, {}, rate)).toBeCloseTo(
    rate * 10_000 + 600 * 15e-6,
    12,
  );
});

it("rejects missing, failed, duplicate, malformed and incompatible samples without fabricating free usage", () => {
  const learner = new SummaryInputCostLearner(sample.binding);
  expect(learner.observe({ ...sample, binding: "other" })).toBe(false);
  expect(learner.observe(sample)).toBe(true);
  expect(learner.observe(sample)).toBe(false);
  expect(learner.observe({ ...sample, sequence: 2, success: false })).toBe(false);
  expect(learner.observe({ ...sample, sequence: 3, usage: undefined })).toBe(false);
  expect(
    learner.observe({ ...sample, sequence: 4, usage: { ...usage, cachedInputTokens: undefined } }),
  ).toBe(false);
  expect(
    learner.observe({ ...sample, sequence: 5, usage: { ...usage, cacheWriteTokens: 30_000 } }),
  ).toBe(false);
  expect(learner.snapshot(sample.binding).samples).toBe(1);
  expect(learner.snapshot("changed-pricing").effectiveInputCostPerBeforeToken).toBeNull();
});

it("bounds history and weights aggregate cost by observed before size", () => {
  const learner = new SummaryInputCostLearner(sample.binding);
  for (let sequence = 1; sequence <= 10; sequence++)
    learner.observe({ ...sample, sequence, beforeTokens: sequence * 1000 });
  expect(learner.snapshot(sample.binding).samples).toBe(8);
  expect(learner.snapshot(sample.binding).effectiveInputCostPerBeforeToken).toBeCloseTo(
    (8 * 0.06) / 52_000,
    12,
  );
});
