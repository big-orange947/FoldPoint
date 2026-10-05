import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type commonContinuationReport,
  renderCommonContinuation,
} from "../benchmarks/common-continuation";
import type { pairedStressReport } from "../benchmarks/paired-stress";

const report = JSON.parse(
  readFileSync(new URL("../benchmarks/reports/common-continuation.json", import.meta.url), "utf8"),
) as ReturnType<typeof commonContinuationReport>;
const previous = JSON.parse(
  readFileSync(new URL("../benchmarks/reports/paired-stress.json", import.meta.url), "utf8"),
) as ReturnType<typeof pairedStressReport>;

describe("common continuation complete-bill audit", () => {
  it("retains every frozen control and complete ordinary/summary/prewarm ledger", () => {
    expect(report.rows).toHaveLength(96);
    expect(report.nearEnd).toHaveLength(63);
    expect(report.externalCalls).toBe(0);
    expect(report.paidCalls).toBe(0);
    for (const r of report.rows) {
      const old = previous.rows.find(
        (p) => p.profile === r.profile && p.contract === r.contract && p.id === r.id,
      );
      expect(old).toBeDefined();
      for (const key of ["fixed60", "paired", "legacy", "historyCost"] as const)
        expect(r[key]).toEqual(old?.[key]);
      expect(r.common.fingerprint).toBe(r.fixed60.fingerprint);
      expect(r.common.cost).toBeCloseTo(
        r.common.ordinaryCost + r.common.summaryCost + r.common.prewarmCost,
        10,
      );
      expect(r.common.totalRequests).toBe(180 + r.common.summaryCalls + r.common.prewarmCalls);
      expect(r.common.summaryCalls).toBe(r.common.compactions.length);
      expect(r.common.summaryCost).toBeCloseTo(
        r.common.compactions.reduce((n, c) => n + c.summaryCost, 0),
        10,
      );
      expect(r.common.overflow).toBe(0);
      expect(r.change).toBe(r.common.cost / r.fixed60.cost - 1);
      expect(r.commonVsPaired).toBe(r.common.cost / r.paired.cost - 1);
      for (const checkpoint of r.audit.checkpoints) {
        expect(checkpoint.commonContinuation).toBeDefined();
        expect(checkpoint.commonContinuation?.repeatBoundaryTokens).toBe(checkpoint.repeatBoundary);
        expect(checkpoint.cyclePayback).toBeUndefined();
      }
    }
  });
  it("keeps both wins and losses versus fixed 60% and recomputes summary arithmetic", () => {
    expect(report.rows.some((r) => r.change > 1e-9)).toBe(true);
    expect(report.rows.some((r) => r.change < -1e-9)).toBe(true);
    for (const s of report.summary) {
      const rows = report.rows.filter((r) => r.profile === s.profile && r.contract === s.contract);
      expect(rows).toHaveLength(4);
      expect(s.meanChange).toBeCloseTo(rows.reduce((n, r) => n + r.change, 0) / 4, 12);
      expect(s.meanVsPaired).toBeCloseTo(rows.reduce((n, r) => n + r.commonVsPaired, 0) / 4, 12);
      expect(s.wins).toBe(rows.filter((r) => r.change < -1e-9).length);
      expect(s.losses).toBe(rows.filter((r) => r.change > 1e-9).length);
      expect(s.economic).toBe(rows.reduce((n, r) => n + r.common.economic, 0));
      expect(s.forced).toBe(rows.reduce((n, r) => n + r.common.forced, 0));
    }
  });
  it("keeps short controls and produces the checked-in markdown without manual numbers", () => {
    for (const r of report.nearEnd) {
      const old = previous.nearEnd.find(
        (p) => p.profile === r.profile && p.contract === r.contract && p.steps === r.steps,
      );
      expect(old).toBeDefined();
      expect(r.fixed60Cost).toBe(old?.fixed60Cost);
      expect(r.pairedCost).toBe(old?.pairedCost);
      expect(r.commonVsPaired).toBe(r.commonCost / r.pairedCost - 1);
      expect(r.change).toBe(r.commonCost / r.fixed60Cost - 1);
    }
    expect(
      readFileSync(new URL("../benchmarks/common-continuation.md", import.meta.url), "utf8"),
    ).toBe(renderCommonContinuation(report));
  });
});
