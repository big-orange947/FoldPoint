import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compactorCases } from "../benchmarks/compactor-model";
import type { executionConsistencyReport } from "../benchmarks/execution-consistency";
import { createRawFixedThresholdStrategy } from "../benchmarks/fixed-threshold";
import {
  collectCompactorHistory,
  type historyReuseReport,
  renderHistory,
  runBillLedger,
} from "../benchmarks/history-reuse";
import { createFoldPointStrategy, runSession } from "../benchmarks/simulator";

describe("historical compactor reuse", () => {
  const base = compactorCases()[0];
  if (!base) throw new Error("missing fixture");
  it("collects feedback from separate prior sessions independently of evaluation endpoint", () => {
    const first = collectCompactorHistory(base);
    const second = collectCompactorHistory({
      ...base,
      steps: base.steps + 50,
      seed: base.seed + 7,
      growthPerStep: base.growthPerStep + 3000,
      startTokens: 100000,
    });
    expect(first).toEqual(second);
    expect(first.observations.length).toBeGreaterThanOrEqual(3);
    expect(first.observations.length).toBeLessThanOrEqual(32);
    expect(first.sources.every((id) => id.startsWith("prior-"))).toBe(true);
    expect(first.cost).toBeGreaterThan(0);
    for (const o of first.observations)
      expect(Object.keys(o).sort()).toEqual(
        ["beforeTokens", "afterTokens", "outputTokens", "summaryInputCostPerToken"].sort(),
      );
  });
  it("does not carry cooldown or runtime age from historical successes into a new runtime", () => {
    const history = [100000, 200000, 300000].map((beforeTokens) => ({
      beforeTokens,
      afterTokens: 10000,
      outputTokens: 2000,
      summaryInputCostPerToken: 2e-6,
    }));
    const scenario = { ...base, steps: 1, startTokens: 100000, growthPerStep: 10000 };
    const estimates: { eligible: boolean; expectedCallsIncludingCurrent: number }[] = [];
    runSession(
      scenario,
      createFoldPointStrategy(scenario, {
        learnedCompactorTokens: true,
        compactorHistory: history,
        warmCoreFromHistory: true,
        enforceForecastExecutionGates: true,
        defaults: { minCallsBetweenCompactions: 99 },
        runtimeSurvival: {
          continuationProbability: 0.95,
          maxImmediateLossRatio: 1,
          durationModel: {
            completedCalls: 0,
            components: [
              { weight: 0.8, continuationProbability: 0.8 },
              { weight: 0.2, continuationProbability: 0.98 },
            ],
          },
        },
        onSurvivalEstimate: (e) => estimates.push(e),
      }),
    );
    expect(estimates).toHaveLength(1);
    expect(estimates[0]?.eligible).toBe(true);
    expect(estimates[0]?.expectedCallsIncludingCurrent).toBeCloseTo(14);
    expect(history[0]?.afterTokens).toBe(10000);
    expect(() => createFoldPointStrategy(base, { compactorHistory: history })).toThrow();
  });
  it("reconciles ordinary calls and summary costs without making compression free", () => {
    const result = runBillLedger({ ...base, steps: 40 }, createRawFixedThresholdStrategy(0.6));
    expect(result.run.metrics.compactionAttemptCount).toBeGreaterThan(0);
    expect(result.bills.reduce((a, b) => a + b, 0)).toBeCloseTo(
      result.run.metrics.totalSimulatedCost,
      10,
    );
  });
  it("keeps cold bills, phase sums, growth, training fees and fixed60 comparisons auditable", () => {
    const report = JSON.parse(
      readFileSync(new URL("../benchmarks/reports/history-reuse.json", import.meta.url), "utf8"),
    ) as ReturnType<typeof historyReuseReport>;
    const old = JSON.parse(
      readFileSync(
        new URL("../benchmarks/reports/execution-consistency.json", import.meta.url),
        "utf8",
      ),
    ) as ReturnType<typeof executionConsistencyReport>;
    expect(report.rows).toHaveLength(192);
    for (const r of report.rows) {
      const previous = old.rows.find((p) => p.profile === r.profile && p.id === r.id);
      expect(r.arms.cold?.cost).toBeCloseTo(previous?.arms.feasible?.cost ?? NaN, 10);
      expect(r.arms.fixed60?.cost).toBeCloseTo(previous?.arms.fixed60?.cost ?? NaN, 10);
      expect(new Set(Object.values(r.arms).map((a) => a.fingerprint)).size).toBe(1);
      for (const a of Object.values(r.arms)) {
        expect(a.earlyBill + a.laterBill).toBeCloseTo(a.cost, 10);
        expect(a.overflow).toBe(0);
      }
      expect(report.histories.some((h) => h.id === r.historyId)).toBe(true);
    }
    for (const s of report.summary) {
      expect(s.earlyContribution + s.laterContribution).toBeCloseTo(s.mean, 10);
      expect(s.baseline).toBe("fixed60");
      expect(s.wins + s.losses + s.ties).toBe(8);
    }
    expect(report.histories.every((h) => h.cost > 0 && h.observations.length <= 32)).toBe(true);
    expect(readFileSync(new URL("../benchmarks/history-reuse.md", import.meta.url), "utf8")).toBe(
      renderHistory(report),
    );
    expect(report.paidCalls).toBe(0);
  });
});
