import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { resolveUnitPrices } from "../src/pricing";
import {
  actualRetainedModel,
  adaptivePriceCell,
  renderAdaptivePrices,
  type runAdaptivePrices,
} from "../tools/adaptive-price-validation";

const report = () =>
  JSON.parse(readFileSync("benchmarks/reports/adaptive-price-validation.json", "utf8")) as {
    paidCalls: number;
    sourceHashes: Record<string, string>;
    rows: ReturnType<typeof runAdaptivePrices>;
  };

it("retains every planned cell, losses and fee components with accurate model attribution", () => {
  const r = report();
  expect(r.paidCalls).toBe(0);
  expect(r.rows).toHaveLength(864);
  expect(
    new Set(
      r.rows.map((x) =>
        [
          x.family,
          x.cacheRatio,
          x.outputMultiplier,
          x.summaryRateMultiplier,
          x.growth,
          x.calls,
        ].join("/"),
      ),
    ).size,
  ).toBe(864);
  for (const [path, hash] of Object.entries(r.sourceHashes))
    expect(hash).toBe(
      createHash("sha256").update(readFileSync(path, "utf8").replace(/\r\n/g, "\n")).digest("hex"),
    );
  for (const x of r.rows) {
    for (const b of [x.adaptive, x.oldRatio, x.fixed50, x.fixed60])
      expect(b.totalCost).toBeCloseTo(b.ordinaryCost + b.summaryCost, 12);
    expect(x.actionChanged).toBe(
      JSON.stringify(x.adaptive.actions) !== JSON.stringify(x.oldRatio.actions),
    );
    expect(x.adaptive.summaries).toBe(Object.values(x.adaptive.models).reduce((s, n) => s + n, 0));
    expect(x.oldRatio).not.toHaveProperty("meanOwnTriggerPredictionError");
    expect(x.fixed60).not.toHaveProperty("models");
  }
  expect(r.rows.some((x) => x.changeVsOldRatio < -1e-9)).toBe(true);
  expect(r.rows.some((x) => x.changeVsOldRatio > 1e-9)).toBe(true);
  expect(
    readFileSync("benchmarks/adaptive-price-validation.md", "utf8").replace(/\r\n/g, "\n"),
  ).toBe(renderAdaptivePrices(r));
});

it("reproduces all original price-matrix controls in the proportional environment", () => {
  const prior = JSON.parse(
    readFileSync("benchmarks/reports/ratio-price-sensitivity.json", "utf8"),
  ) as {
    rows: Array<{
      ratio: number;
      outputMultiplier: number;
      summaryRateMultiplier: number;
      growth: number;
      calls: number;
      fixed50: { totalCost: number };
      fixed60: { totalCost: number };
      candidate: { totalCost: number };
    }>;
  };
  for (const x of report().rows.filter((x) => x.family === "ratio")) {
    const old = prior.rows.find(
      (p) =>
        p.ratio === x.cacheRatio &&
        p.outputMultiplier === x.outputMultiplier &&
        p.summaryRateMultiplier === x.summaryRateMultiplier &&
        p.growth === x.growth &&
        p.calls === x.calls,
    );
    expect(old).toBeDefined();
    expect(x.oldRatio.totalCost).toBeCloseTo(old?.candidate.totalCost ?? -1, 10);
    expect(x.fixed50.totalCost).toBeCloseTo(old?.fixed50.totalCost ?? -1, 10);
    expect(x.fixed60.totalCost).toBeCloseTo(old?.fixed60.totalCost ?? -1, 10);
  }
});

it("keeps the drift boundary independent of endpoint and scales prices without changing actions", () => {
  expect(actualRetainedModel("drift", 719)).toEqual({ slope: 0, intercept: 24000 });
  expect(actualRetainedModel("drift", 720)).toEqual({ slope: 0.14, intercept: 0 });
  const source = {
    initialContext: 100000,
    initialPrompt: 93824,
    growth: [1000],
    retentionRatio: 0.14,
    prices: resolveUnitPrices({
      inputPerMillion: 0.3,
      outputPerMillion: 1.2,
      cacheReadPerMillion: 0.006,
    }),
    summaryInputRate: 3e-7,
    summaryOutput: 1348,
    ordinaryOutput: 300,
  };
  const a = adaptivePriceCell(source, "absolute", 0.002, 32, 1, 16000, 720);
  const b = adaptivePriceCell(
    {
      ...source,
      prices: resolveUnitPrices({
        inputPerMillion: 3,
        outputPerMillion: 12,
        cacheReadPerMillion: 0.06,
      }),
      summaryInputRate: 3e-6,
    },
    "absolute",
    0.002,
    32,
    1,
    16000,
    720,
  );
  expect(b.adaptive.totalCost).toBeCloseTo(a.adaptive.totalCost * 10, 10);
  expect(b.adaptive.actions).toEqual(a.adaptive.actions);
  expect(b.changeVsOldRatio).toBeCloseTo(a.changeVsOldRatio, 12);
});
