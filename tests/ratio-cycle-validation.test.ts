import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  type compareRatioCycle,
  renderRatioValidation,
  type validateRatioCycle,
  validationGrowth,
} from "../tools/ratio-cycle-validation";

it("advances a reproducible RNG and preserves growth prefixes across task endpoints", () => {
  for (const family of ["steady-jitter", "slow-jitter", "fast-then-slow-jitter"]) {
    const long = validationGrowth(9173, family, 720);
    expect(validationGrowth(9173, family, 360)).toEqual(long.slice(0, 359));
    expect(new Set(long).size).toBeGreaterThan(200);
    expect(validationGrowth(28711, family, 720)).not.toEqual(long);
  }
});

it("binds the complete positive and negative results to sources and their rendered report", () => {
  const r = JSON.parse(readFileSync("benchmarks/reports/ratio-cycle-validation.json", "utf8")) as {
    paidCalls: number;
    sourceHashes: Record<string, string>;
    rows: ReturnType<typeof validateRatioCycle>;
    tails: ReturnType<typeof validateRatioCycle>;
    development: ReturnType<typeof compareRatioCycle>;
  };
  expect(r.paidCalls).toBe(0);
  expect(r.rows).toHaveLength(54);
  expect(
    new Set(r.rows.map((x) => `${x.seed}/${x.family}/${x.calls}/${x.retentionRatio}`)).size,
  ).toBe(54);
  for (const [path, hash] of Object.entries(r.sourceHashes))
    expect(hash).toBe(
      createHash("sha256").update(readFileSync(path, "utf8").replace(/\r\n/g, "\n")).digest("hex"),
    );
  expect(r.development.saving).toBeLessThan(0);
  expect(r.tails.some((x) => x.saving < 0)).toBe(true);
  for (const row of [...r.rows, ...r.tails, r.development]) {
    expect(row.fixed.offeredGrowth).toBe(row.candidate.offeredGrowth);
    expect(row.fixed.ordinaryCalls).toBe(row.candidate.ordinaryCalls);
    for (const bill of [row.fixed, row.fixed50, row.candidate])
      expect(bill.totalCost).toBeCloseTo(bill.ordinaryCost + bill.summaryCost, 12);
    expect(row.decisionsUsingPrior).toBeGreaterThan(0);
    expect(row.decisionsUsingObservations).toBeGreaterThan(0);
  }
  expect(readFileSync("benchmarks/ratio-cycle-validation.md", "utf8").replace(/\r\n/g, "\n")).toBe(
    renderRatioValidation(r),
  );
});
