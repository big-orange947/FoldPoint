import { expect, it } from "vitest";
import { resolveUnitPrices } from "../src/pricing";
import { auditSummaryForecast } from "../tools/summary-prequential";

it("predicts each summary using only prior usage and never treats the first as measured", () => {
  const prices = resolveUnitPrices({ inputPerMillion: 1, outputPerMillion: 2 });
  const usage = { promptTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 10 };
  const samples = [1, 2, 3].map((sequence) => ({
    sequence,
    stage: sequence,
    beforeTokens: 100,
    immediateAfterHostEstimate: 10 * sequence,
    usage: { ...usage, outputTokens: 10 * sequence },
  }));
  const result = auditSummaryForecast(samples, prices);
  expect(result.rows[0]?.predictedSummaryCost).toBeNull();
  expect(result.rows[1]?.predictedSummaryCost).toBeCloseTo(0.00012);
  expect(result.rows[2]?.predictedSummaryCost).toBeCloseTo(0.00013);
  const changed = samples.map((s) => ({ ...s, usage: { ...s.usage } }));
  const last = changed[2];
  if (!last) throw new Error("missing fixture");
  last.usage.outputTokens = 1000;
  last.immediateAfterHostEstimate = 90;
  const modified = auditSummaryForecast(changed, prices);
  expect(modified.rows[2]?.predictedSummaryCost).toBe(result.rows[2]?.predictedSummaryCost);
  expect(modified.rows.slice(0, 2)).toEqual(result.rows.slice(0, 2));
});
