import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildRuntimeSurvivalScenarios,
  renderRuntimeSurvival,
  runtimeSurvivalReport,
} from "../benchmarks/runtime-survival";

describe("runtime survival zero-paid screen", () => {
  it("retains all matrix and near-ending cases without supplying endpoints", () => {
    const cases = buildRuntimeSurvivalScenarios();
    expect(cases).toHaveLength(351);
    expect(cases.filter((s) => s.id.startsWith("near-end-")).length).toBe(27);
    for (const scenario of cases) {
      expect(scenario.hostHorizon).toBeUndefined();
      expect(scenario.contextWindowTokens).toBe(1_000_000);
    }
  });
  it("reproduces independent branches with identical offered growth", () => {
    const cases = buildRuntimeSurvivalScenarios().filter((s) => s.id.startsWith("near-end-"));
    const report = runtimeSurvivalReport(cases);
    expect(runtimeSurvivalReport(cases)).toEqual(report);
    expect(report.paidCalls).toBe(0);
    for (const row of report.rows) {
      const arms = Object.values(row.arms);
      expect(new Set(arms.map((a) => a.growthFingerprint)).size).toBe(1);
      expect(new Set(arms.map((a) => a.offeredGrowth)).size).toBe(1);
      for (const arm of arms) expect(Number.isFinite(arm.cost)).toBe(true);
      // q99 is excluded by the tail guard, NOT silently presented as a tuned winner.
      expect(row.arms["q99-loss1"]?.cost).toBe(row.arms.current?.cost);
    }
    expect(report.summary.some((s) => s.losses > 0)).toBe(true);
  });
  it("keeps generated report/table aligned and exposes churn and worst loss", () => {
    const report = JSON.parse(
      readFileSync(
        new URL("../benchmarks/reports/runtime-survival-report.json", import.meta.url),
        "utf8",
      ),
    );
    expect(
      readFileSync(new URL("../benchmarks/runtime-survival.md", import.meta.url), "utf8"),
    ).toBe(renderRuntimeSurvival(report));
    expect(report.rows).toHaveLength(351);
    for (const summary of report.summary) {
      expect(summary.compared + summary.noCompactionCases).toBe(summary.scenarios);
      expect(summary.worstRelativeChange).toBeGreaterThanOrEqual(summary.meanRelativeChange);
      expect(summary.attempts).toBeGreaterThanOrEqual(summary.economic);
    }
  });
});
