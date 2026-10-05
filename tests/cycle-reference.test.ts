import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cycleReferenceReport, renderCycleReference } from "../benchmarks/cycle-reference";
import { PRICE_PROFILES } from "../benchmarks/provider-ratios";
import { stableCycleCandidates, thresholdCycleAverage } from "../src/experimental-cycle";
import { resolveUnitPrices } from "../src/pricing";

describe("warm-cycle reference audit", () => {
  const report = cycleReferenceReport();
  it("keeps all 96 price/growth/floor/contract states and explicitly has zero paid calls", () => {
    expect(report.rows).toHaveLength(96);
    expect(report.summary).toHaveLength(24);
    expect(report.paidCalls).toBe(0);
    expect(report.externalCalls).toBe(0);
    expect(report.rows.every((r) => r.historyCost > 0 && r.historySamples >= 3)).toBe(true);
  });
  it("reconciles cycle bills and chosen boundaries without pretending they were executed", () => {
    for (const row of report.rows) {
      const p = PRICE_PROFILES.find((p) => p.id === row.profile);
      if (!p) throw new Error("missing profile");
      const prices = resolveUnitPrices(p.pricing);
      const candidates = stableCycleCandidates(
        prices,
        row.model,
        row.growth,
        row.guardedBoundary,
        row.billing,
      );
      expect(row.bestStableCycle.costPerOrdinaryCall).toBe(
        Math.min(...candidates.map((c) => c.costPerOrdinaryCall)),
      );
      const c = row.bestStableCycle;
      expect(c.total).toBeCloseTo(c.summaryCost + c.prewarmCost + c.ordinaryCost, 12);
      if (row.selectedBoundary === null) throw new Error("missing repeat boundary");
      const selected = thresholdCycleAverage(
        prices,
        row.model,
        row.growth,
        row.selectedBoundary,
        row.billing,
      );
      expect(row.selectedReference).toEqual(selected);
      expect(row.fixed60Reference).toEqual(
        thresholdCycleAverage(prices, row.model, row.growth, 600000, row.billing),
      );
    }
    expect(report.rows.some((r) => !r.shouldCompactNow && (r.selectedVsFixed60 ?? 1) < 0)).toBe(
      true,
    );
  });
  it("retains gains AND losses and does not change timing under a scalar price control", () => {
    expect(report.rows.some((r) => (r.selectedVsFixed60 ?? 0) > 0)).toBe(true);
    expect(report.rows.some((r) => (r.selectedVsFixed60 ?? 0) < 0)).toBe(true);
    for (const peak of report.rows.filter((r) => r.profile === "deepseek-flash-peak")) {
      const off = report.rows.find(
        (r) =>
          r.profile === "deepseek-flash-offpeak" &&
          r.id === peak.id &&
          r.contract === peak.contract,
      );
      expect(off?.selectedBoundary).toBe(peak.selectedBoundary);
      expect(off?.shouldCompactNow).toBe(peak.shouldCompactNow);
      expect(off?.bestStableCycle.total).toBeCloseTo(peak.bestStableCycle.total / 2, 12);
    }
  });
  it("checked-in report and markdown exactly match deterministic regeneration", () => {
    expect(
      JSON.parse(
        readFileSync(
          new URL("../benchmarks/reports/cycle-reference.json", import.meta.url),
          "utf8",
        ),
      ),
    ).toEqual(report);
    expect(readFileSync(new URL("../benchmarks/cycle-reference.md", import.meta.url), "utf8")).toBe(
      renderCycleReference(report),
    );
  });
});
