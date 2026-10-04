import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PRICE_PROFILES,
  providerRatioReport,
  ratioScenarios,
  renderProviderRatios,
} from "../benchmarks/provider-ratios";

describe("provider price sensitivity", () => {
  it("uses one common behavior matrix, with near-end counterexamples and no endpoint hints", () => {
    const scenarios = ratioScenarios();
    expect(scenarios).toHaveLength(117);
    expect(scenarios.filter((s) => s.id.startsWith("near-end-")).length).toBe(9);
    for (const s of scenarios) {
      expect(s.hostHorizon).toBeUndefined();
      expect(s.contextWindowTokens).toBe(1_000_000);
    }
  });
  it("holds growth fixed and price scaling preserves decisions and scales cost", () => {
    const scenarios = ratioScenarios().filter(
      (s) =>
        s.steps === 140 &&
        s.compactor.retentionRatio === 0.1 &&
        s.compactor.outputRatio === 0.002 &&
        s.growthPerStep === 32000,
    );
    const report = providerRatioReport(scenarios, PRICE_PROFILES.slice(0, 2));
    for (const first of report.rows.filter((r) => r.profile === "deepseek-flash-peak")) {
      const second = report.rows.find(
        (r) => r.id === first.id && r.profile === "deepseek-flash-offpeak",
      );
      if (!second) throw new Error("Missing scalar control");
      expect(new Set(Object.values(first.arms).map((a) => a.fingerprint)).size).toBe(1);
      for (const [name, arm] of Object.entries(first.arms)) {
        expect(second.arms[name]?.steps).toEqual(arm.steps);
        expect(second.arms[name]?.cost).toBeCloseTo(arm.cost / 2, 10);
        expect(second.arms[name]?.fingerprint).toBe(arm.fingerprint);
      }
    }
  });
  it("keeps generated report and markdown synchronized, including losses and exclusions", () => {
    const report = JSON.parse(
      readFileSync(new URL("../benchmarks/reports/provider-ratios.json", import.meta.url), "utf8"),
    ) as ReturnType<typeof providerRatioReport>;
    expect(report.rows).toHaveLength(936);
    expect(report.paidCalls).toBe(0);
    expect(report.profiles).toEqual(PRICE_PROFILES);
    expect(readFileSync(new URL("../benchmarks/provider-ratios.md", import.meta.url), "utf8")).toBe(
      renderProviderRatios(report),
    );
    for (const s of report.summary) {
      expect(s.wins + s.losses + s.ties).toBe(s.compared);
      expect(s.compared + s.excludedNoCompaction).toBe(s.cases);
    }
    expect(report.summary.some((s) => s.cache === "warm" && (s.meanRelativeChange ?? 0) > 0)).toBe(
      true,
    );
    for (const r of report.rows)
      expect(new Set(Object.values(r.arms).map((a) => a.fingerprint)).size).toBe(1);
  });
});
