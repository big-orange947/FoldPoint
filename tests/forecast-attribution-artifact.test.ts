import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_SELECTION,
  type forecastAttributionReport,
  renderAttribution,
  summarizeAttribution,
  sumObservedBills,
} from "../benchmarks/forecast-attribution";
import type { buildWarmLengthReport } from "../benchmarks/warm-length-seed";

const raw = readFileSync(
  new URL("../benchmarks/reports/warm-length-seed.json", import.meta.url),
  "utf8",
);
const frozen = JSON.parse(raw) as ReturnType<typeof buildWarmLengthReport>;
const report = JSON.parse(
  readFileSync(new URL("../benchmarks/reports/forecast-attribution.json", import.meta.url), "utf8"),
) as ReturnType<typeof forecastAttributionReport>;
describe("frozen single-intervention attribution artifact", () => {
  it("keeps all declared controls, unavailable interventions and negative outcomes", () => {
    expect(report.selection).toEqual(ATTRIBUTION_SELECTION);
    expect(report.rows).toHaveLength(28);
    expect(report.rows.filter((r) => r.status === "FORKED")).toHaveLength(27);
    expect(report.rows.filter((r) => r.status === "NOT_APPLICABLE")).toHaveLength(1);
    expect(report.rows.some((r) => r.comparison && r.comparison.fullCostChange > 0)).toBe(true);
    expect(report.externalCalls).toBe(0);
    expect(report.paidCalls).toBe(0);
    expect(report.frozenControlSha256).toBe(createHash("sha256").update(raw).digest("hex"));
    for (const r of report.rows) {
      const f = frozen.rows.find(
        (f) =>
          f.profile === r.profile &&
          f.contract === r.contract &&
          f.sourceFixture === r.sourceFixture &&
          f.seed === r.seed &&
          f.steps === r.steps &&
          f.suite === r.suite,
      );
      expect(f).toBeDefined();
      expect(r.wait.cost).toBeCloseTo(f?.paired.cost ?? 0, 10);
      expect(r.wait.compactions).toEqual(f?.paired.compactions);
      expect(r.wait.fingerprint).toBe(f?.paired.fingerprint);
      expect(r.now.fingerprint).toBe(r.wait.fingerprint);
    }
  });
  it("reconciles complete bills, survival-weighted prefixes and explicitly unmodeled tails", () => {
    for (const r of report.rows) {
      for (const arm of [r.wait, r.now]) {
        const t = sumObservedBills(arm.bills);
        for (const k of Object.keys(t) as (keyof typeof t)[])
          expect(arm.totals[k]).toBeCloseTo(t[k], 10);
        expect(arm.cost).toBeCloseTo(
          t.ordinaryInputCost + t.ordinaryOutputCost + t.summaryCost + t.prewarmCost,
          10,
        );
        expect(arm.compactions).toHaveLength(t.summaryCalls);
      }
      const c = r.comparison;
      const checkpoint = r.checkpoint;
      if (!c || !checkpoint) {
        expect(r.wait).toEqual(r.now);
        continue;
      }
      expect(r.wait.bills.slice(0, checkpoint.step)).toEqual(r.now.bills.slice(0, checkpoint.step));
      expect(r.wait.actions[checkpoint.step]).toBe("KEEP");
      expect(r.now.actions[checkpoint.step]).toBe("COMPACT");
      expect(c.fullObservedFork.saving).toBeCloseTo(r.wait.cost - r.now.cost, 10);
      expect(c.fullObservedFork.saving).toBeCloseTo(
        c.unweightedObservedFork.saving + c.beyondForecastFork.saving,
        10,
      );
      expect(c.matchedCalls + c.callsBeyondForecast).toBe(c.remainingOrdinaryCalls);
      for (const arm of [checkpoint.forecastBills.now, checkpoint.forecastBills.wait]) {
        for (const k of ["ordinaryInputCost", "summaryCost", "prewarmCost"] as const)
          expect(arm.steps.reduce((n, s) => n + s.survival * s[k], 0)).toBeCloseTo(arm[k], 10);
      }
      const weights = checkpoint.forecastBills.now.steps
        .slice(0, c.matchedCalls)
        .map((s) => s.survival);
      const a = sumObservedBills(
        r.wait.bills.slice(checkpoint.step, checkpoint.step + c.matchedCalls),
        weights,
      );
      const b = sumObservedBills(
        r.now.bills.slice(checkpoint.step, checkpoint.step + c.matchedCalls),
        weights,
      );
      for (const k of Object.keys(a) as (keyof typeof a)[])
        expect(c.weightedObservedFork[k]).toBeCloseTo(a[k] - b[k], 10);
      expect(c.forecastMinusWeightedObservedSaving).toBeCloseTo(
        c.forecast.saving - c.weightedObservedFork.saving,
        10,
      );
      expect(c.fullObservedFork.ordinaryOutputCost).toBeCloseTo(0, 10);
    }
  });
  it("regenerates summaries and Markdown exactly from stored rows", () => {
    expect(report.summary).toEqual(summarizeAttribution(report.rows));
    expect(
      readFileSync(new URL("../benchmarks/forecast-attribution.md", import.meta.url), "utf8"),
    ).toBe(renderAttribution(report));
  });
});
