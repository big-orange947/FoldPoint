import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const r = JSON.parse(readFileSync("benchmarks/reports/pi-floor-v2-20261023.json", "utf8"));
it("keeps the real paid negative result and its complete bill internally consistent", () => {
  for (const a of Object.values(r.results) as Array<{
    ordinaryCost: number;
    summaryCost: number;
    prewarmCost: number;
    total: number;
  }>)
    expect(a.total).toBeCloseTo(a.ordinaryCost + a.summaryCost + a.prewarmCost, 12);
  const c = r.results.floorV2,
    fixed = r.results.historicalFixed60,
    old = r.results.historicalAffine;
  expect(c.total).toBeGreaterThan(fixed.total);
  expect(c.total).toBeGreaterThan(old.total);
  expect(c.total / fixed.total - 1).toBeCloseTo(0.014727235592594923, 12);
  expect(c.ordinaryCost - fixed.ordinaryCost).toBeCloseTo(-0.11750346, 12);
  expect(c.summaryCost - fixed.summaryCost).toBeCloseTo(0.1395951, 12);
  expect(c.correct).toBe(140);
  expect(c.failures).toBe(0);
  expect(c.unpricedSummaries).toBe(0);
  expect(r.immediateFeedback.samples).toBe(c.summaries);
  expect(r.immediateFeedback.actualSummaryCost).toBeCloseTo(c.summaryCost, 12);
  expect(r.control.vetoes + r.control.economicAllowed + r.control.safetyAllowed).toBe(
    r.control.applied,
  );
  expect(r.controller).toBe("total-floor-v2-affine-risk");
  for (const hash of Object.values(r.rawSha256)) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  const md = readFileSync("benchmarks/pi-floor-v2-20261023.md", "utf8");
  expect(md).toContain("1.522145052");
  expect(md).toContain("不将此变体推广为默认策略");
});
