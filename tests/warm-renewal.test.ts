import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderWarm, warmCases, type warmRenewalReport } from "../benchmarks/warm-renewal";

describe("warm renewal benchmark", () => {
  it("retains near endings, new combinations and cold regressions without endpoint inputs", () => {
    const cases = warmCases();
    expect(cases.filter((s) => s.id.startsWith("heldout-")).length).toBe(12);
    expect(cases.filter((s) => s.id.startsWith("near-end-")).length).toBe(3);
    expect(
      cases.filter((s) => !s.id.startsWith("heldout-") && !s.id.includes("-warm-")).length,
    ).toBe(4);
    for (const s of cases) expect(s.hostHorizon).toBeUndefined();
  });
  it("reconciles reports, fair growth, negative results and dev-only fixed selection", () => {
    const report = JSON.parse(
      readFileSync(new URL("../benchmarks/reports/warm-renewal.json", import.meta.url), "utf8"),
    ) as ReturnType<typeof warmRenewalReport>;
    expect(report.rows).toHaveLength(55 * 8);
    expect(report.paidCalls).toBe(0);
    expect(readFileSync(new URL("../benchmarks/warm-renewal.md", import.meta.url), "utf8")).toBe(
      renderWarm(report),
    );
    for (const r of report.rows) {
      expect(new Set(Object.values(r.arms).map((a) => a.fingerprint)).size).toBe(1);
      for (const d of Object.values(r.diagnostics))
        expect(d.triggered).toBeLessThanOrEqual(d.eligible);
    }
    for (const p of report.profiles) {
      const dev = report.rows.filter((r) => r.profile === p.id && r.suite === "dev-warm");
      const totals = ["fixed50", "fixed60", "fixed70"]
        .map((name) => ({
          name,
          cost: dev.reduce((a, r) => a + (r.arms[name]?.cost ?? Infinity), 0),
        }))
        .sort((a, b) => a.cost - b.cost);
      expect(report.frozenFixed[p.id]).toBe(totals[0]?.name);
    }
    for (const s of report.summary) {
      expect(s.wins + s.losses + s.ties).toBe(s.compared);
      expect(s.compared + s.excluded).toBe(s.cases);
    }
    expect(report.summary.some((s) => s.suite === "dev-warm-long" && (s.mean ?? 0) > 0)).toBe(true);
  });
});
