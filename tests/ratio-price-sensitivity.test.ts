import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { resolveUnitPrices } from "../src/pricing";
import {
  type endpointDiagnostic,
  priceSensitivityCell,
  renderPriceSensitivity,
  type runPriceSensitivity,
  sensitivityPlan,
} from "../tools/ratio-price-sensitivity";

const report = () =>
  JSON.parse(readFileSync("benchmarks/reports/ratio-price-sensitivity.json", "utf8")) as {
    paidCalls: number;
    sourceHashes: Record<string, string>;
    rows: ReturnType<typeof runPriceSensitivity>;
    endpointCheck: ReturnType<typeof endpointDiagnostic>;
  };

it("keeps the complete predefined matrix and its losses, source bindings and markdown", () => {
  const r = report();
  expect(r.paidCalls).toBe(0);
  expect(r.rows).toHaveLength(216);
  expect(
    new Set(
      r.rows.map((x) =>
        [x.ratio, x.outputMultiplier, x.summaryRateMultiplier, x.growth, x.calls].join("/"),
      ),
    ).size,
  ).toBe(216);
  for (const [path, hash] of Object.entries(r.sourceHashes))
    expect(hash).toBe(
      createHash("sha256").update(readFileSync(path, "utf8").replace(/\r\n/g, "\n")).digest("hex"),
    );
  const plan = JSON.parse(readFileSync("benchmarks/ratio-price-sensitivity-plan.json", "utf8"));
  expect(plan.cacheReadToInput).toEqual(sensitivityPlan.ratios);
  expect(plan.summaryOutputMultipliers).toEqual(sensitivityPlan.outputs);
  expect(plan.summaryInputRateMultipliers).toEqual(sensitivityPlan.summaryRates);
  expect(plan.growthTokensPerCall).toEqual(sensitivityPlan.growth);
  expect(plan.calls).toEqual(sensitivityPlan.lengths);
  expect(r.rows.some((x) => x.savingVs60 < 0)).toBe(true);
  expect(r.rows.some((x) => x.savingVs50 < 0)).toBe(true);
  expect(r.rows.some((x) => x.savingVs50 > 0)).toBe(true);
  expect(new Set(r.rows.flatMap((x) => Object.keys(x.selectedBoundaries))).size).toBeGreaterThan(1);
  for (const x of r.rows) {
    for (const bill of [x.fixed50, x.fixed60, x.candidate])
      expect(bill.totalCost).toBeCloseTo(bill.ordinaryCost + bill.summaryCost, 12);
    expect(x.bestFixed.totalCost).toBe(
      Math.min(...x.grid.filter((v) => v.overshoots === 0).map((v) => v.totalCost)),
    );
    expect(x.grid.find((v) => v.thresholdTokens === 600000)?.totalCost).toBe(x.fixed60.totalCost);
  }
  expect(readFileSync("benchmarks/ratio-price-sensitivity.md", "utf8").replace(/\r\n/g, "\n")).toBe(
    renderPriceSensitivity(r),
  );
});

it("preserves price scaling and separate finite and long-run cost metrics", () => {
  const w = {
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
    summaryOutput: 1000,
    ordinaryOutput: 300,
  };
  const a = priceSensitivityCell(w, 0.002, 32, 1, 16000, 720);
  const b = priceSensitivityCell(
    {
      ...w,
      prices: resolveUnitPrices({
        inputPerMillion: 3,
        outputPerMillion: 12,
        cacheReadPerMillion: 0.06,
      }),
      summaryInputRate: 3e-6,
    },
    0.002,
    32,
    1,
    16000,
    720,
  );
  expect(b.candidate.totalCost).toBeCloseTo(a.candidate.totalCost * 10, 10);
  expect(b.predictedBoundaryWithKnownRetention).toBe(a.predictedBoundaryWithKnownRetention);
  expect(b.selectedBoundaries).toEqual(a.selectedBoundaries);
  expect(b.savingVs60).toBeCloseTo(a.savingVs60, 12);
  expect(a.predictedLongRunCostExcludingOrdinaryOutput).not.toBe(
    a.realizedFiniteCostExcludingOrdinaryOutput,
  );
});
