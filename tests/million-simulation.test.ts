import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildMillionScenarios,
  millionSimulationReport,
  renderMillionSimulation,
} from "../benchmarks/million-simulation";

describe("zero-paid 1M sensitivity simulation", () => {
  it("uses only 1M windows and never declares an oracle horizon", () => {
    const scenarios = buildMillionScenarios();
    expect(scenarios).toHaveLength(324);
    expect(new Set(scenarios.map((scenario) => scenario.id)).size).toBe(324);
    for (const scenario of scenarios) {
      expect(scenario.contextWindowTokens).toBe(1000000);
      expect(scenario.hostHorizon).toBeUndefined();
      expect(scenario.pricing.currency).toBe("HYPOTHETICAL");
    }
  });

  it("reproduces identical runs, with identical growth across independent branches", () => {
    const cases = buildMillionScenarios().filter(
      (scenario) =>
        scenario.steps === 140 &&
        scenario.compactor.retentionRatio === 0.1 &&
        scenario.compactor.outputRatio === 0.002,
    );
    const first = millionSimulationReport(cases);
    expect(millionSimulationReport(cases)).toEqual(first);
    for (const row of first.rows) {
      const metrics = Object.values(row.arms).map((arm) => arm.metrics);
      expect(new Set(metrics.map((metric) => metric.growthSequenceFingerprint)).size).toBe(1);
      expect(new Set(metrics.map((metric) => metric.totalOfferedGrowthTokens)).size).toBe(1);
      for (const arm of Object.values(row.arms)) {
        expect(Number.isFinite(arm.metrics.totalSimulatedCost)).toBe(true);
        expect(arm.metrics.totalSimulatedCost).toBeGreaterThan(0);
        expect(arm.metrics.compactionAttemptCount).toBe(arm.compactions.length);
      }
    }
    expect(first.paidCalls).toBe(0);
    expect(first.policy.cacheEvidenceBeforeRequest).toBe("omitted");
  });

  it("does not count no-compaction cases as wins", () => {
    const base = buildMillionScenarios()[0];
    if (!base) throw new Error("Missing scenario fixture");
    const scenario = {
      ...base,
      steps: 1,
      startTokens: 0,
      growthPerStep: 1000,
      growthJitter: 0,
    };
    const report = millionSimulationReport([scenario]);
    const group = report.summary.find((summary) => summary.price === "cheapRead");
    if (!group) throw new Error("Missing price summary");
    expect(group.noCompactionCases).toBe(1);
    for (const comparison of group.comparisons) {
      expect(comparison.compared).toBe(0);
      expect(comparison.wins).toBe(0);
      expect(comparison.meanRelativeCostChange).toBeNull();
    }
  });

  it("keeps published tables in sync and includes the non-economic safety baseline", () => {
    const report = JSON.parse(
      readFileSync(
        new URL("../benchmarks/reports/million-simulation-report.json", import.meta.url),
        "utf8",
      ),
    );
    expect(
      readFileSync(new URL("../benchmarks/million-simulation.md", import.meta.url), "utf8"),
    ).toBe(renderMillionSimulation(report));
    for (const group of report.summary)
      for (const comparison of group.comparisons) {
        expect(comparison.wins + comparison.ties + comparison.losses).toBe(comparison.compared);
      }
    expect(
      report.summary[0].comparisons.map((row: { baseline: string }) => row.baseline),
    ).toContain("safety70");
  });
});
