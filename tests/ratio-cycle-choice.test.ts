import { expect, it } from "vitest";
import { costOfCall, resolveUnitPrices } from "../src/pricing";
import {
  chooseRatioCycle,
  type RatioCycleInput,
  ratioCycleCost,
} from "../tools/ratio-cycle-choice";
import { simulateTraceWorld } from "../tools/trace-driven-simulation";

const input: RatioCycleInput = {
  context: 550000,
  growth: 16000,
  retention: 0.1,
  samples: 0,
  prices: resolveUnitPrices({
    inputPerMillion: 0.3,
    outputPerMillion: 1.2,
    cacheReadPerMillion: 0.006,
  }),
  summaryInputRate: 0.0000003,
  summaryOutput: 1000,
  offset: 6000,
};

it("matches independent per-call billing across threshold cycles, including offsets and output", () => {
  for (const offset of [0, 6000, 80000]) {
    for (const discounted of [true, false]) {
      const i = {
        ...input,
        offset,
        prices: discounted
          ? input.prices
          : resolveUnitPrices({ inputPerMillion: 0.3, outputPerMillion: 1.2 }),
      };
      let after = Math.round(550000 * i.retention),
        total = 0,
        calls = 0;
      for (let cycle = 0; cycle < 64; cycle++) {
        const n = Math.ceil((550000 - after) / (i.growth ?? 1));
        let bill = 0,
          prefix = 0;
        for (let j = 0; j < n; j++) {
          const prompt = Math.max(0, after + j * (i.growth ?? 1) - offset);
          bill += costOfCall(i.prices, prompt, {
            prefixTokens: prefix,
            aliveProbability: j === 0 ? 0 : 1,
            cachingInPlay: i.prices.hasCacheDiscount,
          });
          prefix = prompt;
        }
        const before = after + n * (i.growth ?? 1);
        bill += before * i.summaryInputRate + i.summaryOutput * i.prices.outputPerToken;
        if (cycle >= 8) {
          total += bill;
          calls += n;
        }
        after = Math.round(before * i.retention);
      }
      expect(ratioCycleCost(i, 550000)).toBeCloseTo(total / calls, 12);
    }
  }
});

it("supports prior and observations, respects safety, and scales prices without changing timing", () => {
  expect(chooseRatioCycle(input).source).toBe("retention-prior");
  expect(chooseRatioCycle({ ...input, samples: 1 }).source).toBe("observed-retention");
  expect(chooseRatioCycle({ ...input, context: 700000 }).action).toBe("FORCE");
  expect(chooseRatioCycle({ ...input, context: 690000 }).reason).toBe("growth-safety-margin");
  expect(chooseRatioCycle({ ...input, context: 400000, growth: 310000 }).reason).toBe(
    "growth-safety-margin",
  );
  const zeroRead = chooseRatioCycle({
    ...input,
    summaryOutput: 100000,
    prices: resolveUnitPrices({
      inputPerMillion: 0.3,
      outputPerMillion: 1.2,
      cacheReadPerMillion: 0,
    }),
  });
  expect(zeroRead.boundary).toBeGreaterThan(600000);
  expect(chooseRatioCycle({ ...input, growth: undefined }).boundary).toBe(600000);
  const scaled = chooseRatioCycle({
    ...input,
    prices: resolveUnitPrices({
      inputPerMillion: 3,
      outputPerMillion: 12,
      cacheReadPerMillion: 0.06,
    }),
    summaryInputRate: input.summaryInputRate * 10,
  });
  expect(scaled.boundary).toBe(chooseRatioCycle(input).boundary);
  expect(scaled.cost).toBeCloseTo((chooseRatioCycle(input).cost ?? 0) * 10, 12);
});

it("changes real decisions, learns only from completed summaries and cannot see future task length", () => {
  const w = {
    initialContext: 100000,
    initialPrompt: 94000,
    growth: Array(200).fill(5000),
    prices: input.prices,
    retentionRatio: 0.2,
    summaryInputRate: input.summaryInputRate,
    summaryOutput: 1000,
    ordinaryOutput: 300,
  };
  const run = simulateTraceWorld(w, "ratio-cycle");
  const short = simulateTraceWorld({ ...w, growth: w.growth.slice(0, 110) }, "ratio-cycle");
  expect(run.cycleDecisions?.filter((r) => r.step <= 110)).toEqual(short.cycleDecisions);
  const first = run.actions[0];
  expect(first).toBeDefined();
  expect(
    run.cycleDecisions
      ?.filter((r) => r.step <= (first?.step ?? 0))
      .every((r) => r.retention === 0.1),
  ).toBe(true);
  expect(
    run.cycleDecisions?.some((r) => r.source === "observed-retention" && r.retention === 0.2),
  ).toBe(true);
  expect(run.actions).not.toEqual(simulateTraceWorld(w, "fixed60").actions);
});
