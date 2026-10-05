import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  auditWarmPrefixes,
  type buildWarmLengthReport,
  renderWarmLengths,
  summarizeWarmLengths,
  WARM_LENGTH_MANIFEST,
  warmStreamStability,
} from "../benchmarks/warm-length-seed";

const report = JSON.parse(
  readFileSync(new URL("../benchmarks/reports/warm-length-seed.json", import.meta.url), "utf8"),
) as ReturnType<typeof buildWarmLengthReport>;

describe("expanded warm-task complete-bill artifact", () => {
  it("retains the frozen matrix and every selected baseline component hash", () => {
    expect(report.manifest).toEqual(WARM_LENGTH_MANIFEST);
    expect(report.rows).toHaveLength(294);
    expect(report.rows.filter((r) => r.suite === "main")).toHaveLength(252);
    expect(report.rows.filter((r) => r.suite === "billing-sensitivity")).toHaveLength(42);
    expect(report.externalCalls).toBe(0);
    expect(report.paidCalls).toBe(0);
    expect(Object.keys(report.sourceHashes)).toHaveLength(14);
    for (const digest of Object.values(report.sourceHashes))
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
    const keys = report.rows.map(
      (r) => `${r.suite}/${r.profile}/${r.contract}/${r.seed}/${r.sourceFixture}/${r.steps}`,
    );
    expect(new Set(keys).size).toBe(294);
    for (const p of report.manifest.profiles) {
      const group = report.rows.filter((r) => r.suite === "main" && r.profile === p);
      expect(group).toHaveLength(36);
      for (const seed of report.manifest.seeds)
        expect(group.filter((r) => r.seed === seed)).toHaveLength(12);
    }
  });
  it("charges all ordinary, summary and prewarm requests without omitting losses", () => {
    for (const r of report.rows) {
      expect(r.pairedAudit.decisions).toBe(r.steps);
      expect(r.commonAudit.decisions).toBe(r.steps);
      expect(r.historyCost).toBeGreaterThan(0);
      for (const arm of [r.fixed60, r.paired, r.common]) {
        expect(arm.fingerprint).toBe(r.fixed60.fingerprint);
        expect(arm.ordinaryCalls).toBe(r.steps);
        expect(arm.overflow).toBe(0);
        expect(arm.cost).toBeCloseTo(arm.ordinaryCost + arm.summaryCost + arm.prewarmCost, 10);
        expect(arm.totalRequests).toBe(r.steps + arm.summaryCalls + arm.prewarmCalls);
        expect(arm.summaryCalls).toBe(arm.compactions.length);
        expect(arm.summaryCost).toBeCloseTo(
          arm.compactions.reduce((n, c) => n + c.summaryCost, 0),
          10,
        );
        expect(arm.prewarmCalls).toBe(
          r.contract === "hypothetical-shared-80-prewarm-1"
            ? arm.compactions.filter((c) => c.success).length
            : 0,
        );
      }
      expect(r.pairedChange).toBe(r.paired.cost / r.fixed60.cost - 1);
      expect(r.commonChange).toBe(r.common.cost / r.fixed60.cost - 1);
    }
    expect(report.rows.some((r) => r.pairedChange > 1e-9)).toBe(true);
    expect(report.rows.some((r) => r.pairedChange < -1e-9)).toBe(true);
  });
  it("recomputes all interval evidence and reconciles its billing components", () => {
    expect(report.prefixAudits).toHaveLength(588);
    expect(report.prefixAudits).toEqual(auditWarmPrefixes(report.rows));
    for (const a of report.prefixAudits) {
      expect(a.sameGrowth && a.sameCompactions && a.sameCheckpoints).toBe(true);
      expect(a.incrementalCost).toBeGreaterThan(0);
      expect(a.incrementalSummaryCalls).toBeGreaterThanOrEqual(0);
      expect(a.incrementalCost).toBeCloseTo(
        a.incrementalOrdinaryCost + a.incrementalSummaryCost + a.incrementalPrewarmCost,
        10,
      );
      expect(a.tailCallsSinceLastCompaction).toBeGreaterThanOrEqual(0);
    }
  });
  it("renders exact aggregate numbers and does not relabel data as quality or blind results", () => {
    expect(report.summary).toEqual(summarizeWarmLengths(report.rows));
    for (const s of report.summary)
      expect(s.meanCostDelta).toBeCloseTo(
        s.meanOrdinaryCostDelta + s.meanSummaryCostDelta + s.meanPrewarmCostDelta,
        10,
      );
    expect(report.stability).toEqual(warmStreamStability(report.rows));
    expect(report.stability.streams).toHaveLength(168);
    expect(report.stability.summary).toHaveLength(14);
    expect(
      readFileSync(new URL("../benchmarks/warm-length-seed.md", import.meta.url), "utf8"),
    ).toBe(renderWarmLengths(report));
    expect(report.limitations.some((l) => l.includes("已见"))).toBe(true);
    expect(report.limitations.some((l) => l.includes("尚未分解预测误差"))).toBe(true);
  });
});
