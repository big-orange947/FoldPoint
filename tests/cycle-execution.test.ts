import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compactorCases } from "../benchmarks/compactor-model";
import {
  cycleExecutionCase,
  type cycleExecutionReport,
  renderCycleExecution,
} from "../benchmarks/cycle-execution";

describe("complete warm-cycle execution audit", () => {
  const report = JSON.parse(
    readFileSync(new URL("../benchmarks/reports/cycle-execution.json", import.meta.url), "utf8"),
  ) as ReturnType<typeof cycleExecutionReport>;
  it("retains all cases, prices and contracts, including losses", () => {
    expect(report.rows).toHaveLength(96);
    expect(report.summary).toHaveLength(24);
    expect(report.paidCalls).toBe(0);
    expect(report.externalCalls).toBe(0);
    expect(report.rows.some((r) => r.change > 0)).toBe(true);
    expect(report.rows.some((r) => r.change < 0)).toBe(true);
    for (const s of report.summary) {
      const rows = report.rows.filter((r) => r.profile === s.profile && r.contract === s.contract);
      expect(rows).toHaveLength(4);
      expect(s.meanChange).toBeCloseTo(rows.reduce((sum, r) => sum + r.change, 0) / 4, 12);
      expect(s.wins).toBe(rows.filter((r) => r.change < -1e-9).length);
      expect(s.losses).toBe(rows.filter((r) => r.change > 1e-9).length);
    }
    expect(readFileSync(new URL("../benchmarks/cycle-execution.md", import.meta.url), "utf8")).toBe(
      renderCycleExecution(report),
    );
  });
  it("reconciles full bills, independent extra requests and identical growth", () => {
    for (const r of report.rows) {
      expect(r.dynamic.fingerprint).toBe(r.fixed60.fingerprint);
      for (const arm of [r.dynamic, r.fixed60]) {
        expect(arm.cost).toBeCloseTo(arm.ordinaryCost + arm.summaryCost + arm.prewarmCost, 10);
        expect(arm.overflow).toBe(0);
        expect(arm.totalRequests).toBe(180 + arm.summaryCalls + arm.prewarmCalls);
        expect(arm.summaryCalls).toBe(arm.compactions.length);
        expect(arm.summaryCost).toBeCloseTo(
          arm.compactions.reduce((s, c) => s + c.summaryCost, 0),
          10,
        );
        expect(arm.prewarmCalls).toBe(
          r.billing.prewarmOutputTokens === undefined
            ? 0
            : arm.compactions.filter((c) => c.success).length,
        );
      }
      expect(r.audit.decisions).toBe(180);
      expect(r.historyCost).toBeGreaterThan(0);
      expect(r.change).toBe(r.dynamic.cost / r.fixed60.cost - 1);
    }
  });
  it("keeps continuous-wait witnesses without declaring future boundaries mandatory", () => {
    const flash = report.rows.filter(
      (r) => r.profile === "deepseek-flash-peak" && r.contract === "summary-uncached",
    );
    expect(Math.max(...flash.map((r) => r.audit.longest?.calls ?? 0))).toBe(26);
    for (const r of flash) {
      expect(r.audit.endingRiskBlocked).toBe(0);
      expect(r.audit.stressOrMarginBlocked).toBe(r.audit.aboveModeledRepeatAndKeep);
      const witness = r.audit.longest;
      if (witness) {
        expect(witness.end.step - witness.start.step + 1).toBe(witness.calls);
        expect(witness.start.action).toBe("KEEP");
        expect(witness.start.context).toBeGreaterThanOrEqual(
          witness.start.repeatBoundary ?? Infinity,
        );
      }
    }
  });
  it("reruns a shorter prefix without revealing future endpoint to decisions", () => {
    const base = compactorCases().find((s) => s.id.startsWith("heldout-floor-180-"));
    if (!base) throw new Error("missing fixture");
    const s = {
      ...base,
      steps: 8,
      cycleBilling: { summarySharedPrefixRatio: 0.8, prewarmOutputTokens: 1 },
    };
    const first = cycleExecutionCase(s);
    const second = cycleExecutionCase({ ...s, steps: 12 });
    expect(first.historyCost).toBe(second.historyCost);
    expect(first.historySamples).toBe(second.historySamples);
    expect(first.audit.checkpoints[0]).toEqual(second.audit.checkpoints[0]);
    expect(first.dynamic.cost).toBeGreaterThan(0);
  });
});
