import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  frequencyReport,
  renderFrequency,
  summarizeFrequency,
} from "../benchmarks/compaction-frequency";
import { createRawFixedThresholdStrategy } from "../benchmarks/fixed-threshold";
import { buildRuntimeSurvivalScenarios } from "../benchmarks/runtime-survival";
import { runSession } from "../benchmarks/simulator";

it("attributes a hand-priced summary and its ordinary replay once, without inventing write premiums", () => {
  const base = buildRuntimeSurvivalScenarios()[0];
  if (!base) throw new Error("Missing fixture");
  const scenario = {
    ...base,
    steps: 2,
    startTokens: 500_000,
    growthPerStep: 0,
    growthJitter: 0,
    outputTokens: 1_000,
    pricing: {
      inputPerMillion: 1,
      outputPerMillion: 2,
      cacheReadPerMillion: 1,
      cacheWritePerMillion: 10,
    },
    compactor: { retentionRatio: 0.1, outputRatio: 0.01, successRate: 1 },
  };
  const run = runSession(scenario, createRawFixedThresholdStrategy(0.4));
  const summary = summarizeFrequency(scenario, run);
  expect(summary.summaryCost).toBeCloseTo(0.51, 12);
  expect(summary.firstPostCompactInputCost).toBeCloseTo(0.05, 12);
  expect(summary.otherOrdinaryInputCost).toBeCloseTo(0.05, 12);
  expect(summary.ordinaryOutputCost).toBeCloseTo(0.004, 12);
  expect(summary.totalCost).toBeCloseTo(0.614, 12);
  expect(summary.successes).toBe(1);
  expect(summary.callsAfterFinalCompaction).toBe(2);
  expect(summary.minimumGap).toBeNull();
  const premium = {
    ...scenario,
    pricing: {
      inputPerMillion: 1,
      outputPerMillion: 2,
      cacheReadPerMillion: 0.1,
      cacheWritePerMillion: 1.25,
    },
  };
  const charged = summarizeFrequency(
    premium,
    runSession(premium, createRawFixedThresholdStrategy(0.4)),
  );
  expect(charged.firstPostCompactInputCost).toBeCloseTo(0.0625, 12);
  expect(charged.otherOrdinaryInputCost).toBeCloseTo(0.005, 12);
  expect(charged.totalCost).toBeCloseTo(0.5815, 12);
  expect(() =>
    summarizeFrequency(scenario, { ...run, metrics: { ...run.metrics, overflowRecoveryCount: 1 } }),
  ).toThrow(/Recovery costs/);
});

it("keeps all cases, reconciles bills and reproduces existing strategies rather than changing policy", () => {
  const report = frequencyReport();
  const previous = JSON.parse(
    readFileSync("benchmarks/reports/runtime-survival-report.json", "utf8"),
  );
  expect(report.rows).toHaveLength(351);
  expect(report.rows.filter((row) => row.suite === "near-end")).toHaveLength(27);
  expect(report.policyChanged).toBe(false);
  expect(report.taskQualityMeasured).toBe(false);
  for (const row of report.rows) {
    const original = previous.rows.find((candidate: { id: string }) => candidate.id === row.id);
    expect(original).toBeDefined();
    for (const [arm, value] of Object.entries(row.arms)) {
      expect(
        value.summaryCost +
          value.firstPostCompactInputCost +
          value.otherOrdinaryInputCost +
          value.ordinaryOutputCost,
      ).toBeCloseTo(value.totalCost, 9);
      const oldArm = arm === "cumulativeRisk1" ? "q95-loss1" : arm;
      expect(value.totalCost).toBeCloseTo(original.arms[oldArm].cost, 9);
      expect(value.successfulSteps).toEqual(original.arms[oldArm].compactionSteps);
      expect(value.growthFingerprint).toBe(row.arms.fixed60.growthFingerprint);
      expect(value.offeredGrowth).toBe(row.arms.fixed60.offeredGrowth);
    }
  }
  for (const summary of report.summary) {
    expect(summary.compared + summary.excludedNoCompaction).toBe(summary.scenarios);
    expect(summary.wins + summary.losses).toBeLessThanOrEqual(summary.compared);
  }
});

it("keeps the generated report and markdown synchronized", () => {
  const saved = JSON.parse(readFileSync("benchmarks/reports/compaction-frequency.json", "utf8"));
  expect(saved).toEqual(frequencyReport());
  expect(readFileSync("benchmarks/compaction-frequency.md", "utf8")).toBe(renderFrequency(saved));
});
