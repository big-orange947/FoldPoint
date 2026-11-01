import { expect, it } from "vitest";
import { resolveUnitPrices } from "../src/pricing";
import { simulateTraceWorld, stressTraceWorld } from "../tools/trace-driven-simulation";

it("keeps each strategy's contexts and cache independent and does not inspect future growth", () => {
  const world = {
    initialContext: 100000,
    initialPrompt: 90000,
    growth: Array(60).fill(20000),
    prices: resolveUnitPrices({
      inputPerMillion: 0.3,
      outputPerMillion: 1.2,
      cacheReadPerMillion: 0.006,
    }),
    retentionRatio: 0.11,
    summaryInputRate: 0.0000003,
    summaryOutput: 1000,
    ordinaryOutput: 300,
  };
  const fixed = simulateTraceWorld(world, "fixed60");
  const early = simulateTraceWorld(world, "fixed50");
  const supported = simulateTraceWorld(world, "supported");
  expect(fixed.offeredGrowth).toBe(early.offeredGrowth);
  expect(fixed.actions[0]?.before).toBe(600000);
  expect(early.actions[0]?.before).toBe(500000);
  expect(fixed.totalCost).not.toBe(early.totalCost);
  expect(simulateTraceWorld(world, "fixed60")).toEqual(fixed);
  expect(supported.learnedChoices).toBe(0);
  expect(supported.totalCost).toBe(fixed.totalCost);
  const short = simulateTraceWorld({ ...world, growth: world.growth.slice(0, 30) }, "fixed60");
  expect(fixed.actions.filter((a) => a.step <= 30)).toEqual(short.actions);
  const cold = simulateTraceWorld({ ...world, cacheAlive: Array(61).fill(false) }, "fixed60");
  expect(cold.ordinaryCost).toBeGreaterThan(fixed.ordinaryCost);
  expect(() => simulateTraceWorld({ ...world, cacheAlive: [true] }, "fixed60")).toThrow();
  const matrix = stressTraceWorld(world);
  expect(matrix).toHaveLength(12);
  expect(matrix.every((row) => row.supportedDelta === 0 && row.supportedLearnedChoices === 0)).toBe(
    true,
  );
  expect(matrix.some((row) => row.diagnosticEarlyDelta !== 0)).toBe(true);
});
