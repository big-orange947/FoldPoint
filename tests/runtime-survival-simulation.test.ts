import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildRuntimeSurvivalScenarios,
  renderRuntimeSurvival,
  runtimeSurvivalReport,
} from "../benchmarks/runtime-survival";
import { createFoldPointStrategy, runSession } from "../benchmarks/simulator";

describe("runtime survival zero-paid screen", () => {
  it("retains all matrix and near-ending cases without supplying endpoints", () => {
    const cases = buildRuntimeSurvivalScenarios();
    expect(cases).toHaveLength(351);
    expect(cases.filter((s) => s.id.startsWith("near-end-")).length).toBe(27);
    for (const scenario of cases) {
      expect(scenario.hostHorizon).toBeUndefined();
      expect(scenario.contextWindowTokens).toBe(1_000_000);
      if (scenario.id.startsWith("near-end-") && scenario.idleMsAfterStep)
        expect(scenario.idleMsAfterStep.fromStep).toBe(Math.floor(scenario.steps / 2));
    }
  });
  it("keeps risk charging out of repeated decisions and records failed dispatch fees", () => {
    const base = buildRuntimeSurvivalScenarios()[0];
    if (!base) throw new Error("Missing scenario");
    const scenario = {
      ...base,
      pricing: { inputPerMillion: 1, outputPerMillion: 1 },
      startTokens: 300_000,
      growthPerStep: 1_000,
      growthJitter: 0,
      steps: 8,
      compactor: { ...base.compactor, successRate: 0 },
    };
    const reports: Array<{ spent: number; overBudget: boolean }> = [];
    const strategy = createFoldPointStrategy(scenario, {
      runtimeSurvival: { continuationProbability: 0.95, maxImmediateLossRatio: 1 },
      runtimeRiskBudgetRatio: 1,
      onRuntimeRisk: (report) => {
        reports.push(report);
      },
    });
    const request = {
      step: 0,
      timestamp: 1,
      idleMs: 0,
      contextTokens: 300_000,
      cachedTokens: 0,
      utilization: 0.3,
    };
    expect(strategy.decide(request).action).toBe("COMPACT");
    expect(strategy.decide(request).action).toBe("COMPACT");
    expect(reports).toHaveLength(0);
    strategy.onCompaction?.({
      step: 0,
      timestamp: 1,
      beforeTokens: 300_000,
      afterTokens: 300_000,
      outputTokens: 10,
      action: "COMPACT",
      cost: 2,
      breakEvenCalls: null,
      success: false,
    });
    expect(reports[0]).toMatchObject({ spent: 2, overBudget: true });
    expect(strategy.decide(request).action).toBe("KEEP");
    let lastReport: { spent: number; overBudget: boolean } | undefined;
    const run = runSession(
      scenario,
      createFoldPointStrategy(scenario, {
        runtimeSurvival: { continuationProbability: 0.95, maxImmediateLossRatio: 1 },
        runtimeRiskBudgetRatio: 1,
        onRuntimeRisk: (report) => {
          lastReport = report;
        },
      }),
    );
    expect(run.metrics.failedCompactionCount).toBe(1);
    expect(lastReport?.overBudget).toBe(true);
    let forcedSpent = -1;
    const forced = createFoldPointStrategy(scenario, {
      runtimeSurvival: { continuationProbability: 0.95, maxImmediateLossRatio: 1 },
      runtimeRiskBudgetRatio: 0,
      onRuntimeRisk: (report) => {
        forcedSpent = report.spent;
      },
    });
    expect(forced.decide({ ...request, contextTokens: 750_000, utilization: 0.75 }).action).toBe(
      "FORCE",
    );
    forced.onCompaction?.({
      step: 0,
      timestamp: 1,
      beforeTokens: 750_000,
      afterTokens: 75_000,
      outputTokens: 10,
      action: "FORCE",
      cost: 2,
      breakEvenCalls: null,
      success: true,
    });
    forced.onSessionEnd?.(2);
    expect(forcedSpent).toBe(0);
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
    expect(report.kind).toBe("foldpoint.runtime-survival-experiment.v2");
    expect(
      report.rows.some(
        (row: {
          arms: Record<
            string,
            {
              preDecisionReplayCalibration?: {
                worstOverestimateRatio: number;
              };
            }
          >;
        }) =>
          (row.arms["q95-loss1"]?.preDecisionReplayCalibration?.worstOverestimateRatio ?? 0) > 20,
      ),
    ).toBe(true);
    for (const summary of report.summary) {
      expect(summary.compared + summary.noCompactionCases).toBe(summary.scenarios);
      if (summary.compared > 0)
        expect(summary.worstRelativeChange).toBeGreaterThanOrEqual(summary.meanRelativeChange);
      else {
        expect(summary.worstRelativeChange).toBeNull();
        expect(summary.meanRelativeChange).toBeNull();
      }
      expect(summary.attempts).toBeGreaterThanOrEqual(summary.economic);
      expect(summary.runtimeRiskOverspends).toBe(0);
    }
  });
});
