import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type forecastPaybackReport, renderForecastPayback } from "../benchmarks/forecast-payback";
import type { pairedStressReport } from "../benchmarks/paired-stress";

const report = JSON.parse(
  readFileSync(new URL("../benchmarks/reports/forecast-payback.json", import.meta.url), "utf8"),
) as ReturnType<typeof forecastPaybackReport>;
const previous = JSON.parse(
  readFileSync(new URL("../benchmarks/reports/paired-stress.json", import.meta.url), "utf8"),
) as ReturnType<typeof pairedStressReport>;

describe("single-cycle qualification negative-result audit", () => {
  it("retains frozen controls and complete paired growth, without external calls", () => {
    expect(report.rows).toHaveLength(96);
    expect(report.nearEnd).toHaveLength(63);
    expect(report.paidCalls).toBe(0);
    expect(report.externalCalls).toBe(0);
    for (const r of report.rows) {
      const old = previous.rows.find(
        (p) => p.profile === r.profile && p.contract === r.contract && p.id === r.id,
      );
      expect(old).toBeDefined();
      for (const key of ["fixed60", "legacy", "paired", "historyCost"] as const)
        expect(r[key]).toEqual(old?.[key]);
      expect(r.gated.fingerprint).toBe(r.fixed60.fingerprint);
      expect(r.gated.cost).toBeCloseTo(
        r.gated.ordinaryCost + r.gated.summaryCost + r.gated.prewarmCost,
        10,
      );
      expect(r.gated.totalRequests).toBe(180 + r.gated.summaryCalls + r.gated.prewarmCalls);
      expect(r.gated.summaryCalls).toBe(r.gated.compactions.length);
      expect(r.gated.summaryCost).toBeCloseTo(
        r.gated.compactions.reduce((s, c) => s + c.summaryCost, 0),
        10,
      );
      expect(r.gated.overflow).toBe(0);
      expect(r.gatedChange).toBe(r.gated.cost / r.fixed60.cost - 1);
      expect(r.gatedVsPaired).toBe(r.gated.cost / r.paired.cost - 1);
    }
  });
  it("keeps regressions and cannot promote fewer economic compactions as savings", () => {
    expect(report.rows.some((r) => r.gatedVsPaired > 1e-9)).toBe(true);
    expect(report.rows.some((r) => r.gatedVsPaired < -1e-9)).toBe(true);
    const sonnet = report.summary.find(
      (s) => s.profile === "claude-sonnet-5.5-5m-price" && s.contract === "summary-uncached",
    );
    expect(sonnet).toBeDefined();
    expect(sonnet?.meanGatedVsPaired).toBeGreaterThan(0.1);
    expect(sonnet?.gatedEconomic).toBeLessThan(sonnet?.pairedEconomic ?? 0);
    expect(report.nearEnd.some((r) => r.gatedVsPaired > 0.06)).toBe(true);
    expect(Math.max(...report.nearEnd.map((r) => r.gatedChange))).toBeGreaterThan(0.14);
  });
  it("recomputes every aggregate and renders the checked-in report exactly", () => {
    for (const s of report.summary) {
      const rows = report.rows.filter((r) => r.profile === s.profile && r.contract === s.contract);
      expect(rows).toHaveLength(4);
      expect(s.meanGatedChange).toBeCloseTo(rows.reduce((n, r) => n + r.gatedChange, 0) / 4, 12);
      expect(s.meanGatedVsPaired).toBeCloseTo(
        rows.reduce((n, r) => n + r.gatedVsPaired, 0) / 4,
        12,
      );
      expect(s.wins).toBe(rows.filter((r) => r.gatedChange < -1e-9).length);
      expect(s.losses).toBe(rows.filter((r) => r.gatedChange > 1e-9).length);
      expect(s.cycleRejections).toBe(rows.reduce((n, r) => n + (r.audit.cycleRejections ?? 0), 0));
    }
    expect(
      readFileSync(new URL("../benchmarks/forecast-payback.md", import.meta.url), "utf8"),
    ).toBe(renderForecastPayback(report));
  });
});
