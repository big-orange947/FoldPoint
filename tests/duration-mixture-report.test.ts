import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DURATION_PRIOR,
  durationCases,
  type durationMixtureReport,
  renderDuration,
} from "../benchmarks/duration-mixture";

describe("duration mixture screen", () => {
  it("keeps seen regressions and freezes eight fresh combinations without endpoint hints", () => {
    const cases = durationCases();
    expect(cases).toHaveLength(63);
    expect(cases.filter((s) => s.id.startsWith("heldout-fresh-")).length).toBe(8);
    for (const s of cases) expect(s.hostHorizon).toBeUndefined();
    expect(DURATION_PRIOR).toEqual([
      { weight: 0.8, continuationProbability: 0.8 },
      { weight: 0.2, continuationProbability: 0.98 },
    ]);
  });
  it("reconciles calibration and costs with all ablations, counterexamples and fair growth", () => {
    const report = JSON.parse(
      readFileSync(new URL("../benchmarks/reports/duration-mixture.json", import.meta.url), "utf8"),
    ) as ReturnType<typeof durationMixtureReport>;
    expect(report.rows).toHaveLength(504);
    expect(report.paidCalls).toBe(0);
    expect(report.prior).toEqual(DURATION_PRIOR);
    expect(
      readFileSync(new URL("../benchmarks/duration-mixture.md", import.meta.url), "utf8"),
    ).toBe(renderDuration(report));
    for (const row of report.rows) {
      expect(row.arms.frozenDuration).toBeDefined();
      expect(row.arms.geometric256).toBeDefined();
      expect(new Set(Object.values(row.arms).map((a) => a.fingerprint)).size).toBe(1);
      for (const d of Object.values(row.diagnostics)) {
        expect(d.forecastSamples).toBe(row.calls);
        expect(d.brierSum ?? -1).toBeGreaterThanOrEqual(0);
      }
    }
    for (const s of report.summary) {
      expect(s.wins + s.losses + s.ties).toBe(s.compared);
      expect(s.compared + s.excluded).toBe(s.cases);
      expect(s.brier ?? -1).toBeGreaterThanOrEqual(0);
      expect(s.brier ?? 2).toBeLessThanOrEqual(1);
    }
    expect(report.summary.some((s) => s.suite === "fresh-warm" && (s.worst ?? 0) > 0.1)).toBe(true);
    expect(
      report.summary.some(
        (s) =>
          s.suite === "dev-warm-long" && s.candidate === "durationMixture" && (s.mean ?? 0) < -0.05,
      ),
    ).toBe(true);
  });
});
