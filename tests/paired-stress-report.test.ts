import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { cycleExecutionReport } from "../benchmarks/cycle-execution";
import { type pairedStressReport, renderPairedStress } from "../benchmarks/paired-stress";

describe("paired policy stress ablation report", () => {
  const report = JSON.parse(
    readFileSync(new URL("../benchmarks/reports/paired-stress.json", import.meta.url), "utf8"),
  ) as ReturnType<typeof pairedStressReport>;
  const control = JSON.parse(
    readFileSync(new URL("../benchmarks/reports/cycle-execution.json", import.meta.url), "utf8"),
  ) as ReturnType<typeof cycleExecutionReport>;
  it("retains original controls, both gain/loss directions and every full ledger", () => {
    expect(report.rows).toHaveLength(96);
    expect(report.summary).toHaveLength(24);
    expect(report.paidCalls).toBe(0);
    expect(report.externalCalls).toBe(0);
    expect(report.rows.some((r) => r.pairedVsLegacy > 0)).toBe(true);
    expect(report.rows.some((r) => r.pairedVsLegacy < 0)).toBe(true);
    for (const r of report.rows) {
      const old = control.rows.find(
        (c) => c.profile === r.profile && c.id === r.id && c.contract === r.contract,
      );
      expect(old?.dynamic).toEqual(r.legacy);
      expect(old?.fixed60).toEqual(r.fixed60);
      expect(old?.historyCost).toBe(r.historyCost);
      for (const arm of [r.fixed60, r.legacy, r.paired]) {
        expect(arm.cost).toBeCloseTo(arm.ordinaryCost + arm.summaryCost + arm.prewarmCost, 10);
        expect(arm.overflow).toBe(0);
        expect(arm.fingerprint).toBe(r.fixed60.fingerprint);
        expect(arm.totalRequests).toBe(180 + arm.summaryCalls + arm.prewarmCalls);
      }
      expect(r.pairedChange).toBe(r.paired.cost / r.fixed60.cost - 1);
    }
  });
  it("keeps short-task losses and cannot mistake no new loss for no loss", () => {
    expect(report.nearEnd).toHaveLength(63);
    expect(report.nearEnd.some((n) => n.pairedChange > 0.1)).toBe(true);
    expect(report.nearEnd.every((n) => n.pairedCost === n.legacyCost)).toBe(true);
    expect(new Set(report.nearEnd.map((n) => n.steps))).toEqual(new Set([1, 4, 12]));
  });
  it("locks aggregate arithmetic and markdown to the artifact", () => {
    for (const s of report.summary) {
      const rows = report.rows.filter((r) => r.profile === s.profile && r.contract === s.contract);
      expect(rows).toHaveLength(4);
      expect(s.meanPairedChange).toBeCloseTo(
        rows.reduce((sum, r) => sum + r.pairedChange, 0) / 4,
        12,
      );
      expect(s.meanPairedVsLegacy).toBeCloseTo(
        rows.reduce((sum, r) => sum + r.pairedVsLegacy, 0) / 4,
        12,
      );
      expect(s.worstPairedChange).toBe(Math.max(...rows.map((r) => r.pairedChange)));
      expect(s.wins).toBe(rows.filter((r) => r.pairedChange < -1e-9).length);
    }
    expect(readFileSync(new URL("../benchmarks/paired-stress.md", import.meta.url), "utf8")).toBe(
      renderPairedStress(report),
    );
  });
});
