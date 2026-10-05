import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compactorCases,
  type compactorModelReport,
  renderCompactor,
} from "../benchmarks/compactor-model";
import { createFoldPointStrategy, runSession } from "../benchmarks/simulator";
import { ExperimentalCompactorLearner, estimateRuntimeSurvival, FoldPoint } from "../src/index";

describe("fixed-term rollout and frozen 60% comparison", () => {
  it("bills learned summary output and first replay in immediate loss", () => {
    const input = {
      sessionId: "fit",
      timestamp: 1,
      contextTokens: 500000,
      reusablePrefixTokens: 480000,
      profile: {
        model: "fit",
        compactorId: "fit",
        contextWindowTokens: 1000000,
        pricing: {
          inputPerMillion: 2,
          outputPerMillion: 10,
          cacheReadPerMillion: 0.2,
          cacheWritePerMillion: 2.5,
        },
      },
    };
    const baseline = new FoldPoint().decide(input);
    const l = new ExperimentalCompactorLearner();
    for (const beforeTokens of [100000, 200000, 300000])
      l.observe({
        beforeTokens,
        afterTokens: 50000,
        outputTokens: 2000,
        summaryInputCostPerToken: 2e-6,
      });
    const result = estimateRuntimeSurvival(input, baseline, {
      continuationProbability: 0.95,
      maxImmediateLossRatio: 1,
      compactorTokenModel: l.snapshot(),
    });
    expect(result.immediateLoss).toBeCloseTo(
      Math.max(
        0,
        500000 * 2e-6 +
          2000 * 10e-6 +
          50000 * 2.5e-6 -
          baseline.metrics.estimatedCurrentCallReplayCost,
      ),
    );
  });
  it("future task endpoint cannot change observed-prefix decisions", () => {
    const base = compactorCases()[0];
    if (!base) throw new Error("missing fixture");
    const simulate = (steps: number) => {
      const estimates: unknown[] = [];
      const scenario = { ...base, steps };
      const strategy = createFoldPointStrategy(scenario, {
        learnedCompactorTokens: true,
        omitRequestCacheEvidence: true,
        verifiedAppendOnlyPrefix: true,
        runtimeSurvival: {
          continuationProbability: 0.95,
          maxImmediateLossRatio: 1,
          rolloutMode: "renewal",
          savingMarginBasis: "timing",
        },
        onSurvivalEstimate: (e) => estimates.push(e),
      });
      runSession(scenario, strategy);
      return estimates;
    };
    expect(simulate(25)).toEqual(simulate(50).slice(0, 25));
  });
  it("keeps all new cases and uses only fixed60 as the primary comparator", () => {
    const report = JSON.parse(
      readFileSync(new URL("../benchmarks/reports/compactor-model.json", import.meta.url), "utf8"),
    ) as ReturnType<typeof compactorModelReport>;
    expect(compactorCases()).toHaveLength(24);
    expect(report.rows).toHaveLength(192);
    expect(report.comparator).toBe("fixed60");
    expect(report.paidCalls).toBe(0);
    for (const row of report.rows) {
      expect(new Set(Object.values(row.arms).map((a) => a.fingerprint)).size).toBe(1);
      expect(Object.values(row.arms).every((a) => a.overflow === 0)).toBe(true);
    }
    for (const s of report.summary) {
      expect(s.baseline).toBe("fixed60");
      expect(s.wins + s.losses + s.ties).toBe(8);
    }
    expect(readFileSync(new URL("../benchmarks/compactor-model.md", import.meta.url), "utf8")).toBe(
      renderCompactor(report),
    );
  });
});
