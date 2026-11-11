import { expect, it } from "vitest";
import { resolveUnitPrices } from "../src/pricing";
import { chooseColdStartCandidate } from "../tools/cold-start-candidate";

it("retains the safety line and falls back when no growth is available", () => {
  const prices = resolveUnitPrices({
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
  });
  const input = { context: 550000, prices, summaryInputRate: 0.000003, summaryOutput: 1000 };
  expect(chooseColdStartCandidate(input).action).toBe("KEEP");
  expect(chooseColdStartCandidate({ ...input, context: 600000 }).action).toBe("COMPACT");
  expect(chooseColdStartCandidate({ ...input, context: 700000 }).action).toBe("FORCE");
  expect(chooseColdStartCandidate({ ...input, growth: -1 }).action).toBe("KEEP");
  expect(
    chooseColdStartCandidate({
      ...input,
      growth: 10000,
      prices: resolveUnitPrices({
        inputPerMillion: 3,
        outputPerMillion: 1,
        cacheReadPerMillion: 2,
      }),
      summaryInputRate: 0.0000003,
      summaryOutput: 500,
    }).action,
  ).toBe("COMPACT");
  expect(() => chooseColdStartCandidate({ ...input, context: NaN })).toThrow();
  expect(() => chooseColdStartCandidate({ ...input, hostProviderOffset: -1 })).toThrow();
});
